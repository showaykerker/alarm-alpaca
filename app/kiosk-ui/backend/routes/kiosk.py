"""Kiosk-only endpoints: brightness, aggregated status, user-facing events.

These power the on-device touchscreen UI (frontend-kiosk). Everything here is
deliberately tuned for an end-user holding the panel — Chinese labels, coarse
categories, no English log noise. The admin UI (frontend-web) has its own
routes (dashboard / services / logs / wifi / zigbee) for full detail.
"""

import asyncio
import contextlib
import glob
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth import auth_dep

router = APIRouter(prefix="/api/kiosk", tags=["kiosk"])

_log = logging.getLogger(__name__)

_TZ = ZoneInfo("Asia/Taipei")

# Non-destructive "clear" marker: the kiosk UI's clear-events button writes
# a timestamp here; GET /events filters out everything older. The underlying
# journal is untouched, so admin SSH still sees the full history.
_EVENTS_CLEARED_AT = Path("/var/lib/kiosk-ui/events-last-cleared")


# ---------------------------------------------------------------------------
# Brightness
# ---------------------------------------------------------------------------
# We pick the first /sys/class/backlight/* node at request time rather than
# pinning a name, because the DSI panel's backlight driver name can shift
# across kernels (e.g. `10-0045`, `rpi_backlight`).
def _backlight_path() -> Path | None:
    for d in sorted(glob.glob("/sys/class/backlight/*")):
        if Path(d, "brightness").exists():
            return Path(d)
    return None


class BrightnessStatus(BaseModel):
    present: bool
    value: int = 0  # current 0..max
    max: int = 0
    percent: int = 0  # convenience for the slider


class BrightnessUpdate(BaseModel):
    # Accept either an absolute value or a percent. Percent wins when both are
    # set — the UI sends percent; integrations might send absolute.
    value: int | None = None
    percent: int | None = Field(default=None, ge=0, le=100)


def _read_brightness() -> BrightnessStatus:
    bl = _backlight_path()
    if bl is None:
        return BrightnessStatus(present=False)
    try:
        cur = int((bl / "brightness").read_text().strip())
        mx = int((bl / "max_brightness").read_text().strip())
    except (OSError, ValueError):
        return BrightnessStatus(present=False)
    pct = round(cur / mx * 100) if mx > 0 else 0
    return BrightnessStatus(present=True, value=cur, max=mx, percent=pct)


@router.get(
    "/brightness", response_model=BrightnessStatus, dependencies=[Depends(auth_dep)]
)
def get_brightness() -> BrightnessStatus:
    return _read_brightness()


@router.put(
    "/brightness", response_model=BrightnessStatus, dependencies=[Depends(auth_dep)]
)
def put_brightness(payload: BrightnessUpdate) -> BrightnessStatus:
    bl = _backlight_path()
    if bl is None:
        raise HTTPException(status_code=404, detail="no backlight device")
    try:
        mx = int((bl / "max_brightness").read_text().strip())
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"max_brightness unreadable: {e}")

    if payload.percent is not None:
        target = round(mx * payload.percent / 100)
    elif payload.value is not None:
        target = payload.value
    else:
        raise HTTPException(status_code=400, detail="provide percent or value")

    # Clamp generously — we never want a user-supplied 0 to physically turn
    # the panel off, because then they can't see the slider to turn it back on.
    floor = max(1, mx // 20)  # 5% min
    target = max(floor, min(mx, target))

    try:
        (bl / "brightness").write_text(str(target))
    except PermissionError:
        # Surfaces when the udev rule didn't apply — useful debugging hint.
        raise HTTPException(
            status_code=500, detail="brightness file not writable (udev rule missing?)"
        )
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))

    return _read_brightness()


# ---------------------------------------------------------------------------
# Sleep mode config
# ---------------------------------------------------------------------------
_DISPLAY_SETTINGS_FILE = Path("/var/lib/kiosk-ui/display-settings.json")


class SleepConfig(BaseModel):
    timeout_minutes: int = Field(default=2, ge=0, le=30)
    sleep_brightness_pct: int = Field(default=5, ge=1, le=15)


def _read_sleep_config() -> SleepConfig:
    try:
        data = json.loads(_DISPLAY_SETTINGS_FILE.read_text())
        return SleepConfig(**data.get("sleep", {}))
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return SleepConfig()


def _write_sleep_config(cfg: SleepConfig) -> None:
    try:
        data = json.loads(_DISPLAY_SETTINGS_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    data["sleep"] = cfg.model_dump()
    body = json.dumps(data, ensure_ascii=False, indent=2)
    tmp = _DISPLAY_SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(body)
    tmp.replace(_DISPLAY_SETTINGS_FILE)


@router.get(
    "/sleep-config", response_model=SleepConfig, dependencies=[Depends(auth_dep)]
)
def get_sleep_config() -> SleepConfig:
    return _read_sleep_config()


@router.put(
    "/sleep-config", response_model=SleepConfig, dependencies=[Depends(auth_dep)]
)
def put_sleep_config(payload: SleepConfig) -> SleepConfig:
    _write_sleep_config(payload)
    return _read_sleep_config()


# ---------------------------------------------------------------------------
# Aggregated status: just the few things the operator cares about.
# ---------------------------------------------------------------------------
class ComponentStatus(BaseModel):
    # Stable id used by the kiosk frontend to route into a per-service page.
    # The label is the operator-facing Chinese string and may be reworded; id
    # is what the URL and route map are keyed on.
    id: str
    label: str
    ok: bool
    detail: str | None = None


class KioskStatus(BaseModel):
    components: list[ComponentStatus]
    # Most recent "TAS callout placed" timestamp in epoch microseconds, or
    # None if no alarm dispatched in the last minute. The kiosk frontend
    # uses this to drive the 15-second flashing-red edge glow client-side;
    # a fresh value (later than the previous one) restarts the timer.
    last_alarm_us: int | None = None
    # Most recent "mapped=selftest" timestamp (short-press test button) in
    # epoch microseconds. Drives the 5-second green edge glow client-side
    # so the operator gets visual confirmation that a test press registered
    # without a TAS call going out.
    last_selftest_us: int | None = None
    # SoC temperature in degrees C, or None if the thermal zone is
    # unavailable. The kiosk frontend paints a steady yellow edge glow when
    # this crosses ~50°C; heartbeats refresh the value every ~15s.
    cpu_temp_c: float | None = None


async def _systemd_active(unit: str) -> bool:
    proc = await asyncio.create_subprocess_exec(
        "systemctl",
        "is-active",
        unit,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    return out.strip() == b"active"


async def _last_match_us(pattern: str, window_s: int = 60) -> int | None:
    """Scan the last `window_s` seconds of alarm-bridge logs for `pattern`
    (journalctl -g regex). Returns the most-recent matching journal
    microsecond timestamp, or None. The bounded window keeps the scan cheap
    on every poll."""
    since_epoch = int(time.time()) - window_s
    proc = await asyncio.create_subprocess_exec(
        "journalctl",
        "-u",
        "alarm-bridge.service",
        f"--since=@{since_epoch}",
        "--output=json",
        # -g: only emit entries whose MESSAGE matches this regex.
        "-g",
        pattern,
        "--no-pager",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=3.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return None

    latest: int | None = None
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            ts = int(entry.get("__REALTIME_TIMESTAMP", "0"))
        except (json.JSONDecodeError, ValueError, TypeError):
            continue
        if latest is None or ts > latest:
            latest = ts
    return latest


async def _last_alarm_us() -> int | None:
    return await _last_match_us("TAS callout placed", window_s=60)


async def _last_selftest_us() -> int | None:
    # 30s window is enough for the 5s client-side glow plus the 5s status
    # poll interval — anything older has already been consumed and faded.
    return await _last_match_us("mapped=selftest", window_s=30)


@router.get("/status", response_model=KioskStatus, dependencies=[Depends(auth_dep)])
async def get_status() -> KioskStatus:
    # Three service tiles on the kiosk main page (per project-kiosk-ui-rework
    # spec): alarm-bridge owns the dial-out path, zigbee2mqtt owns the
    # button-press inflow, mosquitto is the broker both ends talk through.
    # Network connectivity moved to the System Info card — it was already
    # available there via /api/network/info and didn't deserve a dedicated
    # tile alongside three actual services.
    bridge, zigbee, mqtt, last_alarm_us, last_selftest_us = await asyncio.gather(
        _systemd_active("alarm-bridge.service"),
        _systemd_active("podman-zigbee2mqtt.service"),
        _systemd_active("podman-mosquitto.service"),
        _last_alarm_us(),
        _last_selftest_us(),
    )
    cpu_temp_c = _read_cpu_temp_c()
    return KioskStatus(
        components=[
            ComponentStatus(
                id="alarm-bridge",
                label="緊急通報",
                ok=bridge,
                detail="運作中" if bridge else "服務未啟動",
            ),
            ComponentStatus(
                id="zigbee",
                label="Zigbee 接收",
                ok=zigbee,
                detail="運作中" if zigbee else "服務未啟動",
            ),
            ComponentStatus(
                id="mqtt",
                label="MQTT 交換",
                ok=mqtt,
                detail="運作中" if mqtt else "服務未啟動",
            ),
        ],
        last_alarm_us=last_alarm_us,
        last_selftest_us=last_selftest_us,
        cpu_temp_c=cpu_temp_c,
    )


# ---------------------------------------------------------------------------
# Event log: curated Chinese-language activity stream pulled from
# alarm-bridge's journal. We translate the canonical log phrases into
# operator-friendly labels rather than ever showing raw English log lines.
# ---------------------------------------------------------------------------
class KioskEvent(BaseModel):
    timestamp: str  # already in Asia/Taipei wall-clock, "YYYY-MM-DD (Ddd) HH:MM:SS"
    category: str  # "alarm" | "selftest" | "battery" | "link" | "service"
    text: str  # Chinese, human-readable


class KioskEvents(BaseModel):
    events: list[KioskEvent]


_EVENT_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    # (regex over journal MESSAGE, category, template). The `{button}` token
    # in a template is replaced with "（friendly_name）" if the regex captured
    # one, or stripped to an empty string otherwise. The trailing
    # `button=<friendly>` segment was added to alarm-bridge's log line in
    # 2026-05; the optional group means older messages still classify.
    (
        re.compile(r"action=[\w_-]+, mapped=call(?:, button=(\S+))?"),
        "alarm",
        "🚨 急救按鈕被按下{button}",
    ),
    (re.compile(r"TAS callout placed"), "alarm", "📞 已撥出緊急電話"),
    (re.compile(r"TAS callout failed"), "alarm", "⚠️ 撥號失敗"),
    (
        re.compile(r"action=[\w_-]+, mapped=selftest(?:, button=(\S+))?"),
        "selftest",
        "🧪 按鈕自我測試{button}",
    ),
    # _check_thresholds logs the friendly_name wrapped in backticks; capture
    # it so the event line says "🔋 button-1 電池剩 20%" instead of generic.
    (re.compile(r"`([\w_-]+)` 電池剩 `(\d+)%`"), "battery", "🔋 {0} 電池剩 {1}%"),
    (re.compile(r"電池剩 `(\d+)%`"), "battery", "🔋 電池剩 {0}%"),
    (re.compile(r"電池電壓"), "battery", "🔋 電池電壓偏低"),
    (re.compile(r"連線品質不佳"), "link", "📶 Zigbee 訊號偏弱"),
]


def _classify(message: str) -> tuple[str, str] | None:
    for pat, cat, tpl in _EVENT_PATTERNS:
        m = pat.search(message)
        if m:
            try:
                if "{button}" in tpl:
                    btn = m.group(1) if m.lastindex else None
                    suffix = f"（{btn}）" if btn else ""
                    return cat, tpl.replace("{button}", suffix)
                return cat, tpl.format(*m.groups())
            except IndexError:
                return cat, tpl
    return None


def _cleared_at_us() -> int:
    """Read the last-cleared timestamp in journal-format microseconds. Returns
    0 if the marker file is missing or unreadable (i.e. nothing filtered)."""
    try:
        return int(_EVENTS_CLEARED_AT.read_text().strip())
    except (OSError, ValueError):
        return 0


@router.get("/events", response_model=KioskEvents, dependencies=[Depends(auth_dep)])
async def get_events(n: int = 50) -> KioskEvents:
    n = max(1, min(n, 200))
    cleared_us = _cleared_at_us()
    # Pull a larger window from the journal than `n` because most lines won't
    # match a curated pattern — we filter down before returning.
    proc = await asyncio.create_subprocess_exec(
        "journalctl",
        "-u",
        "alarm-bridge.service",
        "--output=json",
        f"-n{n * 8}",
        "--no-pager",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=6.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        raise HTTPException(status_code=504, detail="journalctl timed out")

    events: list[KioskEvent] = []
    for line in out.decode(errors="replace").splitlines():
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
        ts_raw = entry.get("__REALTIME_TIMESTAMP", "")
        try:
            ts_us = int(ts_raw)
        except (ValueError, TypeError):
            continue
        if ts_us <= cleared_us:
            continue
        classified = _classify(msg)
        if classified is None:
            continue
        category, text = classified
        dt = datetime.fromtimestamp(ts_us / 1_000_000, tz=timezone.utc).astimezone(_TZ)
        ts_str = dt.strftime("%Y-%m-%d (%a) %H:%M:%S")
        events.append(KioskEvent(timestamp=ts_str, category=category, text=text))

    # Most recent first — that's what the panel expects (top of the list = now)
    events.reverse()
    return KioskEvents(events=events[:n])


@router.post("/events/clear", dependencies=[Depends(auth_dep)])
def clear_events() -> dict[str, int]:
    """Hide everything older than now from /events. Journal stays intact —
    SSH'ing in and running `journalctl -u alarm-bridge` still shows it."""
    now_us = int(datetime.now(tz=timezone.utc).timestamp() * 1_000_000)
    try:
        _EVENTS_CLEARED_AT.parent.mkdir(parents=True, exist_ok=True)
        _EVENTS_CLEARED_AT.write_text(str(now_us))
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"cannot write marker: {e}")
    return {"cleared_at_us": now_us}


# ---------------------------------------------------------------------------
# Server-Sent Events stream
# ---------------------------------------------------------------------------
# Two background workers feed every subscribed /events/stream client:
#
#   1. _mqtt_subscriber — a paho client subscribed to zigbee2mqtt/+ on the
#      mosquitto loopback. On a button press it broadcasts an "alarm" or
#      "selftest" SSE event immediately, in parallel with alarm-bridge
#      receiving the same MQTT message. End-to-end press → flash is
#      sub-second; the previous design polled alarm-bridge's journal every
#      5s for "TAS callout placed", coupling flash latency to the poll
#      interval AND to the synchronous TAS HTTP roundtrip that runs before
#      the log line is written.
#
#   2. _publisher_loop — heartbeats only. Periodic snapshot of CPU temp,
#      load, mem, fan; drives the 即時狀態 card and the frontend's
#      dead-connection watchdog. Renamed semantically from the old
#      journal-polling publisher.

_HEARTBEAT_PERIOD_S = 5.0
_PER_CLIENT_QUEUE_MAX = 32

# Local mirror of alarm-bridge's BUTTON_ACTION_BEHAVIOR (app/scripts/config.py).
# Kept in sync by hand — both modules read MQTT independently; tying them
# together would require importing the bridge package, which is intentionally
# out of tree from the kiosk-ui build.
_BUTTON_ACTION_BEHAVIOR: dict[str, str] = {
    "single": "call",
    "long": "selftest",
}

_MQTT_HOST = "127.0.0.1"
_MQTT_PORT = 1883
_MQTT_TOPIC = "zigbee2mqtt/+"

# CPU temperature sensor on the Pi 5. Reads as millidegrees Celsius;
# /sys/class/thermal/thermal_zone0 is the SoC zone.
_THERMAL_PATH = Path("/sys/class/thermal/thermal_zone0/temp")


def _read_cpu_temp_c() -> float | None:
    """Returns the SoC temperature in degrees C, or None if unavailable."""
    try:
        raw = _THERMAL_PATH.read_text().strip()
        return int(raw) / 1000.0
    except (OSError, ValueError):
        return None


def _read_load() -> tuple[float, float, float] | None:
    """1/5/15-minute load averages from /proc/loadavg, or None on read error."""
    try:
        parts = Path("/proc/loadavg").read_text().split()
        return float(parts[0]), float(parts[1]), float(parts[2])
    except (OSError, ValueError, IndexError):
        return None


# RPi5 Active Cooler exposes a `pwmfan` hwmon device with fan1_input (RPM).
# The hwmon index isn't stable across boots, so we scan /sys/class/hwmon for
# the device whose `name` matches. The scan is cheap (a handful of dirs) and
# we redo it each read so a hotplug or kernel reorder is picked up without
# restarting the backend.
_HWMON_ROOT = Path("/sys/class/hwmon")


def _read_fan_rpm() -> int | None:
    """RPi5 Active Cooler tach reading, or None if no pwmfan hwmon present."""
    try:
        for hwmon in _HWMON_ROOT.iterdir():
            try:
                if (hwmon / "name").read_text().strip() != "pwmfan":
                    continue
                return int((hwmon / "fan1_input").read_text().strip())
            except (OSError, ValueError):
                continue
    except OSError:
        return None
    return None


def _read_mem_kb() -> tuple[int, int] | None:
    """(used_kb, total_kb) — used = total - MemAvailable (matches `free` and
    /api/system/info). Returns None on read error."""
    try:
        total: int | None = None
        avail: int | None = None
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                total = int(line.split()[1])
            elif line.startswith("MemAvailable:"):
                avail = int(line.split()[1])
            if total is not None and avail is not None:
                break
        if total is None or avail is None:
            return None
        return total - avail, total
    except (OSError, ValueError, IndexError):
        return None


class LiveMetrics(BaseModel):
    """Fast-changing host metrics carried on the SSE heartbeat so the kiosk
    frontend can show them ticking live without a per-page poll loop."""

    cpu_c: float | None = None
    load_1: float | None = None
    load_5: float | None = None
    load_15: float | None = None
    mem_used_kb: int | None = None
    mem_total_kb: int | None = None
    fan_rpm: int | None = None


def _read_live_metrics() -> LiveMetrics:
    load = _read_load()
    mem = _read_mem_kb()
    return LiveMetrics(
        cpu_c=_read_cpu_temp_c(),
        load_1=load[0] if load else None,
        load_5=load[1] if load else None,
        load_15=load[2] if load else None,
        mem_used_kb=mem[0] if mem else None,
        mem_total_kb=mem[1] if mem else None,
        fan_rpm=_read_fan_rpm(),
    )


_subscribers: set["asyncio.Queue[str]"] = set()
_publisher_task: asyncio.Task[None] | None = None


def _sse_format(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def _broadcast(event: str, data: dict[str, Any]) -> None:
    msg = _sse_format(event, data)
    dropped: list[asyncio.Queue[str]] = []
    for q in _subscribers:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            # A slow client whose queue overflowed is forced off the bus.
            # EventSource will reconnect; nothing else to clean up here.
            dropped.append(q)
    for q in dropped:
        _subscribers.discard(q)


async def _publisher_loop() -> None:
    # Heartbeats only. alarm/selftest now arrive via the MQTT subscriber
    # (sub-second) — see _mqtt_subscriber below. CPU temp + load + mem +
    # fan are carried on every heartbeat so the kiosk's 即時狀態 card and
    # the EdgeGlow thermal overlay update without a per-page poll. The
    # 5s period stays comfortably under the frontend watchdog (35s).
    while True:
        try:
            metrics = _read_live_metrics()
            _broadcast(
                "heartbeat",
                {"t": int(time.time()), **metrics.model_dump()},
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("kiosk SSE heartbeat iteration failed")
        await asyncio.sleep(_HEARTBEAT_PERIOD_S)


async def start_publisher() -> None:
    """Idempotent: called from FastAPI lifespan."""
    global _publisher_task
    if _publisher_task is None or _publisher_task.done():
        _publisher_task = asyncio.create_task(
            _publisher_loop(), name="kiosk-sse-publisher"
        )


async def stop_publisher() -> None:
    global _publisher_task
    if _publisher_task is None:
        return
    _publisher_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await _publisher_task
    _publisher_task = None


# ---------------------------------------------------------------------------
# MQTT subscriber: fast-path button-press SSE
# ---------------------------------------------------------------------------
_mqtt_client: Any = None
_mqtt_loop: asyncio.AbstractEventLoop | None = None


def _on_mqtt_message(_client: Any, _userdata: Any, msg: Any) -> None:
    # Runs on paho's network thread, NOT the asyncio loop. We hop back to
    # the loop via call_soon_threadsafe before touching _subscribers /
    # asyncio.Queue — both are loop-affine and not thread-safe.
    try:
        payload = json.loads(msg.payload.decode("utf-8", errors="replace"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return
    if not isinstance(payload, dict):
        return
    action = payload.get("action")
    if not isinstance(action, str):
        return
    behavior = _BUTTON_ACTION_BEHAVIOR.get(action)
    if behavior not in ("call", "selftest"):
        return

    event = "alarm" if behavior == "call" else "selftest"
    us = int(time.time() * 1_000_000)
    loop = _mqtt_loop
    if loop is None:
        return
    loop.call_soon_threadsafe(_broadcast, event, {"us": us})


def _on_mqtt_connect(client: Any, _userdata: Any, _flags: Any, rc: int) -> None:
    if rc == 0:
        client.subscribe(_MQTT_TOPIC, qos=0)
    else:
        _log.warning("kiosk MQTT subscriber connect failed rc=%s", rc)


async def start_mqtt_subscriber() -> None:
    """Idempotent: called from FastAPI lifespan. Connects to the loopback
    mosquitto and subscribes to button presses for fast-path SSE flash."""
    global _mqtt_client, _mqtt_loop
    if _mqtt_client is not None:
        return
    import paho.mqtt.client as mqtt  # type: ignore[import]

    _mqtt_loop = asyncio.get_running_loop()
    client = mqtt.Client(client_id="kiosk-ui-flash", clean_session=True)
    client.on_connect = _on_mqtt_connect
    client.on_message = _on_mqtt_message
    # reconnect_delay_set: paho retries with backoff on broker drop; matches
    # alarm-bridge's own resilience so a mosquitto restart doesn't strand
    # the flash path.
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    try:
        client.connect_async(_MQTT_HOST, _MQTT_PORT, keepalive=30)
        client.loop_start()
    except Exception:
        _log.exception("kiosk MQTT subscriber start failed")
        return
    _mqtt_client = client


async def stop_mqtt_subscriber() -> None:
    global _mqtt_client, _mqtt_loop
    if _mqtt_client is None:
        return
    try:
        _mqtt_client.loop_stop()
        _mqtt_client.disconnect()
    except Exception:
        _log.exception("kiosk MQTT subscriber stop failed")
    _mqtt_client = None
    _mqtt_loop = None


async def _client_stream(snapshot_msg: str) -> AsyncIterator[str]:
    q: asyncio.Queue[str] = asyncio.Queue(maxsize=_PER_CLIENT_QUEUE_MAX)
    _subscribers.add(q)
    try:
        # Initial snapshot lets the client render the current state without
        # an extra round-trip to /status, and re-syncs after reconnect.
        yield snapshot_msg
        while True:
            yield await q.get()
    finally:
        _subscribers.discard(q)


@router.get("/events/stream")
async def events_stream() -> StreamingResponse:
    # No auth dep on purpose: the stream emits only public status data, and
    # the on-device Chromium kiosk (loopback) is auth-exempt anyway. LAN
    # subscribers see the same status they could already poll from /status.
    snapshot = await get_status()
    snapshot_msg = _sse_format("snapshot", snapshot.model_dump())
    return StreamingResponse(
        _client_stream(snapshot_msg),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
