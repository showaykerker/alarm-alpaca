"""
CHT TAS (Telecom Application Service) IVR callout client.

A successful POST tells TAS to dial the configured phones and play the IVR
script. There is no API to cancel an in-flight call — the IVR runs to its
own `ringingTimeout`.
"""

import os
import threading
import time
from collections import deque

import httpx

import config
from logger import setup_logger

log = setup_logger("tas")


def mask_phone(p: str) -> str:
    """Return a PII-safe form for journald/Discord. Keeps the last 4 digits."""
    if not p:
        return ""
    return f"***{p[-4:]}" if len(p) >= 4 else "***"

# Plaintext file holding the production dial list. Re-read on every callout
# so ops can edit numbers via `sudoedit` without restarting the service.
# File missing -> fall back to TAS_PHONES env (dev defaults from .env).
# File present but yields 0 valid numbers -> abort the callout (avoids
# silently dialing dev numbers if the operator emptied the file on purpose
# or by accident).
PHONES_FILE = "/etc/alarm-bridge/phones.txt"


def load_phones() -> tuple[list[str], str]:
    """Returns (phones, source) where source is 'file', 'env-fallback', or 'env-fallback-after-error'."""
    try:
        with open(PHONES_FILE) as f:
            phones = []
            for line in f:
                line = line.split("#", 1)[0].strip()
                if line:
                    phones.append(line)
        return phones, "file"
    except FileNotFoundError:
        return list(config.TAS_PHONES), "env-fallback"
    except OSError as e:
        # File exists but unreadable (permission/IO). Fall back to env so the
        # alarm still rings, but loud-log so the misconfig is fixed.
        log.critical(f"Failed reading {PHONES_FILE}: {e}; using env fallback")
        return list(config.TAS_PHONES), "env-fallback-after-error"


class TasClient:
    def __init__(self):
        self._lock = threading.Lock()
        self._last_call_ts = 0.0
        # Timestamps (monotonic) of every callout attempt accepted by the
        # rate limiter, oldest first. Trimmed to the configured window on
        # each call. State is process-local — restart resets the counter,
        # which is the intended fail-safe: an alarm-bridge crash loop that
        # spams TAS would also spam restarts and reset the bucket, so the
        # systemd Restart=always behaviour does NOT defeat the throttle in
        # practice (RestartSec=5 caps the spam rate; over an hour you'd
        # still need 12+ successful boots to exceed the limit).
        self._recent_calls: deque[float] = deque()

    def trigger_call(self) -> bool:
        rate_limited = False
        with self._lock:
            now = time.monotonic()
            if now - self._last_call_ts < config.TAS_COOLDOWN_SECONDS:
                log.warning("TAS cooldown active, skipping callout")
                return False
            cutoff = now - config.TAS_HOURLY_WINDOW_SECONDS
            while self._recent_calls and self._recent_calls[0] < cutoff:
                self._recent_calls.popleft()
            if len(self._recent_calls) >= config.TAS_HOURLY_LIMIT:
                rate_limited = True
            else:
                self._recent_calls.append(now)
                self._last_call_ts = now

        if rate_limited:
            # Alert outside the lock so the (synchronous) httpx call to
            # Discord doesn't extend the critical section. Imported lazily
            # to keep discord_notifier optional in unit tests / smokes that
            # don't set webhook URLs.
            log.critical(
                "TAS hourly rate limit reached "
                f"({config.TAS_HOURLY_LIMIT} callouts / "
                f"{config.TAS_HOURLY_WINDOW_SECONDS}s); dropping callout"
            )
            try:
                from discord_notifier import Channel, post_message

                post_message(
                    f"⚠️ **TAS rate limit hit** — dropped a callout. "
                    f"Cap: {config.TAS_HOURLY_LIMIT}/hour. "
                    f"Investigate: rogue MQTT publisher, paired-device storm, "
                    f"or alarm-bridge loop.",
                    channel=Channel.SYSTEM,
                )
            except Exception as e:
                log.warning(f"Discord rate-limit alert failed: {e}")
            return False

        api_key = os.environ.get("TAS_API_KEY")
        if not api_key:
            log.error("TAS_API_KEY not set; cannot place callout")
            return False

        phones, source = load_phones()
        if not phones:
            log.error(
                f"No valid phones to dial (source={source}, file={PHONES_FILE}); "
                "aborting callout"
            )
            return False
        log.info(
            f"TAS callout: {len(phones)} phone(s) from {source}: "
            f"{[mask_phone(p) for p in phones]}"
        )

        payload = {
            "serviceNumber": config.TAS_SERVICE_NUMBER,
            "phones": phones,
            "ivrData": {
                "welcomeText": config.TAS_IVR_WELCOME_TEXT,
                "welcomeTextSpeed": 1.2,
                "byeText": config.TAS_IVR_BYE_TEXT,
                "byeTextSpeed": 1.2,
                "text": config.TAS_IVR_TEXT,
                "textSpeed": 1.2,
                "repeat": config.TAS_IVR_REPEAT,
                "betweenTextRepeatDelay": 2,
                "promptMode": "F",
            },
            "ringingTimeout": config.TAS_RINGING_TIMEOUT,
        }

        try:
            response = httpx.post(
                config.TAS_URL,
                headers={
                    "accept": "application/json",
                    "x-api-key": api_key,
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=config.TAS_HTTP_TIMEOUT,
            )
            response.raise_for_status()
            log.info(
                f"TAS callout placed: {response.status_code} {response.text[:200]}"
            )
            return True
        except httpx.HTTPStatusError as e:
            log.critical(
                f"TAS callout HTTP error {e.response.status_code}: {e.response.text[:200]}"
            )
        except Exception as e:
            log.critical(f"TAS callout failed: {e}")
        return False


tas_client = TasClient()
