"""Logs page routes: journalctl output for watched units."""

import asyncio
import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import auth_dep

# Render journal timestamps in the device's wall-clock zone (the room is in
# Taiwan). journalctl --output=json gives UTC microseconds; we convert here
# rather than relying on the user's browser locale because the kiosk web UI
# is read by humans across remote-LAN clients in different time zones, and
# they all expect "device-local time" when triaging events on this device.
_TZ = ZoneInfo("Asia/Taipei")

router = APIRouter(prefix="/api/logs", tags=["logs"])

ALLOWED_UNITS = [
    "alarm-bridge.service",
    "kiosk-ui.service",
    "podman-mosquitto.service",
    "podman-zigbee2mqtt.service",
    # Read-only target for the kiosk "network" service-detail page; we do
    # NOT add this to services.py MANAGED_UNITS so the UI can't restart/stop
    # NetworkManager and brick its own connectivity.
    "NetworkManager.service",
]


async def _run(*args: str, timeout: float = 6.0) -> tuple[int, str, str]:
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


class LogEntry(BaseModel):
    timestamp: str
    message: str
    priority: int  # syslog priority 0-7 (0=emerg, 3=err, 4=warn, 6=info, 7=debug)
    unit: str


class LogsResponse(BaseModel):
    unit: str
    entries: list[LogEntry]


@router.get("", response_model=LogsResponse, dependencies=[Depends(auth_dep)])
async def get_logs(
    unit: str = Query(default="alarm-bridge.service"),
    n: int = Query(default=200, ge=1, le=1000),
) -> LogsResponse:
    if unit not in ALLOWED_UNITS:
        raise HTTPException(status_code=400, detail="unit not in allowlist")

    rc, out, err = await _run(
        "journalctl",
        "-u",
        unit,
        "--output=json",
        f"-n{n}",
        "--no-pager",
        timeout=8.0,
    )
    if rc == -1:
        raise HTTPException(status_code=504, detail="journalctl timed out")

    entries: list[LogEntry] = []
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
            # Sometimes MESSAGE is a list of ints (binary data)
            try:
                msg = bytes(msg).decode(errors="replace")
            except Exception:
                msg = str(msg)

        ts = entry.get("__REALTIME_TIMESTAMP", "")
        try:
            dt = datetime.fromtimestamp(
                int(ts) / 1_000_000, tz=timezone.utc
            ).astimezone(_TZ)
            ts_str = dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            ts_str = ts

        priority = 6
        try:
            priority = int(entry.get("PRIORITY", 6))
        except Exception:
            pass

        entries.append(
            LogEntry(
                timestamp=ts_str,
                message=msg,
                priority=priority,
                unit=unit,
            )
        )

    return LogsResponse(unit=unit, entries=entries)
