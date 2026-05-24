"""Engineering diagnostic endpoints — hidden behind the 20-tap easter egg.

All endpoints require auth (loopback-exempt via auth_dep). The engineering
page is not linked from the normal UI; it's accessed by tapping 20 times on
the empty cell in the Machine page.
"""

import asyncio
import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import auth_dep

router = APIRouter(prefix="/api/eng", tags=["engineering"], dependencies=[Depends(auth_dep)])


async def _run(*args: str, timeout: float = 10.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return (-1, "", "timeout")
    return (
        proc.returncode or 0,
        stdout.decode(errors="replace"),
        stderr.decode(errors="replace"),
    )


async def _mqtt_retained(topic: str, wait: int = 10) -> str | None:
    rc, out, _ = await _run(
        "sudo", "-n", "/run/current-system/sw/bin/podman", "exec", "mosquitto",
        "mosquitto_sub", "-h", "localhost", "-t", topic, "-C", "1", "-W", str(wait),
        timeout=float(wait + 5),
    )
    return out.strip() if rc == 0 and out.strip() else None


# ---------------------------------------------------------------------------
# Zigbee
# ---------------------------------------------------------------------------

class ZigbeeDevice(BaseModel):
    friendly_name: str
    ieee_address: str
    type: str
    model: str | None = None
    battery: int | None = None
    link_quality: int | None = None
    last_seen: str | None = None


class ZigbeeBridgeInfo(BaseModel):
    version: str | None = None
    coordinator_type: str | None = None
    channel: int | None = None
    pan_id: str | None = None
    permit_join: bool | None = None
    state: str | None = None


@router.get("/zigbee/devices")
async def zigbee_devices() -> list[ZigbeeDevice]:
    raw = await _mqtt_retained("zigbee2mqtt/bridge/devices")
    if not raw:
        return []
    try:
        devices = json.loads(raw)
    except json.JSONDecodeError:
        return []
    result: list[ZigbeeDevice] = []
    for d in devices:
        if d.get("type") == "Coordinator":
            continue
        result.append(ZigbeeDevice(
            friendly_name=d.get("friendly_name", "?"),
            ieee_address=d.get("ieee_address", "?"),
            type=d.get("type", "?"),
            model=d.get("definition", {}).get("model") if d.get("definition") else None,
            battery=None,
            link_quality=None,
            last_seen=d.get("last_seen"),
        ))
    # Fetch per-device state (battery, linkquality) from individual topics
    if result:
        tasks = [
            _mqtt_retained(f"zigbee2mqtt/{dev.friendly_name}", wait=3)
            for dev in result
        ]
        states = await asyncio.gather(*tasks)
        for dev, state_raw in zip(result, states):
            if not state_raw:
                continue
            try:
                state = json.loads(state_raw)
                dev.battery = state.get("battery")
                dev.link_quality = state.get("linkquality")
            except json.JSONDecodeError:
                pass
    return result


@router.get("/zigbee/bridge")
async def zigbee_bridge() -> ZigbeeBridgeInfo:
    info_raw, state_raw = await asyncio.gather(
        _mqtt_retained("zigbee2mqtt/bridge/info", wait=5),
        _mqtt_retained("zigbee2mqtt/bridge/state", wait=5),
    )
    info: dict = {}
    if info_raw:
        try:
            info = json.loads(info_raw)
        except json.JSONDecodeError:
            pass

    state_val: str | None = None
    if state_raw:
        try:
            s = json.loads(state_raw)
            state_val = s.get("state", state_raw)
        except json.JSONDecodeError:
            state_val = state_raw

    coord = info.get("coordinator", {})
    return ZigbeeBridgeInfo(
        version=info.get("version"),
        coordinator_type=coord.get("type"),
        channel=info.get("network", {}).get("channel"),
        pan_id=str(info.get("network", {}).get("pan_id")) if info.get("network", {}).get("pan_id") is not None else None,
        permit_join=info.get("permit_join"),
        state=state_val,
    )


# ---------------------------------------------------------------------------
# MQTT live stream (SSE, auto-closes after 60s)
# ---------------------------------------------------------------------------

@router.get("/mqtt/stream")
async def mqtt_stream():
    async def _generate():
        proc = await asyncio.create_subprocess_exec(
            "sudo", "-n", "/run/current-system/sw/bin/podman", "exec", "mosquitto",
            "mosquitto_sub", "-h", "localhost", "-t", "zigbee2mqtt/#", "-v",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        start = time.monotonic()
        try:
            while time.monotonic() - start < 60:
                assert proc.stdout is not None
                try:
                    line = await asyncio.wait_for(
                        proc.stdout.readline(), timeout=1.0
                    )
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
                    continue
                if not line:
                    break
                text = line.decode(errors="replace").strip()
                if not text:
                    continue
                parts = text.split(" ", 1)
                topic = parts[0]
                payload = parts[1] if len(parts) > 1 else ""
                yield f"data: {json.dumps({'type': 'message', 'topic': topic, 'payload': payload})}\n\n"
        finally:
            proc.kill()
            await proc.communicate()
        yield f"data: {json.dumps({'type': 'closed'})}\n\n"

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# alarm-bridge
# ---------------------------------------------------------------------------

class AlarmBridgeStats(BaseModel):
    debounce_filtered_24h: int
    last_callout: str | None = None
    last_discord: str | None = None
    journal_lines: list[str]


@router.get("/alarm-bridge/stats")
async def alarm_bridge_stats(n: int = Query(default=50, le=200)) -> AlarmBridgeStats:
    journal_rc, journal_out, _ = await _run(
        "journalctl", "-u", "alarm-bridge.service",
        "-n", str(n), "--no-pager", "-o", "short-iso",
        timeout=5.0,
    )
    lines = journal_out.strip().splitlines() if journal_rc == 0 else []

    debounce_rc, debounce_out, _ = await _run(
        "journalctl", "-u", "alarm-bridge.service",
        "--since", "24 hours ago", "--no-pager", "-o", "cat",
        "--grep", "debounce",
        timeout=5.0,
    )
    debounce_count = len(debounce_out.strip().splitlines()) if debounce_rc == 0 and debounce_out.strip() else 0

    last_callout: str | None = None
    last_discord: str | None = None
    for line in reversed(lines):
        if last_callout is None and "TAS callout" in line:
            last_callout = line.strip()
        if last_discord is None and "Discord" in line and ("sent" in line or "notification" in line):
            last_discord = line.strip()

    return AlarmBridgeStats(
        debounce_filtered_24h=debounce_count,
        last_callout=last_callout,
        last_discord=last_discord,
        journal_lines=lines,
    )


# ---------------------------------------------------------------------------
# System diagnostics
# ---------------------------------------------------------------------------

class RoutingInfo(BaseModel):
    routes: str
    dns_servers: list[str]


@router.get("/system/network")
async def system_network() -> RoutingInfo:
    route_rc, route_out, route_err = await _run("/run/current-system/sw/bin/ip", "route", timeout=3.0)
    dns_servers: list[str] = []
    try:
        resolv = Path("/etc/resolv.conf").read_text()
        for line in resolv.splitlines():
            m = re.match(r"^\s*nameserver\s+(\S+)", line)
            if m:
                dns_servers.append(m.group(1))
    except OSError:
        pass
    return RoutingInfo(
        routes=route_out.strip() if route_rc == 0 else f"rc={route_rc}: {route_err.strip()}",
        dns_servers=dns_servers,
    )


class ContainerStats(BaseModel):
    name: str
    cpu_percent: str
    mem_usage: str
    mem_percent: str
    pids: str


@router.get("/system/containers")
async def system_containers() -> list[ContainerStats]:
    rc, out, err = await _run(
        "sudo", "-n", "/run/current-system/sw/bin/podman", "stats", "--no-stream", "--format", "json",
        timeout=15.0,
    )
    if rc != 0 or not out.strip():
        if err.strip():
            return [ContainerStats(name="error", cpu_percent=f"rc={rc}", mem_usage=err.strip()[:100], mem_percent="", pids="")]
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return [ContainerStats(name="parse-error", cpu_percent="", mem_usage=out[:100], mem_percent="", pids="")]
    return [
        ContainerStats(
            name=c.get("name", "?"),
            cpu_percent=c.get("cpu_percent", "?"),
            mem_usage=c.get("mem_usage", "?"),
            mem_percent=c.get("mem_percent", "?"),
            pids=str(c.get("pids", "?")),
        )
        for c in data
    ]


class SdHealth(BaseModel):
    io_errors_24h: int
    error_lines: list[str]


@router.get("/system/sd-health")
async def system_sd_health() -> SdHealth:
    rc, out, _ = await _run(
        "journalctl", "--since", "24 hours ago",
        "-k", "--no-pager",
        timeout=10.0,
    )
    if rc != 0:
        return SdHealth(io_errors_24h=0, error_lines=[])
    pattern = re.compile(r"i/o error|ext4-fs.*error|remount.*read-only|mmc.*error|buffer i/o error", re.I)
    matches = [line for line in out.splitlines() if pattern.search(line)]
    return SdHealth(io_errors_24h=len(matches), error_lines=matches[-20:])


class ThrottleEvent(BaseModel):
    timestamp: str
    message: str


@router.get("/system/throttle-history")
async def system_throttle_history() -> list[ThrottleEvent]:
    rc, out, _ = await _run(
        "journalctl", "--since", "24 hours ago",
        "-k", "--no-pager", "-o", "short-iso",
        timeout=10.0,
    )
    if rc != 0:
        return []
    events: list[ThrottleEvent] = []
    for line in out.splitlines():
        if any(kw in line.lower() for kw in ["throttl", "under-voltage", "over-temperature"]):
            parts = line.split(" ", 3)
            ts = parts[0] if parts else ""
            msg = parts[-1] if len(parts) > 1 else line
            events.append(ThrottleEvent(timestamp=ts, message=msg.strip()))
    return events[-50:]


# ---------------------------------------------------------------------------
# Deploy status & NixOS generations
# ---------------------------------------------------------------------------

class DeployStatus(BaseModel):
    deploying: bool
    deploy_process: str | None = None
    current_generation: int | None = None
    current_profile: str | None = None
    last_activated_unix: float | None = None


@router.get("/deploy/status")
async def deploy_status() -> DeployStatus:
    pgrep_rc, pgrep_out, _ = await _run(
        "pgrep", "-af", "activate-rs|switch-to-configuration",
        timeout=3.0,
    )
    deploying = pgrep_rc == 0 and bool(pgrep_out.strip())

    profile_path = Path("/nix/var/nix/profiles/system")
    current_profile: str | None = None
    current_gen: int | None = None
    last_activated: float | None = None
    try:
        target = profile_path.resolve()
        current_profile = str(target)
        m = re.search(r"-(\d+)-link$", str(profile_path.parent / profile_path.name))
        if m:
            current_gen = int(m.group(1))
        last_activated = profile_path.lstat().st_mtime
    except OSError:
        pass

    if current_gen is None:
        gen_rc, gen_out, _ = await _run(
            "sudo", "-n", "/run/current-system/sw/bin/nix-env", "--list-generations", "-p", "/nix/var/nix/profiles/system",
            timeout=5.0,
        )
        if gen_rc == 0:
            for line in reversed(gen_out.strip().splitlines()):
                if "(current)" in line:
                    m = re.match(r"\s*(\d+)", line)
                    if m:
                        current_gen = int(m.group(1))
                    break

    return DeployStatus(
        deploying=deploying,
        deploy_process=pgrep_out.strip() if deploying else None,
        current_generation=current_gen,
        current_profile=current_profile,
        last_activated_unix=last_activated,
    )


class Generation(BaseModel):
    id: int
    date: str
    current: bool


@router.get("/deploy/generations")
async def deploy_generations() -> list[Generation]:
    rc, out, _ = await _run(
        "sudo", "-n", "/run/current-system/sw/bin/nix-env", "--list-generations", "-p", "/nix/var/nix/profiles/system",
        timeout=5.0,
    )
    if rc != 0:
        return []
    result: list[Generation] = []
    for line in out.strip().splitlines():
        m = re.match(r"\s*(\d+)\s+(\S+\s+\S+)\s*(.*)", line)
        if m:
            result.append(Generation(
                id=int(m.group(1)),
                date=m.group(2).strip(),
                current="(current)" in m.group(3),
            ))
    return result


class SwitchRequest(BaseModel):
    generation: int


class SwitchResult(BaseModel):
    ok: bool
    stdout: str
    stderr: str


@router.post("/deploy/switch")
async def deploy_switch(req: SwitchRequest) -> SwitchResult:
    sw_rc, sw_out, sw_err = await _run(
        "sudo", "-n", "/run/current-system/sw/bin/nix-env",
        "--switch-generation", str(req.generation),
        "-p", "/nix/var/nix/profiles/system",
        timeout=15.0,
    )
    if sw_rc != 0:
        return SwitchResult(ok=False, stdout=sw_out, stderr=sw_err)

    act_rc, act_out, act_err = await _run(
        "sudo", "-n",
        "/nix/var/nix/profiles/system/bin/switch-to-configuration", "switch",
        timeout=60.0,
    )
    return SwitchResult(
        ok=act_rc == 0,
        stdout=sw_out + act_out,
        stderr=sw_err + act_err,
    )


class CleanupRequest(BaseModel):
    keep: int = 3


class CleanupResult(BaseModel):
    deleted: int
    stdout: str
    gc_stdout: str


@router.post("/deploy/cleanup")
async def deploy_cleanup(req: CleanupRequest) -> CleanupResult:
    if req.keep < 2:
        req.keep = 2

    del_rc, del_out, del_err = await _run(
        "sudo", "-n", "/run/current-system/sw/bin/nix-env", "--delete-generations",
        f"+{req.keep}", "-p", "/nix/var/nix/profiles/system",
        timeout=30.0,
    )

    gc_rc, gc_out, gc_err = await _run(
        "sudo", "-n", "/run/current-system/sw/bin/nix-collect-garbage",
        timeout=120.0,
    )

    before_gens = del_out.strip().splitlines() if del_out.strip() else []
    return CleanupResult(
        deleted=len(before_gens),
        stdout=del_out + (f"\n{del_err}" if del_err else ""),
        gc_stdout=gc_out + (f"\n{gc_err}" if gc_err else ""),
    )
