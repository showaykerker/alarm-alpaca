"""WiFi + ethernet routes: scan, current connection, connect, disconnect.

We expose ethernet alongside WiFi because the kiosk is allowed to run on
either: someone may plug in a cable instead of (or in addition to) WiFi,
and the UI needs to tell the user which path is currently carrying traffic.
"""

import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import auth_dep

router = APIRouter(prefix="/api/wifi", tags=["wifi"])


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


class WifiNetwork(BaseModel):
    ssid: str
    signal: int  # 0-100
    security: str  # "--" or type string
    in_use: bool
    # True when a saved NM connection profile exists for this SSID — i.e. the
    # box will auto-reconnect on next boot unless explicitly forgotten.
    saved: bool


class EthernetStatus(BaseModel):
    # device may be None when the box has no ethernet NIC at all (rare on Pi5
    # but defensively typed) — present=False distinguishes that from "device
    # exists but cable unplugged" (present=True, connected=False).
    present: bool
    device: str | None
    connected: bool
    ip: str | None


class WifiStatus(BaseModel):
    connected: bool
    ssid: str | None
    signal: int | None
    device: str | None
    networks: list[WifiNetwork]
    ethernet: EthernetStatus


def _nm_split(line: str) -> list[str]:
    # nmcli -t escapes ':' inside fields as '\:' — split on unescaped colon
    # and un-escape afterwards.
    return [p.replace("\\:", ":") for p in re.split(r"(?<!\\):", line)]


async def _ethernet_status() -> EthernetStatus:
    # `device status` gives one row per managed interface; type=ethernet is
    # what we want. State 'connected' means a cable is up AND NM has a
    # profile activated on it.
    rc, out, _ = await _run(
        "nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"
    )
    device: str | None = None
    connected = False
    if rc == 0:
        for line in out.splitlines():
            parts = _nm_split(line)
            if len(parts) < 3:
                continue
            dev, typ, state = parts[0], parts[1], parts[2]
            if typ != "ethernet":
                continue
            # First ethernet device wins. There is normally only one on a Pi5.
            device = dev
            connected = state == "connected"
            break

    ip: str | None = None
    if device and connected:
        # `device show <dev>` returns key:value lines; IP4.ADDRESS[1] is
        # the primary v4 address with CIDR suffix.
        rc2, out2, _ = await _run(
            "nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", device
        )
        if rc2 == 0:
            for line in out2.splitlines():
                if line.startswith("IP4.ADDRESS"):
                    _, _, val = line.partition(":")
                    ip = val.strip().split("/")[0] or None
                    if ip:
                        break

    return EthernetStatus(
        present=device is not None, device=device, connected=connected, ip=ip
    )


async def _saved_wifi_profiles() -> dict[str, str]:
    """Map SSID -> NM connection profile name for saved 802-11-wireless
    profiles. A persisted profile is what makes the box auto-reconnect on
    boot; deleting it ("forget") is the only way to stop that.
    """
    rc, out, _ = await _run("nmcli", "-t", "-f", "NAME,TYPE", "connection", "show")
    if rc != 0:
        return {}
    names: list[str] = []
    for line in out.splitlines():
        parts = _nm_split(line)
        if len(parts) < 2 or parts[1] != "802-11-wireless":
            continue
        names.append(parts[0])
    if not names:
        return {}
    # Fan out per-profile SSID lookups concurrently — each is ~50ms.
    async def _ssid_of(name: str) -> tuple[str, str | None]:
        rc2, out2, _ = await _run(
            "nmcli", "-t", "-g", "802-11-wireless.ssid", "connection", "show", name
        )
        if rc2 != 0:
            return name, None
        return name, out2.strip() or None

    results = await asyncio.gather(*(_ssid_of(n) for n in names))
    profiles: dict[str, str] = {}
    for name, ssid in results:
        if ssid:
            profiles[ssid] = name
    return profiles


async def _wifi_device() -> str | None:
    rc, out, _ = await _run("nmcli", "-t", "-f", "DEVICE,TYPE", "device", "status")
    if rc != 0:
        return None
    for line in out.splitlines():
        parts = _nm_split(line)
        if len(parts) >= 2 and parts[1] == "wifi":
            return parts[0]
    return None


@router.get(
    "/ethernet", response_model=EthernetStatus, dependencies=[Depends(auth_dep)]
)
async def get_ethernet() -> EthernetStatus:
    # Split out from /api/wifi so the Internet page can render the cable
    # status without paying for a WiFi scan first. `nmcli device status` is
    # near-instant; `nmcli device wifi list` blocks while the radio scans.
    return await _ethernet_status()


@router.get("", response_model=WifiStatus, dependencies=[Depends(auth_dep)])
async def get_wifi() -> WifiStatus:
    scan_task = _run(
        "nmcli",
        "-t",
        "-f",
        "IN-USE,SSID,SIGNAL,SECURITY",
        "device",
        "wifi",
        "list",
    )
    (rc, out, _), saved = await asyncio.gather(scan_task, _saved_wifi_profiles())
    networks: list[WifiNetwork] = []
    current_ssid: str | None = None
    current_signal: int | None = None

    for line in out.splitlines():
        parts = _nm_split(line)
        if len(parts) < 4:
            continue
        in_use_raw, ssid, signal_raw, security_raw = (
            parts[0],
            parts[1].strip(),
            parts[2],
            parts[3],
        )
        if not ssid:
            continue
        try:
            signal = int(signal_raw.strip())
        except ValueError:
            signal = 0
        in_use = in_use_raw.strip() == "*"
        security = security_raw.strip()

        if in_use:
            current_ssid = ssid
            current_signal = signal

        networks.append(
            WifiNetwork(
                ssid=ssid,
                signal=signal,
                security=security,
                in_use=in_use,
                saved=ssid in saved,
            )
        )

    networks.sort(key=lambda n: (not n.in_use, -n.signal))

    wifi_device, ethernet = await asyncio.gather(_wifi_device(), _ethernet_status())

    return WifiStatus(
        connected=current_ssid is not None,
        ssid=current_ssid,
        signal=current_signal,
        device=wifi_device,
        networks=networks,
        ethernet=ethernet,
    )


class ConnectRequest(BaseModel):
    ssid: str
    password: str | None = None  # None for open networks


@router.post("/connect", dependencies=[Depends(auth_dep)])
async def connect_wifi(req: ConnectRequest) -> dict[str, str]:
    # PSK is intentionally not logged; never put it in error messages.
    if not req.ssid or len(req.ssid) > 32:
        raise HTTPException(status_code=400, detail="invalid SSID")

    # For secured networks, pass the PSK on stdin via `nmcli --ask` so the
    # plaintext password never appears in /proc/<pid>/cmdline. With the
    # `password <psk>` form, any local-shell user (e.g. the SSH-attached
    # `nixos` account) could capture the secret via `ps wwwax` or
    # `cat /proc/<pid>/cmdline` during the few seconds the call takes.
    if req.password:
        cmd = ["nmcli", "--ask", "device", "wifi", "connect", req.ssid]
        stdin_input: bytes | None = (req.password + "\n").encode()
    else:
        cmd = ["nmcli", "device", "wifi", "connect", req.ssid]
        stdin_input = None

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE if stdin_input is not None else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=stdin_input), timeout=30.0
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        raise HTTPException(status_code=504, detail="connect timed out")

    if proc.returncode != 0:
        out = stdout.decode(errors="replace")
        err = stderr.decode(errors="replace")
        safe_err = err.strip() or out.strip()
        if req.password:
            safe_err = safe_err.replace(req.password, "***")
        raise HTTPException(status_code=500, detail=safe_err or "connect failed")

    return {"status": "connected", "ssid": req.ssid}


class ForgetRequest(BaseModel):
    ssid: str


@router.post("/forget", dependencies=[Depends(auth_dep)])
async def forget_wifi(req: ForgetRequest) -> dict[str, str]:
    # Deletes the saved NM connection profile for this SSID, which stops the
    # box from auto-reconnecting on boot. If the profile is currently active,
    # nmcli also disconnects it as part of the delete.
    if not req.ssid or len(req.ssid) > 32:
        raise HTTPException(status_code=400, detail="invalid SSID")
    profiles = await _saved_wifi_profiles()
    name = profiles.get(req.ssid)
    if not name:
        raise HTTPException(status_code=404, detail="no saved profile for SSID")
    rc, _out, err = await _run(
        "nmcli", "connection", "delete", "id", name, timeout=15.0
    )
    if rc != 0:
        raise HTTPException(status_code=500, detail=err.strip() or "forget failed")
    return {"status": "forgotten", "ssid": req.ssid}


@router.post("/disconnect", dependencies=[Depends(auth_dep)])
async def disconnect_wifi() -> dict[str, str]:
    # Disconnects whichever WiFi device NM is managing. Leaves the saved
    # profile in place so the user can re-connect by tapping the same SSID
    # again. Does NOT touch ethernet — the box stays reachable via cable.
    dev = await _wifi_device()
    if not dev:
        raise HTTPException(status_code=404, detail="no wifi device found")
    rc, _out, err = await _run("nmcli", "device", "disconnect", dev, timeout=15.0)
    if rc != 0:
        raise HTTPException(status_code=500, detail=err.strip() or "disconnect failed")
    return {"status": "disconnected", "device": dev}
