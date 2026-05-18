"""Maintenance-tool routes for the kiosk Machine page.

  POST /api/alarm/doctor               — run alarm-doctor, capture stdout + rc.
  POST /api/alarm/doctor/send-discord  — post the doctor result to Discord.
  POST /api/alarm/smoke                — run alarm-smoke <target> (streams).

All three call into shell tools defined in app/alarm-doctor.nix and
app/alarm-bridge.nix (alarmSmoke). Sudo NOPASSWD rules in kiosk-ui.nix
authorise the matching invocations; this module never re-derives those
command shapes inline so the sudoers entry can stay restrictive.
"""

import asyncio
import logging
import re
import shutil
import socket
from datetime import datetime, timezone
from typing import AsyncIterator, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import auth_dep

router = APIRouter(prefix="/api/alarm", tags=["alarm"])
log = logging.getLogger("kiosk-ui.alarm")

SmokeTarget = Literal["discord", "tas", "zigbee"]


class DoctorResult(BaseModel):
    returncode: int
    stdout: str
    stderr: str


class SmokeRequest(BaseModel):
    target: SmokeTarget


@router.post("/doctor", response_model=DoctorResult, dependencies=[Depends(auth_dep)])
async def run_doctor() -> DoctorResult:
    # alarm-doctor performs read-only health checks but calls `sudo -n`
    # internally for /etc/alarm-bridge/env, podman exec, journalctl -k, and
    # vcgencmd. Those inner sudos rely on the outer invocation already being
    # root, so we wrap with `sudo -n` to match the sudoers NOPASSWD entry
    # for /run/current-system/sw/bin/alarm-doctor. We cap the wait at 30s —
    # individual probes time out at 2-3s each and the full report takes ~5s
    # on a healthy device.
    bin_ = shutil.which("alarm-doctor")
    if not bin_:
        raise HTTPException(status_code=500, detail="alarm-doctor not on PATH")
    proc = await asyncio.create_subprocess_exec(
        "sudo",
        "-n",
        bin_,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        raise HTTPException(status_code=504, detail="alarm-doctor timed out")
    return DoctorResult(
        returncode=proc.returncode or 0,
        stdout=stdout.decode(errors="replace"),
        stderr=stderr.decode(errors="replace"),
    )


async def _stop_smoke_unit(unit: str) -> None:
    try:
        proc = await asyncio.create_subprocess_exec(
            "sudo",
            "-n",
            "systemctl",
            "stop",
            unit,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=10.0)
    except Exception as e:
        log.warning("failed to stop smoke unit %s: %s", unit, e)


async def _stream_smoke(target: SmokeTarget) -> AsyncIterator[bytes]:
    # `alarm-smoke --stream` runs systemd-run with --pipe --wait. Its first
    # output line is `[unit] alarm-smoke-<target>-<pid>` — we strip that
    # banner before forwarding so the dialog only sees the smoke script's
    # output, and we keep the unit name around so client cancellation can
    # `systemctl stop` it (killing the SSE process alone leaves the
    # transient unit running, which keeps alarm-bridge suppressed by the
    # Conflicts= rule until OnSuccess fires).
    bin_ = shutil.which("alarm-smoke")
    if not bin_:
        yield b"[ERROR] alarm-smoke not on PATH\n"
        return
    log.warning("alarm-smoke stream target=%s requested", target)

    proc = await asyncio.create_subprocess_exec(
        "sudo",
        "-n",
        bin_,
        "--yes",
        "--stream",
        target,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,  # merge so the dialog sees both
    )
    assert proc.stdout is not None
    unit: str | None = None
    try:
        # Read the unit-name banner line. readline waits for `\n`; the
        # wrapper prints `[unit] ...\n` before exec, so this resolves
        # before any smoke output arrives.
        try:
            first = await asyncio.wait_for(proc.stdout.readline(), timeout=10.0)
        except asyncio.TimeoutError:
            first = b""
        if first.startswith(b"[unit] "):
            unit = first[len(b"[unit] ") :].strip().decode(errors="replace") or None
        else:
            # Older wrapper or unexpected output — forward the line so the
            # operator sees what came back instead of swallowing it.
            yield first

        while True:
            chunk = await proc.stdout.read(1024)
            if not chunk:
                break
            yield chunk
        rc = await proc.wait()
        yield f"\n[exit code: {rc}]\n".encode()
    except asyncio.CancelledError:
        # Client closed the connection. Stop the transient smoke unit
        # explicitly so alarm-bridge can come back via the OnFailure= hook;
        # otherwise the wrapper death just orphans the unit and the bridge
        # stays Conflicts-suppressed.
        if unit:
            await _stop_smoke_unit(unit)
        proc.kill()
        await proc.wait()
        raise


# ---------------------------------------------------------------------------
# Send alarm-doctor output to Discord (system webhook)
# ---------------------------------------------------------------------------
# The kiosk Machine page already shows the doctor's full output in a dialog;
# this endpoint takes that captured stdout, parses it into per-section
# failures and warnings, and posts a structured embed to the system Discord
# webhook so non-on-device operators can see the report without SSH access.
#
# We accept the stdout the dialog is already displaying instead of re-running
# the doctor: that avoids paying the ~5s cost twice and guarantees the user
# is sending exactly what they're looking at.

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_SECTION_RE = re.compile(r"^== (.+?) ==$")
# alarm-doctor emits one entry per line in `check_*` of the form:
#   "  ✓ label"          (no detail)
#   "  ⚠ label — detail"
#   "  ✗ label — detail"
# The trim-leading-spaces tolerance keeps us robust to formatting tweaks.
_FAIL_RE = re.compile(r"^\s*✗\s+(.+)$")
_WARN_RE = re.compile(r"^\s*⚠\s+(.+)$")


def _parse_doctor(stdout: str) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Split alarm-doctor stdout into (fails_by_section, warns_by_section).

    Section names are preserved in their on-screen Chinese/English form; only
    the leading ✗/⚠ glyph is stripped so the Discord field reads cleanly.
    """
    fails: dict[str, list[str]] = {}
    warns: dict[str, list[str]] = {}
    current = "?"
    for raw in stdout.splitlines():
        line = _ANSI_RE.sub("", raw).rstrip()
        section = _SECTION_RE.match(line.strip())
        if section:
            current = section.group(1)
            continue
        m = _FAIL_RE.match(line)
        if m:
            fails.setdefault(current, []).append(m.group(1).strip())
            continue
        m = _WARN_RE.match(line)
        if m:
            warns.setdefault(current, []).append(m.group(1).strip())
    return fails, warns


def _build_embed(stdout: str, returncode: int) -> dict[str, object]:
    fails, warns = _parse_doctor(stdout)
    total_fails = sum(len(v) for v in fails.values())
    total_warns = sum(len(v) for v in warns.values())

    if total_fails > 0 or returncode != 0:
        color = 0xE53E3E  # red — see Discord embed color int (0xRRGGBB)
        verdict = f"❌ {total_fails} failure(s), {total_warns} warning(s)"
    elif total_warns > 0:
        color = 0xD69E2E  # amber
        verdict = f"⚠️ {total_warns} warning(s), no failures"
    else:
        color = 0x38A169  # green
        verdict = "✅ All checks passed"

    def _field(name: str, lines: list[str]) -> dict[str, object]:
        # Discord field.value cap is 1024 chars. We bullet each line and
        # truncate explicitly so the API doesn't reject the embed.
        bullets = [f"• {line}" for line in lines[:10]]
        if len(lines) > 10:
            bullets.append(f"…+{len(lines) - 10} more")
        joined = "\n".join(bullets)
        if len(joined) > 1024:
            joined = joined[:1020] + "…"
        return {"name": name, "value": joined or "(none)", "inline": False}

    fields: list[dict[str, object]] = []
    for section, lines in fails.items():
        fields.append(_field(f"❌ {section}", lines))
    for section, lines in warns.items():
        fields.append(_field(f"⚠️ {section}", lines))
    # Discord embed cap is 25 fields total.
    fields = fields[:25]

    return {
        "title": f"alarm-doctor — {socket.gethostname()}",
        "description": verdict,
        "color": color,
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        "fields": fields,
        "footer": {"text": f"rc={returncode}"},
    }


async def _read_system_webhook_url() -> str:
    # alarm-doctor exposes a `--print-secret KEY` mode locked to a tiny
    # allowlist; the kiosk-ui sudoers rule pins the flag set so only
    # DISCORD_SYSTEM_WEBHOOK_URL can be requested through this path.
    proc = await asyncio.create_subprocess_exec(
        "sudo",
        "-n",
        "alarm-doctor",
        "--print-secret",
        "DISCORD_SYSTEM_WEBHOOK_URL",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=5.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        raise HTTPException(status_code=504, detail="webhook URL lookup timed out")
    if proc.returncode != 0:
        msg = err.decode(errors="replace").strip() or "unknown error"
        raise HTTPException(status_code=500, detail=f"webhook URL lookup failed: {msg}")
    url = out.decode().strip()
    if not url:
        raise HTTPException(status_code=500, detail="webhook URL empty")
    return url


class SendDiscordRequest(BaseModel):
    # stdout the kiosk dialog captured. We post exactly what the operator
    # sees rather than re-running alarm-doctor and risking a divergent
    # report between dialog and Discord channel.
    stdout: str
    returncode: int = 0


class SendDiscordResult(BaseModel):
    ok: bool
    status_code: int | None = None
    error: str | None = None


@router.post(
    "/doctor/send-discord",
    response_model=SendDiscordResult,
    dependencies=[Depends(auth_dep)],
)
async def send_doctor_to_discord(req: SendDiscordRequest) -> SendDiscordResult:
    embed = _build_embed(req.stdout, req.returncode)
    webhook_url = await _read_system_webhook_url()
    payload = {"embeds": [embed]}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(webhook_url, json=payload)
    except httpx.HTTPError as e:
        return SendDiscordResult(ok=False, error=str(e)[:500])
    if r.status_code >= 400:
        return SendDiscordResult(
            ok=False, status_code=r.status_code, error=r.text[:500]
        )
    return SendDiscordResult(ok=True, status_code=r.status_code)


@router.post("/smoke", dependencies=[Depends(auth_dep)])
async def run_smoke(req: SmokeRequest) -> StreamingResponse:
    # Streaming text/plain — the Machine-page dialog tails it line-by-line.
    # alarm-bridge is stopped for the duration of the smoke unit and
    # restarted on completion (Conflicts=/OnSuccess=/OnFailure= properties
    # on the systemd-run unit). We don't surface the unit name; the dialog
    # just shows the smoke output and the user picks back up from the main
    # status tiles once we return.
    return StreamingResponse(
        _stream_smoke(req.target),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )
