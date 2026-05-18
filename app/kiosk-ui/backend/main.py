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
  POST /api/system/poweroff           — shut the device down (202, runs detached)
  POST /api/system/reboot             — reboot the device (202, runs detached)
  GET  /api/network/info              — per-interface IPv4 + mDNS self-probe (cached 30s)

Static:
  /        — React SPA (HashRouter). Served without authentication: the
             SPA shell + assets are visible to anyone who can reach the
             port. All /api/* endpoints (except /api/health) require HTTP
             Basic for non-loopback clients; loopback (on-device Chromium
             kiosk) is auth-exempt at the API layer.

Bind address and password live in env vars set by kiosk-ui.nix.
"""

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
from routes.system import router as system_router
from routes.network import router as network_router
from routes.alarm import router as alarm_router

PHONES_FILE = Path(os.environ.get("KIOSK_PHONES_FILE", "/etc/alarm-bridge/phones.txt"))
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
    # The kiosk SSE publisher fans alarm/selftest events out to every open
    # /api/kiosk/events/stream subscriber. Started once at app boot so the
    # first client connect doesn't pay the cold-scan cost.
    await start_kiosk_publisher()
    try:
        yield
    finally:
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
