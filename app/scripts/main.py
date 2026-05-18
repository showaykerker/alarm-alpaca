"""
MQTT bridge: zigbee2mqtt button events -> CHT TAS callout + Discord webhook.
"""

import os
import sys

curr_folder = os.path.abspath(os.path.dirname(__file__))
if curr_folder not in sys.path:
    sys.path.insert(0, curr_folder)

import config
from logger import setup_logger
from mqtt_connection import MQTTConnection
from message_handler import MessageHandler
from discord_notifier import Heartbeat

log = setup_logger("main")


def main():
    log.info("Starting emergency-button bridge")

    heartbeat = Heartbeat(config.HEARTBEAT_INTERVAL_SECONDS)
    heartbeat.start()

    handler = MessageHandler()
    connection = MQTTConnection(
        broker=config.MQTT_BROKER,
        port=config.MQTT_PORT,
        topic=config.MQTT_TOPIC,
        message_callback=handler.handle_message,
    )

    exit_code = 0
    try:
        if not connection.connect():
            log.error("Failed to connect to MQTT broker. Exiting.")
            sys.exit(1)
        connection.wait_for_messages()
        if connection.gave_up:
            # MQTTConnection exhausted reconnect attempts and asked us to exit.
            # Non-zero so systemd Restart=always re-spawns cleanly.
            exit_code = 2
    except KeyboardInterrupt:
        log.critical("Received interrupt signal, shutting down...")
    except Exception as e:
        log.critical(f"Error: {e}. The system is shut down.")
        exit_code = 1
    finally:
        connection.disconnect()
        heartbeat.stop()

    log.critical("Program terminated")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
