"""Dashboard routes: service status, system info, recent button events, actions."""

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import auth_dep

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

WATCHED_UNITS = [
    "alarm-bridge.service",
    "kiosk-ui.service",
    "podman-mosquitto.service",
    "podman-zigbee2mqtt.service",
]


async def _run(*args: str, timeout: float = 3.0) -> tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr)."""
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


class ServiceStatus(BaseModel):
    name: str
    active: str  # "active", "inactive", "failed", "unknown"


class SystemInfo(BaseModel):
    uptime_secs: int
    temp_celsius: float | None
    disk_percent: int


class ButtonEvent(BaseModel):
    timestamp: str
    message: str
    priority: int


class DashboardResponse(BaseModel):
    services: list[ServiceStatus]
    system: SystemInfo
    recent_events: list[ButtonEvent]


@router.get("", response_model=DashboardResponse, dependencies=[Depends(auth_dep)])
async def get_dashboard() -> DashboardResponse:
    # Collect service statuses in parallel
    async def _unit_status(unit: str) -> ServiceStatus:
        rc, out, _ = await _run("systemctl", "is-active", unit)
        state = out.strip() or ("active" if rc == 0 else "inactive")
        return ServiceStatus(name=unit, active=state)

    services = await asyncio.gather(*[_unit_status(u) for u in WATCHED_UNITS])

    # System info
    uptime_secs = 0
    try:
        raw = Path("/proc/uptime").read_text().split()[0]
        uptime_secs = int(float(raw))
    except Exception:
        pass

    temp: float | None = None
    try:
        raw_t = Path("/sys/class/thermal/thermal_zone0/temp").read_text().strip()
        temp = int(raw_t) / 1000.0
    except Exception:
        pass

    disk_percent = 0
    rc, out, _ = await _run("df", "-P", "/")
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 5:
            disk_percent = int(parts[4].rstrip("%"))
            break

    # Recent button events from alarm-bridge journal
    events: list[ButtonEvent] = []
    rc, out, _ = await _run(
        "journalctl",
        "-u",
        "alarm-bridge.service",
        "--output=json",
        "-n",
        "50",
        "--no-pager",
        timeout=5.0,
    )
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = entry.get("MESSAGE", "")
        if not isinstance(msg, str):
            continue
        lower = msg.lower()
        if "button" in lower or "callout" in lower:
            ts = entry.get("__REALTIME_TIMESTAMP", "")
            try:
                from datetime import datetime, timezone

                dt = datetime.fromtimestamp(int(ts) / 1_000_000, tz=timezone.utc)
                ts_str = dt.strftime("%Y-%m-%d %H:%M:%S UTC")
            except Exception:
                ts_str = ts
            events.append(
                ButtonEvent(
                    timestamp=ts_str,
                    message=msg,
                    priority=int(entry.get("PRIORITY", 6)),
                )
            )

    return DashboardResponse(
        services=list(services),
        system=SystemInfo(
            uptime_secs=uptime_secs,
            temp_celsius=temp,
            disk_percent=disk_percent,
        ),
        recent_events=events[-20:],
    )


class RestartRequest(BaseModel):
    unit: str


@router.post("/restart", dependencies=[Depends(auth_dep)])
async def restart_service(req: RestartRequest) -> dict[str, str]:
    if req.unit not in WATCHED_UNITS:
        raise HTTPException(
            status_code=400, detail=f"Unit not in allowlist: {req.unit}"
        )
    rc, _, err = await _run("sudo", "systemctl", "restart", req.unit, timeout=10.0)
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"restart failed: {err.strip()}")
    return {"status": "ok", "unit": req.unit}
