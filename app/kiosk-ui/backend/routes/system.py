"""System routes: live machine info (info) + power controls (poweroff,
reboot).

Power endpoints reply 202 immediately, then a detached subprocess invokes
`sudo systemctl poweroff/reboot` after a short delay so the HTTP response
actually makes it to the client before systemd kills the kiosk-ui unit.
Every power request is logged so SSH audits can correlate with watchdog
history.
"""

import asyncio
import logging
import os
import platform
import shlex
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from auth import auth_dep

router = APIRouter(prefix="/api/system", tags=["system"])

log = logging.getLogger("kiosk-ui.system")

# Delay between the API returning and the subprocess actually running
# systemctl. 500ms is plenty for FastAPI to flush the response.
_GRACE_S = 0.5


def _peer(request: Request) -> str:
    return request.client.host if request.client else "?"


async def _detach(*cmd: str) -> None:
    """Spawn a fully-detached child that runs after _GRACE_S, then returns.

    We use a tiny shell wrapper to sleep + exec so the parent FastAPI worker
    isn't killed mid-response. The child inherits no fds we care about; stdin
    and the std streams point at /dev/null so systemd doesn't keep the unit
    alive on their behalf.

    `cmd` is shell-quoted via shlex.join so this helper stays safe if a
    future caller ever interpolates request data — today's callers are
    fixed-literal (poweroff / reboot), but the previous bare ' '.join was a
    landmine waiting for the first dynamic argv.
    """
    devnull = os.open(os.devnull, os.O_RDWR)
    try:
        # The sleep is before sudo so we don't burn the grace period queuing
        # in PAM. `setsid` detaches the new process group, so when our unit
        # gets SIGTERM during shutdown the systemctl call survives.
        quoted_cmd = shlex.join(cmd)
        await asyncio.create_subprocess_exec(
            "/bin/sh",
            "-c",
            f"sleep {_GRACE_S}; setsid {quoted_cmd} </dev/null >/dev/null 2>&1 &",
            stdin=devnull,
            stdout=devnull,
            stderr=devnull,
            start_new_session=True,
        )
    finally:
        os.close(devnull)


class DiskUsage(BaseModel):
    mountpoint: str
    total_bytes: int
    used_bytes: int
    free_bytes: int


class HeartbeatStatus(BaseModel):
    # Last successful Discord heartbeat tick. Written by the alarm-bridge
    # process to ALARM_BRIDGE_HEARTBEAT_FILE on every successful edit_message
    # call (see app/scripts/discord_notifier.py). Absence of the file =
    # never seen.
    last_seen_unix: int | None
    interval_seconds: int | None
    age_seconds: int | None
    # ok = age < 3 * interval. The "3x" tolerance comes from the spec — a
    # single missed cycle could be webhook rate-limit or transient network
    # blip; three in a row means we're not actually reaching Discord.
    ok: bool


class SystemInfo(BaseModel):
    hostname: str
    kernel: str
    nixos: str | None
    uptime_seconds: int
    load_1: float
    load_5: float
    load_15: float
    mem_total_kb: int
    mem_available_kb: int
    mem_used_kb: int
    cpu_temp_c: float | None
    throttled_hex: str | None
    throttled_flags: list[str]
    disks: list[DiskUsage]
    discord_heartbeat: HeartbeatStatus


def _read_uptime() -> int:
    try:
        return int(float(Path("/proc/uptime").read_text().split()[0]))
    except (OSError, ValueError, IndexError):
        return 0


def _read_loadavg() -> tuple[float, float, float]:
    try:
        parts = Path("/proc/loadavg").read_text().split()
        return (float(parts[0]), float(parts[1]), float(parts[2]))
    except (OSError, ValueError, IndexError):
        return (0.0, 0.0, 0.0)


def _read_meminfo() -> tuple[int, int]:
    """Return (MemTotal_kB, MemAvailable_kB). Falls back to 0/0 on failure."""
    total = avail = 0
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, _, rest = line.partition(":")
            if key == "MemTotal":
                total = int(rest.strip().split()[0])
            elif key == "MemAvailable":
                avail = int(rest.strip().split()[0])
            if total and avail:
                break
    except OSError:
        pass
    return total, avail


def _read_cpu_temp_c() -> float | None:
    # /sys/class/thermal/thermal_zone0/temp on the RPi5 reports the SoC temp
    # in millidegrees C. vcgencmd is the canonical Pi tool but reaching it
    # requires running through the firmware mailbox — the thermal_zone path
    # is identical data without an extra subprocess hop.
    try:
        raw = Path("/sys/class/thermal/thermal_zone0/temp").read_text().strip()
        return int(raw) / 1000.0
    except (OSError, ValueError):
        return None


# Bit positions in `vcgencmd get_throttled`. Bits 0-3 = currently active,
# 16-19 = "happened since boot" sticky flags. We surface only the currently-
# active ones in `flags` plus the raw hex so a triage user can decode the
# full 32-bit value if they care. See
# https://www.raspberrypi.com/documentation/computers/os.html#vcgencmd
_THROTTLE_BITS_NOW = {
    0: "under-voltage",
    1: "freq capped",
    2: "throttled",
    3: "soft temp limit",
}


def _read_throttled() -> tuple[str | None, list[str]]:
    # vcgencmd is the only authoritative source for throttle flags. If it's
    # missing (e.g. running off-Pi for dev), return (None, []) — the UI
    # treats absence as "info not available", not "ok".
    vcgen = shutil.which("vcgencmd")
    if not vcgen:
        return None, []
    try:
        proc = os.popen(f"{vcgen} get_throttled 2>/dev/null")
        out = proc.read().strip()
        proc.close()
    except OSError:
        return None, []
    # Format: "throttled=0x0" or "throttled=0x50000". Parse defensively.
    _, _, hex_str = out.partition("=")
    hex_str = hex_str.strip()
    if not hex_str.startswith("0x"):
        return None, []
    try:
        value = int(hex_str, 16)
    except ValueError:
        return hex_str, []
    flags = [name for bit, name in _THROTTLE_BITS_NOW.items() if value & (1 << bit)]
    return hex_str, flags


def _read_disks() -> list[DiskUsage]:
    # / is the NixOS root; /boot/firmware is the FAT partition holding the
    # bootloader and config.txt (its size is the small one to watch — the
    # vendor bootloader can balloon if too many old generations stay).
    out: list[DiskUsage] = []
    for mp in ("/", "/boot/firmware"):
        try:
            usage = shutil.disk_usage(mp)
        except (OSError, FileNotFoundError):
            continue
        out.append(
            DiskUsage(
                mountpoint=mp,
                total_bytes=usage.total,
                used_bytes=usage.used,
                free_bytes=usage.free,
            )
        )
    return out


def _read_heartbeat() -> HeartbeatStatus:
    # Marker file format (written by app/scripts/discord_notifier.py):
    #   line 1 — unix epoch of last successful tick
    #   line 2 — heartbeat interval in seconds
    # Missing file = bridge never wrote one (fresh boot, or alarm-bridge
    # never came up).
    path = Path(
        os.environ.get(
            "ALARM_BRIDGE_HEARTBEAT_FILE",
            "/run/alarm-bridge/discord-heartbeat-last",
        )
    )
    try:
        parts = path.read_text().strip().splitlines()
        ts = int(parts[0])
        interval = int(parts[1]) if len(parts) > 1 else 900
    except (OSError, ValueError, IndexError):
        return HeartbeatStatus(
            last_seen_unix=None,
            interval_seconds=None,
            age_seconds=None,
            ok=False,
        )
    age = max(0, int(time.time()) - ts)
    return HeartbeatStatus(
        last_seen_unix=ts,
        interval_seconds=interval,
        age_seconds=age,
        # 3× interval tolerance (per spec) — one missed cycle is webhook
        # rate-limit noise, three is "not actually connected".
        ok=age < 3 * interval,
    )


def _read_nixos_version() -> str | None:
    # NixOS ships /etc/os-release with VERSION + BUILD_ID lines; we surface
    # the short VERSION (e.g. "25.05.20250823.abcdef0") so the kiosk shows
    # something meaningful without a full uname dump.
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            if line.startswith("VERSION="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return None


@router.get("/info", response_model=SystemInfo, dependencies=[Depends(auth_dep)])
def get_system_info() -> SystemInfo:
    # Synchronous + cheap: every value comes from /proc or /etc, no
    # subprocess hops. Polling rate at the UI side is governed by the
    # frontend; we don't add caching here on purpose so a reload shows a
    # fresh snapshot.
    uname = platform.uname()
    mem_total, mem_avail = _read_meminfo()
    l1, l5, l15 = _read_loadavg()
    throttled_hex, throttled_flags = _read_throttled()
    return SystemInfo(
        hostname=uname.node,
        kernel=f"{uname.system} {uname.release}",
        nixos=_read_nixos_version(),
        uptime_seconds=_read_uptime(),
        load_1=l1,
        load_5=l5,
        load_15=l15,
        mem_total_kb=mem_total,
        mem_available_kb=mem_avail,
        mem_used_kb=max(0, mem_total - mem_avail),
        cpu_temp_c=_read_cpu_temp_c(),
        throttled_hex=throttled_hex,
        throttled_flags=throttled_flags,
        disks=_read_disks(),
        discord_heartbeat=_read_heartbeat(),
    )


class VacuumResult(BaseModel):
    status: str
    stdout: str
    stderr: str
    returncode: int


@router.post("/vacuum-journal", response_model=VacuumResult, dependencies=[Depends(auth_dep)])
async def vacuum_journal(request: Request) -> VacuumResult:
    # `journalctl --rotate` seals the active journal file; `--vacuum-time=1s`
    # then deletes every archived file older than one second — effectively
    # everything we just rotated. This is system-wide (no per-unit knob in
    # journalctl) so the operator-facing button is on the Machine page and
    # never per-service. Operators use it to clear annoying stale warnings.
    log.warning("journal vacuum requested by %s", _peer(request))
    proc = await asyncio.create_subprocess_exec(
        "sudo",
        "-n",
        "journalctl",
        "--rotate",
        "--vacuum-time=1s",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=20.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return VacuumResult(status="timeout", stdout="", stderr="timeout", returncode=-1)
    rc = proc.returncode or 0
    return VacuumResult(
        status="ok" if rc == 0 else "error",
        stdout=out.decode(errors="replace"),
        stderr=err.decode(errors="replace"),
        returncode=rc,
    )


@router.post("/poweroff", status_code=202, dependencies=[Depends(auth_dep)])
async def poweroff(request: Request) -> dict[str, str]:
    log.warning("poweroff requested by %s", _peer(request))
    await _detach("sudo", "systemctl", "poweroff")
    return {"status": "scheduled", "action": "poweroff"}


@router.post("/reboot", status_code=202, dependencies=[Depends(auth_dep)])
async def reboot(request: Request) -> dict[str, str]:
    log.warning("reboot requested by %s", _peer(request))
    await _detach("sudo", "systemctl", "reboot")
    return {"status": "scheduled", "action": "reboot"}
