"""FastAPI app for the alarm-alpaca kiosk UI.

API:
  GET  /api/health                    — liveness probe (no auth)
  GET  /api/phones                    — list of phone numbers
  PUT  /api/phones                    — replace phone numbers (atomic write)
  GET  /api/dashboard                 — aggregate status, system info, recent events
  POST /api/dashboard/restart         — restart a watched unit
  GET  /api/services                  — per-unit status + recent logs
  POST /api/services/{restart,stop,start}
  GET  /api/logs?unit=<unit>&n=<n>    — journalctl entries (TZ: Asia/Taipei)
  GET  /api/wifi                      — WiFi scan + ethernet status
  POST /api/wifi/connect              — nmcli connect to SSID
  POST /api/wifi/disconnect           — disconnect WiFi (cable stays up)
  GET  /api/zigbee                    — device count from MQTT bridge/devices
  POST /api/zigbee/permit-join        — publish permit_join to MQTT
  GET  /api/kiosk/status              — operator-facing aggregated status
  GET  /api/kiosk/events              — curated Chinese activity stream
  GET  /api/kiosk/brightness          — current backlight value/percent
  PUT  /api/kiosk/brightness          — set backlight (clamped to ≥5%)
  GET  /api/kiosk/sleep-config        — sleep mode timeout config
  PUT  /api/kiosk/sleep-config        — update sleep mode timeout (0=disabled)
  POST /api/system/poweroff           — shut the device down (202, runs detached)
  POST /api/system/reboot             — reboot the device (202, runs detached)
  GET  /api/network/info              — per-interface IPv4 + mDNS self-probe (cached 30s)
  GET  /api/eng/zigbee/devices        — per-device LQI, battery, last_seen
  GET  /api/eng/zigbee/bridge         — z2m bridge info (version, channel, panID)
  GET  /api/eng/mqtt/stream           — SSE live MQTT stream (60s auto-close)
  GET  /api/eng/alarm-bridge/stats    — debounce stats + raw journal
  GET  /api/eng/system/network        — routing table + DNS resolvers
  GET  /api/eng/system/containers     — podman container stats
  GET  /api/eng/system/sd-health      — SD card I/O errors (24h kernel log)
  GET  /api/eng/system/throttle-history — throttle events (24h kernel log)
  GET  /api/eng/deploy/status         — deploy detection + current generation
  GET  /api/eng/deploy/generations    — NixOS generation list
  POST /api/eng/deploy/cleanup        — delete old generations + GC

Static:
  /        — React SPA (HashRouter). Served without authentication: the
             SPA shell + assets are visible to anyone who can reach the
             port. All /api/* endpoints (except /api/health) require HTTP
             Basic for non-loopback clients; loopback (on-device Chromium
             kiosk) is auth-exempt at the API layer.

Bind address and password live in env vars set by kiosk-ui.nix.
"""

import json
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.types import Scope

from auth import auth_dep
from routes.dashboard import router as dashboard_router
from routes.services import router as services_router
from routes.logs import router as logs_router
from routes.wifi import router as wifi_router
from routes.zigbee import router as zigbee_router
from routes.kiosk import router as kiosk_router
from routes.kiosk import start_publisher as start_kiosk_publisher
from routes.kiosk import stop_publisher as stop_kiosk_publisher
from routes.kiosk import start_mqtt_subscriber as start_kiosk_mqtt
from routes.kiosk import stop_mqtt_subscriber as stop_kiosk_mqtt
from routes.system import router as system_router
from routes.network import router as network_router
from routes.alarm import router as alarm_router
from routes.eng import router as eng_router

PHONES_FILE = Path(os.environ.get("KIOSK_PHONES_FILE", "/etc/alarm-bridge/phones.txt"))
PRESETS_FILE = Path(
    os.environ.get("KIOSK_PRESETS_FILE", "/var/lib/kiosk-ui/phone-presets.json")
)
# One frontend serves both the on-device Chromium kiosk and LAN admin
# clients. Mounted at /.
STATIC_DIR = Path(os.environ.get("KIOSK_STATIC_DIR", ""))

# Phone validator: digits, optional leading +. Matches the frontend
# Phone.tsx regex (^\+?\d{3,20}$) so a number the operator can type in
# the kiosk UI is the same shape the backend accepts. Separators in
# inbound payloads are normalised away in put_phones() before this
# regex runs, so legacy entries like "02-1234-5678" still go through.
_PHONE_RE = re.compile(r"^\+?\d{3,20}$")
_PHONE_SEPARATORS_RE = re.compile(r"[\s\-]+")


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Heartbeat publisher (CPU/load/mem) + MQTT subscriber (alarm/selftest
    # fast path). Both fan into the shared SSE broadcast on
    # /api/kiosk/events/stream — the MQTT subscriber runs press-to-flash in
    # under a second, replacing the previous 5s journal poll.
    await start_kiosk_publisher()
    await start_kiosk_mqtt()
    try:
        yield
    finally:
        await stop_kiosk_mqtt()
        await stop_kiosk_publisher()


app = FastAPI(title="alarm-alpaca kiosk", lifespan=_lifespan)

app.include_router(dashboard_router)
app.include_router(services_router)
app.include_router(logs_router)
app.include_router(wifi_router)
app.include_router(zigbee_router)
app.include_router(kiosk_router)
app.include_router(system_router)
app.include_router(network_router)
app.include_router(alarm_router)
app.include_router(eng_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class PhonesResponse(BaseModel):
    phones: list[str]


class PhonesUpdate(BaseModel):
    phones: list[str]


def _parse(raw: str) -> list[str]:
    out: list[str] = []
    for line in raw.splitlines():
        s = line.split("#", 1)[0].strip()
        if s:
            out.append(s)
    return out


@app.get(
    "/api/phones",
    response_model=PhonesResponse,
    dependencies=[Depends(auth_dep)],
)
def get_phones() -> PhonesResponse:
    try:
        raw = PHONES_FILE.read_text()
    except FileNotFoundError:
        raw = ""
    return PhonesResponse(phones=_parse(raw))


@app.put(
    "/api/phones",
    response_model=PhonesResponse,
    dependencies=[Depends(auth_dep)],
)
def put_phones(payload: PhonesUpdate) -> PhonesResponse:
    # De-dupe while preserving order; whitespace-only entries dropped.
    seen: set[str] = set()
    cleaned: list[str] = []
    invalid: list[dict[str, object]] = []
    for idx, raw in enumerate(payload.phones):
        # Strip surrounding whitespace and internal separators (spaces, dashes)
        # so callers that submit "02-1234-5678" land in storage as "0212345678",
        # matching the digits-only shape the frontend keypad produces.
        s = _PHONE_SEPARATORS_RE.sub("", (raw or "").strip())
        if not s:
            continue
        if not _PHONE_RE.match(s):
            invalid.append({"index": idx, "value": raw})
            continue
        if s in seen:
            continue
        seen.add(s)
        cleaned.append(s)
    if invalid:
        raise HTTPException(status_code=422, detail={"invalid": invalid})

    # On-disk format: one phone per line, no comments. The previous
    # "# comments allowed" affordance is dropped along with the textarea UI.
    body = "\n".join(cleaned) + ("\n" if cleaned else "")
    tmp = PHONES_FILE.with_name(f".{PHONES_FILE.name}.tmp")
    tmp.write_text(body)
    tmp.chmod(0o664)
    tmp.replace(PHONES_FILE)
    return PhonesResponse(phones=cleaned)


# ---------------------------------------------------------------------------
# Phone presets — persist to /var/lib/kiosk-ui/phone-presets.json
# ---------------------------------------------------------------------------


class PhonePreset(BaseModel):
    name: str
    phones: list[str]


class PresetsResponse(BaseModel):
    presets: list[PhonePreset]


class PresetCreate(BaseModel):
    name: str
    phones: list[str]


def _read_presets() -> list[PhonePreset]:
    try:
        data = json.loads(PRESETS_FILE.read_text())
        return [PhonePreset(**p) for p in data.get("presets", [])]
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return []


def _write_presets(presets: list[PhonePreset]) -> None:
    body = json.dumps(
        {"presets": [p.model_dump() for p in presets]},
        ensure_ascii=False,
        indent=2,
    )
    tmp = PRESETS_FILE.with_suffix(".tmp")
    tmp.write_text(body)
    tmp.replace(PRESETS_FILE)


@app.get(
    "/api/phones/presets",
    response_model=PresetsResponse,
    dependencies=[Depends(auth_dep)],
)
def get_presets() -> PresetsResponse:
    return PresetsResponse(presets=_read_presets())


@app.post(
    "/api/phones/presets",
    response_model=PresetsResponse,
    dependencies=[Depends(auth_dep)],
)
def save_preset(payload: PresetCreate) -> PresetsResponse:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="preset name required")
    cleaned = [
        _PHONE_SEPARATORS_RE.sub("", s.strip()) for s in payload.phones if s.strip()
    ]
    invalid = [s for s in cleaned if not _PHONE_RE.match(s)]
    if invalid:
        raise HTTPException(status_code=422, detail={"invalid": invalid})

    presets = _read_presets()
    existing = next((i for i, p in enumerate(presets) if p.name == name), None)
    entry = PhonePreset(name=name, phones=cleaned)
    if existing is not None:
        presets[existing] = entry
    else:
        presets.append(entry)
    _write_presets(presets)
    return PresetsResponse(presets=presets)


@app.delete(
    "/api/phones/presets/{name}",
    response_model=PresetsResponse,
    dependencies=[Depends(auth_dep)],
)
def delete_preset(name: str) -> PresetsResponse:
    presets = [p for p in _read_presets() if p.name != name]
    _write_presets(presets)
    return PresetsResponse(presets=presets)


# Serve React build last so /api/* takes precedence.
#
# We override StaticFiles to send no-cache headers on index.html. Vite's
# content-hashed asset names (e.g. assets/index-BfxDYbTX.js) handle their
# own cache busting, but the un-hashed index.html that references them must
# not be cached — otherwise clients keep loading stale references to assets
# that no longer exist after a deploy.
class _NoCacheHtmlStatic(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        ct = response.headers.get("content-type", "")
        if ct.startswith("text/html"):
            response.headers["cache-control"] = "no-store, must-revalidate"
            response.headers["pragma"] = "no-cache"
        return response


if STATIC_DIR.is_dir():
    app.mount(
        "/", _NoCacheHtmlStatic(directory=str(STATIC_DIR), html=True), name="static"
    )
