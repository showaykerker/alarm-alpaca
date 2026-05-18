"""
CHT TAS (Telecom Application Service) IVR callout client.

A successful POST tells TAS to dial the configured phones and play the IVR
script. There is no API to cancel an in-flight call — the IVR runs to its
own `ringingTimeout`.
"""

import os
import threading
import time

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

    def trigger_call(self) -> bool:
        with self._lock:
            now = time.monotonic()
            if now - self._last_call_ts < config.TAS_COOLDOWN_SECONDS:
                log.warning("TAS cooldown active, skipping callout")
                return False
            self._last_call_ts = now

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
