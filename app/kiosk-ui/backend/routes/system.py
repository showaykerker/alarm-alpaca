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


class VersionInfo(BaseModel):
    # `git_rev` is the short (7-char) NixOS configuration revision recorded
    # at deploy time. A "-dirty" suffix is preserved so the kiosk can flag
    # an unclean working tree without losing the hash prefix.
    git_rev: str | None
    nixos_generation: int | None
    last_activated_unix: int | None
    installed_unix: int | None


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
    version: VersionInfo


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


def _read_version() -> VersionInfo:
    # All four fields degrade independently to None: off-Pi dev hosts won't
    # have /run/current-system or /nix/var/nix/profiles, and a freshly
    # installed Pi might not have `system.configurationRevision` set yet.

    git_rev: str | None = None
    try:
        # /etc/configuration-revision is wired up by the alarm-alpaca flake
        # (kiosk-config module). NixOS upstream does NOT auto-write
        # /run/current-system/configuration-revision from
        # `system.configurationRevision` — only `nixos-version` is dropped
        # into the toplevel store path. So we surface the value via
        # environment.etc instead.
        raw = Path("/etc/configuration-revision").read_text().strip()
        if raw:
            # Strip "-dirty" — intent-to-add secrets files always make
            # the tree dirty, so the suffix is meaningless noise.
            if raw.endswith("-dirty"):
                raw = raw[: -len("-dirty")]
            git_rev = raw[:7]
    except (OSError, ValueError):
        pass

    nixos_generation: int | None = None
    try:
        target = os.readlink("/nix/var/nix/profiles/system")
        # Format: "system-23-link"
        name = target.rsplit("/", 1)[-1]
        if name.startswith("system-") and name.endswith("-link"):
            nixos_generation = int(name[len("system-") : -len("-link")])
    except (OSError, ValueError):
        pass

    last_activated_unix: int | None = None
    try:
        # Use /nix/var/nix/profiles/system (ext4-persistent), not
        # /run/current-system (tmpfs). The /run symlink is recreated by
        # stage-2 init at every boot — on an RTC-less Pi that happens before
        # NTP sync, so its mtime is epoch+seconds and useless as "last
        # deploy". The profiles/system symlink is touched at activation and
        # survives reboots with the real wall-clock time.
        last_activated_unix = int(os.lstat("/nix/var/nix/profiles/system").st_mtime)
    except (OSError, ValueError):
        pass

    # Walk system-N-link in ascending N, return the mtime of the first link
    # with a post-NTP-sync timestamp. The Pi has no RTC, so the very first
    # generation activated on a fresh card (often system-1-link) lands with
    # mtime ~= 0 (epoch + a few seconds before NetworkManager + systemd-timesyncd
    # catch up). Skipping pre-2020 mtimes hops past that noise to the first
    # generation that has a meaningful wall-clock — the closest proxy we
    # have to "this SD card came to life" without baking a marker file.
    _CLOCK_SANE_EPOCH = 1577836800  # 2020-01-01 UTC
    installed_unix: int | None = None
    try:
        gens: list[tuple[int, int]] = []
        with os.scandir("/nix/var/nix/profiles") as it:
            for entry in it:
                name = entry.name
                if not (name.startswith("system-") and name.endswith("-link")):
                    continue
                try:
                    num = int(name[len("system-") : -len("-link")])
                except ValueError:
                    continue
                try:
                    mtime = int(entry.stat(follow_symlinks=False).st_mtime)
                except OSError:
                    continue
                gens.append((num, mtime))
        gens.sort(key=lambda g: g[0])
        for _, mtime in gens:
            if mtime >= _CLOCK_SANE_EPOCH:
                installed_unix = mtime
                break
    except OSError:
        pass

    return VersionInfo(
        git_rev=git_rev,
        nixos_generation=nixos_generation,
        last_activated_unix=last_activated_unix,
        installed_unix=installed_unix,
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
        version=_read_version(),
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
