"""Smoke: print every message published on zigbee2mqtt/# for 30 seconds.

Use this to verify pairings, button presses, and what the production
MessageHandler actually sees coming off the bus. Pure read-only — does not
touch TAS or Discord.

Invoked on the RPi as: alarm-smoke zigbee
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import paho.mqtt.client as mqtt  # noqa: E402

import config  # noqa: E402

DURATION_SECONDS = 30

# `+` matches exactly one topic level, so `zigbee2mqtt/+` catches device
# topics (e.g. `zigbee2mqtt/0x00124b...`) but excludes the noisy retained
# `zigbee2mqtt/bridge/info`, `bridge/converters`, etc. that flood on connect.
SMOKE_TOPIC = "zigbee2mqtt/+"


def main() -> int:
    received = 0

    def on_connect(client, userdata, flags, rc, *args, **kwargs):
        # flush=True throughout so the kiosk-ui Machine page streams these
        # progress lines as they happen (Python defaults to line-buffered
        # only on a tty; under systemd-run --pipe stdout is block-buffered
        # without flush=True, even with `python -u`).
        print(
            f"[zigbee_smoke] connected to {config.MQTT_BROKER}:{config.MQTT_PORT} (rc={rc})",
            flush=True,
        )
        client.subscribe(SMOKE_TOPIC)

    def on_message(client, userdata, msg):
        nonlocal received
        received += 1
        try:
            payload = msg.payload.decode()
            data = json.loads(payload)
            # Multi-line indent when there's enough content to be worth it.
            pretty = json.dumps(
                data, ensure_ascii=False, indent=2 if len(payload) > 100 else None
            )
        except (UnicodeDecodeError, json.JSONDecodeError):
            pretty = repr(msg.payload)
        print(f"\n=== {msg.topic} ===\n{pretty}", flush=True)

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message

    print(
        f"[zigbee_smoke] connecting to {config.MQTT_BROKER}:{config.MQTT_PORT}",
        flush=True,
    )
    client.connect(config.MQTT_BROKER, config.MQTT_PORT, 60)
    client.loop_start()

    print(
        f"[zigbee_smoke] subscribed to {SMOKE_TOPIC!r} (bridge/* filtered out),\n"
        f"               listening for {DURATION_SECONDS}s — press the button (Ctrl+C to stop early)",
        flush=True,
    )
    interrupted = False
    try:
        time.sleep(DURATION_SECONDS)
    except KeyboardInterrupt:
        interrupted = True
        print("\n[zigbee_smoke] interrupted", flush=True)

    client.loop_stop()
    client.disconnect()
    reason = "interrupted" if interrupted else "timeout reached"
    print(
        f"[zigbee_smoke] done ({reason}) — {received} message(s) received",
        flush=True,
    )
    # Treat early-interrupt-after-success as success; only no-messages-at-all is a failure.
    return 0 if received > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
