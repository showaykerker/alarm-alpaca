"""
Configuration for the emergency-button bridge.
"""

import logging
import os

############# MQTT Settings #############
# Broker/port overridable so the bridge can be containerized later and just
# point at `mosquitto` instead of host-published 1883.
MQTT_BROKER = os.environ.get("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
# `+` matches exactly one level — catches `zigbee2mqtt/<device>` (the only
# topics with `action`) but excludes bridge/info, bridge/logging, etc. that
# the old `#` subscription pulled in only to be filtered in the callback.
MQTT_TOPIC = "zigbee2mqtt/+"
MQTT_QOS = 0
MQTT_RECONNECT_DELAY = 5
MQTT_MAX_RECONNECT_ATTEMPTS = 10

############# Button Behavior ############
# Maps Zigbee2MQTT `action` values to internal behaviors.
#   "call"     -> trigger CHT TAS IVR callout + Discord notice
#   "selftest" -> Discord notice only (no real call)
BUTTON_ACTION_BEHAVIOR = {
    "single": "call",
    "long": "selftest",
}

############ Button Alert Thresholds ############
BATTERY_ALARM_THRESHOLD = 30  # %
VOLTAGE_ALARM_THRESHOLD = 2400  # mV
LINK_ALARM_THRESHOLD = 60  # link quality

############ CHT TAS (Telecom Application Service) ############
TAS_URL = "https://tasapi.cht.com.tw/apis/CHTIoT/phone-conn/v1/callout"
TAS_SERVICE_NUMBER = os.environ.get("TAS_SERVICE_NUMBER", "")
TAS_PHONES = [
    p.strip() for p in os.environ.get("TAS_PHONES", "").split(",") if p.strip()
]
TAS_IVR_WELCOME_TEXT = "急診室呼叫緊急案件！"
TAS_IVR_TEXT = "請值班醫師立刻到急診室"
TAS_IVR_BYE_TEXT = "謝謝您"
TAS_IVR_REPEAT = 1
TAS_RINGING_TIMEOUT = 15  # seconds
TAS_COOLDOWN_SECONDS = 10  # min interval between callouts (debounce double-press)
TAS_HTTP_TIMEOUT = 15
# Sliding-window safety cap on top of the per-press cooldown. Protects
# against runaway triggers — rogue paired zigbee device spamming `action`,
# an alarm-bridge bug looping, or anyone who eventually gets MQTT publish
# rights to `zigbee2mqtt/<btn>/action`. Counted at the same point as the
# cooldown (per HTTP attempt, not per success), so a TAS-side failure
# still consumes a slot.
TAS_HOURLY_LIMIT = 12
TAS_HOURLY_WINDOW_SECONDS = 3600

############ Discord Webhook ############
DISCORD_HEARTBEAT_TITLE = "🟢 Emergency Button Monitor"
HEARTBEAT_INTERVAL_SECONDS = 900

############ Log Configs ############
LOG_ROTATE_WHEN = "W0"
LOG_ROTATE_INTERVAL = 7
LOG_ROTATE_BACKUPCOUNT = 8
ENABLE_DISCORD_WEBHOOK_LOGGING = True
DISCORD_LOG_LEVEL = logging.CRITICAL
