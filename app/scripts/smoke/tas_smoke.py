"""Smoke: place a REAL CHT TAS callout.

⚠️ Will dial every number in TAS_PHONES and play the configured IVR script.
The TAS API has no cancellation — once placed, the call rings to completion.
The shell wrapper (alarm-smoke) requires a typed 'yes' before invoking this.

Invoked on the RPi as: alarm-smoke tas
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
from tas_client import tas_client, load_phones, mask_phone, PHONES_FILE  # noqa: E402


def main() -> int:
    phones, source = load_phones()
    print(f"[tas_smoke] TAS_URL            = {config.TAS_URL}")
    print(f"[tas_smoke] TAS_SERVICE_NUMBER = {config.TAS_SERVICE_NUMBER!r}")
    print(f"[tas_smoke] phones source      = {source} ({PHONES_FILE})")
    print(f"[tas_smoke] phones to dial     = {[mask_phone(p) for p in phones]!r}")
    print(f"[tas_smoke] TAS_API_KEY set?   = {bool(os.environ.get('TAS_API_KEY'))}")

    missing = []
    if not config.TAS_SERVICE_NUMBER:
        missing.append("TAS_SERVICE_NUMBER")
    if not phones:
        missing.append(f"phones (source={source})")
    if not os.environ.get("TAS_API_KEY"):
        missing.append("TAS_API_KEY")
    if missing:
        print(f"[tas_smoke] missing: {', '.join(missing)} — aborting")
        return 2

    ok = tas_client.trigger_call()
    print(f"[tas_smoke] trigger_call returned: {ok}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
