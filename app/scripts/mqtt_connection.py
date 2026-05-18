"""
MQTT connection handler for managing broker connections and subscriptions.
"""

import paho.mqtt.client as mqtt
import time
import traceback
from threading import Thread, Event

import config
from logger import setup_logger

# Setup logger
log = setup_logger("mqtt_conn")


class MQTTConnection:
    """
    Manages MQTT broker connection, reconnection, and basic callbacks.
    """

    def __init__(self, broker=None, port=None, topic=None, message_callback=None):
        """
        Initialize the MQTT connection manager.

        Args:
            broker (str): MQTT broker address
            port (int): MQTT broker port
            topic (str): MQTT topic to subscribe to
            message_callback (callable): Callback function for messages
        """
        self.broker = broker or config.MQTT_BROKER
        self.port = port or config.MQTT_PORT
        self.topic = topic or config.MQTT_TOPIC
        self.message_callback = message_callback
        self.client = None
        self.connected = Event()
        self.should_stop = Event()
        self.reconnect_count = 0
        # Set when reconnect attempts are exhausted, so main() can exit
        # non-zero and let systemd Restart=always re-spawn the process.
        self.gave_up = False

    def _on_connect(self, client, userdata, flags, rc, *args, **kwargs):
        """
        Callback for when the client connects to the broker.

        Note: The signature includes *args, **kwargs to handle different paho-mqtt versions.
        """
        if rc == 0:
            log.info(f"Connected to MQTT broker at {self.broker}:{self.port}")
            self.client.subscribe(self.topic)
            log.info(f"Subscribed to topic: {self.topic}")
            self.connected.set()
            self.reconnect_count = 0
        else:
            log.error(f"Failed to connect to MQTT broker, code: {rc}")
            self.connected.clear()

    def _on_disconnect(self, client, userdata, rc, *args, **kwargs):
        """
        Callback for when the client disconnects from the broker.

        Note: The signature includes *args, **kwargs to handle different paho-mqtt versions.
        """
        log.warning(f"Disconnected from MQTT broker with code: {rc}")
        self.connected.clear()

        # Attempt reconnection if not stopping
        if not self.should_stop.is_set():
            self._schedule_reconnect()

    def _on_message(self, client, userdata, msg):
        """
        Callback for when a message is received from the broker.
        """
        if self.message_callback:
            try:
                self.message_callback(msg)
            except Exception as e:
                log.error(f"Error in message callback: {e}")
                log.error(traceback.format_exc())

    def _schedule_reconnect(self):
        """
        Schedule a reconnection attempt.
        """
        if self.reconnect_count < config.MQTT_MAX_RECONNECT_ATTEMPTS:
            self.reconnect_count += 1
            delay = config.MQTT_RECONNECT_DELAY * self.reconnect_count
            log.info(
                f"Scheduling reconnection attempt {self.reconnect_count} in {delay} seconds"
            )

            Thread(target=self._delayed_reconnect, args=(delay,), daemon=True).start()
        else:
            log.critical(
                f"Maximum reconnection attempts ({config.MQTT_MAX_RECONNECT_ATTEMPTS}) "
                f"reached — giving up; systemd will restart the unit"
            )
            self.gave_up = True
            self.should_stop.set()

    def _delayed_reconnect(self, delay):
        """
        Attempt to reconnect after a delay.
        """
        time.sleep(delay)
        if not self.should_stop.is_set():
            try:
                log.info(f"Attempting to reconnect to MQTT broker")
                self.client.reconnect()
            except Exception as e:
                log.error(f"Reconnection attempt failed: {e}")
                self._schedule_reconnect()

    def connect(self):
        """
        Connect to the MQTT broker.

        Returns:
            bool: True if connection was established, False otherwise
        """
        try:
            # Setup MQTT client
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

            # Set callbacks
            self.client.on_connect = self._on_connect
            self.client.on_disconnect = self._on_disconnect
            self.client.on_message = self._on_message

            # Connect to broker
            log.info(f"Connecting to MQTT broker at {self.broker}:{self.port}")
            self.client.connect(self.broker, self.port, 60)

            # Start the network loop
            self.client.loop_start()

            # Wait for connection
            if not self.connected.wait(timeout=10):
                log.warning("Timed out waiting for initial connection")

            return self.connected.is_set()

        except Exception as e:
            log.error(f"Error connecting to MQTT broker: {e}")
            log.error(traceback.format_exc())
            return False

    def disconnect(self):
        """
        Disconnect from the MQTT broker.
        """
        if self.client:
            log.info("Disconnecting from MQTT broker")
            self.should_stop.set()
            self.client.loop_stop()
            self.client.disconnect()
            log.info("Disconnected from MQTT broker")

    def wait_for_messages(self):
        """
        Wait for messages until interrupted.
        """
        try:
            log.info("Waiting for MQTT messages. Press Ctrl+C to exit.")
            while not self.should_stop.is_set():
                time.sleep(1)
        except KeyboardInterrupt:
            log.info("Received interrupt signal, shutting down...")
            self.disconnect()
