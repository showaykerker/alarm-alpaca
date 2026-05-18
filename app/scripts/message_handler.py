"""
Parse zigbee2mqtt messages and dispatch to TAS / Discord.
"""

import json
import queue
import secrets
import threading
import time
import traceback

import config
from logger import setup_logger
from tas_client import tas_client
from discord_notifier import get_notifier, Channel

log = setup_logger("msg_hdl")
user_notify = get_notifier(Channel.USER)
system_notify = get_notifier(Channel.SYSTEM)

# Bounded queue + fixed worker pool. Each MQTT message used to spawn a fresh
# daemon thread; a burst (or a local-loopback flood, now that mosquitto is
# 127.0.0.1-only) could exhaust memory. Two workers handle zigbee2mqtt's
# normal cadence with room to spare; the 200-slot queue absorbs short bursts
# and drops (with a warning) anything beyond that rather than backpressuring
# paho's network thread.
_WORKER_COUNT = 2
_QUEUE_MAXSIZE = 200


class MessageHandler:
    def __init__(self):
        self._queue: queue.Queue = queue.Queue(maxsize=_QUEUE_MAXSIZE)
        self._dropped = 0
        for i in range(_WORKER_COUNT):
            t = threading.Thread(
                target=self._worker_loop,
                name=f"msg-hdl-{i}",
                daemon=True,
            )
            t.start()

    def handle_message(self, msg):
        try:
            self._queue.put_nowait(msg)
        except queue.Full:
            self._dropped += 1
            # Log at most every 50 drops so a sustained flood doesn't itself
            # become a log-flood. The counter resets only when the process
            # restarts, which is fine — sustained drops mean systemd should
            # be paged via the heartbeat staleness anyway.
            if self._dropped % 50 == 1:
                log.warning(
                    f"message queue full ({_QUEUE_MAXSIZE}); dropped {self._dropped} message(s) so far"
                )

    def _worker_loop(self):
        while True:
            msg = self._queue.get()
            try:
                self._parse_message(msg)
            except Exception as e:
                log.error(f"worker crashed parsing message: {e}\n{traceback.format_exc()}")
            finally:
                self._queue.task_done()

    def _parse_message(self, msg):
        identifier = secrets.token_urlsafe(6)
        try:
            payload = msg.payload.decode()
            topic = msg.topic
            if "logging" in topic:
                return

            data = json.loads(payload)
            if not isinstance(data, dict):
                return
            if "action" not in data:
                # zigbee2mqtt sends frequent state pings without `action` — ignore silently.
                return

            data["topic"] = topic.split("/")[-1]
            identifier = f"{identifier} - {topic}"
            log.debug(f"ID {identifier} | parsed: {data}")

            self._dispatch(identifier, data)
            self._check_thresholds(data)

        except json.JSONDecodeError:
            log.warning(
                f"ID {identifier} | non-JSON payload: {msg.payload.decode()[:100]}"
            )
        except Exception as e:
            log.error(f"ID {identifier} | parsing error: {e}\n{traceback.format_exc()}")

    def _dispatch(self, identifier, data):
        action = data.get("action")
        actual = config.BUTTON_ACTION_BEHAVIOR.get(action)
        # button= surfaces the zigbee2mqtt friendly_name (last segment of
        # the MQTT topic) so the kiosk-ui's event-classifier can attach
        # "who pressed it" to each entry without having to correlate logs.
        button = data.get("topic") or "?"
        log.info(f"ID {identifier} | action={action}, mapped={actual}, button={button}")

        if actual == "call":
            now = time.strftime("%Y/%m/%d (%a) %H:%M")
            user_notify.info(
                f"🚨 **急救室呼叫急救案件** {now}\n" f"> 來源: `{data.get('topic')}`"
            )
            # Success path: tas_client already logs "TAS callout placed: 200 ..."
            # with the HTTP body — re-logging here only adds noise (and made
            # the kiosk events page show "已撥出緊急電話" twice per press).
            if not tas_client.trigger_call():
                log.critical(f"ID {identifier} | TAS callout failed")

        elif actual == "selftest":
            now = time.strftime("%Y-%m-%d (%a) %H:%M:%S")
            battery = data.get("battery", "n/a")
            voltage = data.get("voltage", "n/a")
            linkquality = data.get("linkquality", "n/a")
            system_notify.info(
                f"🧪 **Self-test** `{data.get('topic')}` @ {now}\n"
                f"> Battery: `{battery}%` / Voltage: `{voltage} mV` / Link: `{linkquality}`"
            )

        else:
            log.debug(f"ID {identifier} | unhandled action {action!r}, ignoring")

    def _check_thresholds(self, data):
        topic = data.get("topic")
        battery = data.get("battery")
        voltage = data.get("voltage")
        linkquality = data.get("linkquality")

        # Emit on both channels: system_notify reaches Discord regardless of
        # DISCORD_LOG_LEVEL (these are user-actionable alerts, not log noise);
        # log.warning puts the same line in the alarm-bridge journal so the
        # kiosk-ui events page regex (`電池剩`, `電池電壓`, `連線品質不佳` in
        # routes/kiosk.py) can pick it up. discord_notifier.get_notifier sets
        # propagate=False on its loggers, so system_notify alone never reaches
        # the journal.
        if (
            isinstance(battery, (int, float))
            and battery < config.BATTERY_ALARM_THRESHOLD
        ):
            msg = f"🔋 `{topic}` 電池剩 `{battery}%`，請盡快更換"
            system_notify.warning(msg)
            log.warning(msg)
        if (
            isinstance(voltage, (int, float))
            and voltage < config.VOLTAGE_ALARM_THRESHOLD
        ):
            msg = f"🔋 `{topic}` 電池電壓 `{voltage} mV`，可能需要更換"
            system_notify.warning(msg)
            log.warning(msg)
        if (
            isinstance(linkquality, (int, float))
            and linkquality < config.LINK_ALARM_THRESHOLD
        ):
            msg = f"📶 `{topic}` 連線品質不佳: `{linkquality}`"
            system_notify.warning(msg)
            log.warning(msg)
