"""Network info: per-interface IPv4 + mDNS self-resolve probe.

Reachability proof for an operator who can see the screen but doesn't have
SSH access yet — "what IP do I browse to?" plus "is alarm-alpaca.local
actually being announced?".

The mDNS probe runs `avahi-resolve` which can be slow (~1-2s when avahi
is loaded); we cache the resolved result for 30s so the dashboard poll
isn't constantly hammering it.
"""

import asyncio
import socket
import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth import auth_dep

router = APIRouter(prefix="/api/network", tags=["network"])


class Interface(BaseModel):
    device: str  # e.g. "eth0", "wlan0"
    type: str  # "ethernet" | "wifi" | "loopback" | ...
    state: str  # nmcli STATE column
    ip: str | None  # primary IPv4, no CIDR
    gateway: str | None


class MdnsProbe(BaseModel):
    hostname: str  # "<hostname>.local"
    resolved_ip: str | None
    ok: bool
    detail: str | None  # error string when ok=false


class NetworkInfo(BaseModel):
    interfaces: list[Interface]
    mdns: MdnsProbe
    internet_reachable: bool


async def _run(*args: str, timeout: float = 4.0) -> tuple[int, str, str]:
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


def _nm_split(line: str) -> list[str]:
    out: list[str] = []
    buf = ""
    i = 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            buf += line[i + 1]
            i += 2
            continue
        if c == ":":
            out.append(buf)
            buf = ""
            i += 1
            continue
        buf += c
        i += 1
    out.append(buf)
    return out


async def _interfaces() -> list[Interface]:
    rc, out, _ = await _run(
        "nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"
    )
    if rc != 0:
        return []

    rows: list[Interface] = []
    targets: list[tuple[str, str, str]] = []
    for line in out.splitlines():
        parts = _nm_split(line)
        if len(parts) < 3:
            continue
        dev, typ, state = parts[0], parts[1], parts[2]
        # Loopback is noise — operator never browses to 127.0.0.1 from elsewhere.
        if typ == "loopback":
            continue
        # Hide internal / virtual / unmanaged devices the operator can't
        # act on:
        #   - p2p-dev-wlan0: wpa_supplicant's WiFi-Direct shadow device
        #   - podman0/podman1/cni-podman*: container bridges from rootless
        #     and rootful podman; no human-routable IP
        #   - veth*: container veth pairs
        #   - docker0/br-*: legacy / unused if podman is the runtime
        if (
            dev.startswith("p2p-")
            or dev.startswith("podman")
            or dev.startswith("cni-")
            or dev.startswith("veth")
            or dev.startswith("docker")
            or dev.startswith("br-")
        ):
            continue
        targets.append((dev, typ, state))

    async def _detail(dev: str, typ: str, state: str) -> Interface:
        ip: str | None = None
        gw: str | None = None
        if state == "connected":
            rc2, out2, _ = await _run(
                "nmcli",
                "-t",
                "-f",
                "IP4.ADDRESS,IP4.GATEWAY",
                "device",
                "show",
                dev,
            )
            if rc2 == 0:
                for line in out2.splitlines():
                    # IP4.ADDRESS[1]:192.168.1.42/24
                    if line.startswith("IP4.ADDRESS"):
                        _, _, val = line.partition(":")
                        val = val.strip()
                        if val and not ip:
                            ip = val.split("/")[0] or None
                    elif line.startswith("IP4.GATEWAY"):
                        _, _, val = line.partition(":")
                        val = val.strip()
                        if val:
                            gw = val or None
        return Interface(device=dev, type=typ, state=state, ip=ip, gateway=gw)

    rows = list(await asyncio.gather(*[_detail(*t) for t in targets]))
    # Ethernet first, then wifi, then everything else; within a group keep
    # connected ones on top.
    type_order = {"ethernet": 0, "wifi": 1}
    rows.sort(
        key=lambda r: (
            type_order.get(r.type, 2),
            0 if r.state == "connected" else 1,
            r.device,
        )
    )
    return rows


_MDNS_CACHE: tuple[float, MdnsProbe] | None = None
_MDNS_TTL_S = 30.0


async def _mdns_probe() -> MdnsProbe:
    global _MDNS_CACHE
    now = time.monotonic()
    if _MDNS_CACHE and (now - _MDNS_CACHE[0]) < _MDNS_TTL_S:
        return _MDNS_CACHE[1]

    hostname = f"{socket.gethostname()}.local"
    rc, out, err = await _run("avahi-resolve", "-4", "-n", hostname, timeout=3.0)
    probe: MdnsProbe
    if rc == 0:
        # Output format: "<hostname>\t<ip>"
        parts = out.strip().split()
        ip = parts[-1] if len(parts) >= 2 else None
        if ip:
            probe = MdnsProbe(hostname=hostname, resolved_ip=ip, ok=True, detail=None)
        else:
            probe = MdnsProbe(
                hostname=hostname,
                resolved_ip=None,
                ok=False,
                detail="empty avahi-resolve output",
            )
    else:
        probe = MdnsProbe(
            hostname=hostname,
            resolved_ip=None,
            ok=False,
            detail=(err or out).strip() or f"avahi-resolve rc={rc}",
        )

    _MDNS_CACHE = (now, probe)
    return probe


async def _internet_reachable() -> bool:
    """TCP connect to 8.8.8.8:53 — tests IP-layer internet without DNS."""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection("8.8.8.8", 53), timeout=3.0
        )
        writer.close()
        await writer.wait_closed()
        return True
    except (OSError, asyncio.TimeoutError):
        return False


@router.get("/info", response_model=NetworkInfo, dependencies=[Depends(auth_dep)])
async def get_info() -> NetworkInfo:
    interfaces, mdns, reachable = await asyncio.gather(
        _interfaces(), _mdns_probe(), _internet_reachable()
    )
    return NetworkInfo(
        interfaces=interfaces, mdns=mdns, internet_reachable=reachable
    )
