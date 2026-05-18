"""
Discord notifier built on top of incoming webhooks.

Two channels are supported:
  - USER   -> user-facing notifications (emergency call)
  - SYSTEM -> system messages (logs, heartbeat, self-test)

The primary integration point is `get_notifier(channel)`, which returns a
plain `logging.Logger` whose only handler ships records to the right webhook.
That way the rest of the codebase only knows about loggers — never about HTTP
or webhook URLs.

`post_message` / `edit_message` remain exported because the heartbeat needs
them (it edits a previously-sent message, which can't be expressed cleanly
through the logging API).
"""

import logging
import os
import queue
import threading
import time
from datetime import datetime
from enum import Enum
from typing import Optional

import httpx

import config

_internal_log = logging.getLogger("dc_notif")
_DISCORD_CONTENT_LIMIT = 2000


class Channel(Enum):
    USER = "DISCORD_USER_WEBHOOK_URL"
    SYSTEM = "DISCORD_SYSTEM_WEBHOOK_URL"


def _webhook_url(channel: Channel) -> Optional[str]:
    return os.environ.get(channel.value)


def post_message(
    content: str, *, channel: Channel, wait: bool = False
) -> Optional[dict]:
    """POST a message to the configured webhook. Returns the message JSON when
    wait=True (so the caller can grab `id` for later edits)."""
    url = _webhook_url(channel)
    if not url or not content:
        return None
    try:
        params = {"wait": "true"} if wait else None
        r = httpx.post(
            url,
            json={"content": content[:_DISCORD_CONTENT_LIMIT]},
            params=params,
            timeout=10,
        )
        r.raise_for_status()
        if wait:
            return r.json()
    except Exception as e:
        _internal_log.warning(f"discord post failed ({channel.name}): {e}")
    return None


def edit_message(message_id: str, content: str, *, channel: Channel) -> bool:
    url = _webhook_url(channel)
    if not url or not message_id:
        return False
    try:
        r = httpx.patch(
            f"{url}/messages/{message_id}",
            json={"content": content[:_DISCORD_CONTENT_LIMIT]},
            timeout=10,
        )
        r.raise_for_status()
        return True
    except Exception as e:
        _internal_log.warning(f"discord edit failed ({channel.name}): {e}")
        return False


class DiscordWebhookHandler(logging.Handler):
    """Ship log records to a Discord webhook channel from a worker thread.

    `emit` only enqueues, so logging never blocks the caller. The worker
    paces requests to stay under Discord rate limits.
    """

    def __init__(self, channel: Channel, level=logging.NOTSET):
        super().__init__(level)
        self._channel = channel
        self._queue: queue.Queue = queue.Queue(maxsize=200)
        self._stop = threading.Event()
        self._worker = threading.Thread(
            target=self._run, daemon=True, name=f"dc-webhook-{channel.name.lower()}"
        )
        self._worker.start()

    def emit(self, record):
        try:
            msg = self.format(record)
        except Exception:
            return
        try:
            self._queue.put_nowait(msg)
        except queue.Full:
            pass

    def _run(self):
        while not self._stop.is_set():
            try:
                msg = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue
            if not _webhook_url(self._channel):
                continue
            post_message(msg, channel=self._channel)
            time.sleep(0.3)

    def close(self):
        self._stop.set()
        super().close()


_notifiers: dict[Channel, logging.Logger] = {}
_notifiers_lock = threading.Lock()


def get_notifier(channel: Channel) -> logging.Logger:
    """Return a logger whose only handler ships records to `channel`'s webhook
    using a plain `%(message)s` formatter (i.e. no timestamp/level boilerplate
    in the user-facing channel)."""
    with _notifiers_lock:
        if channel in _notifiers:
            return _notifiers[channel]
        logger = logging.getLogger(f"notify.{channel.name.lower()}")
        logger.setLevel(logging.INFO)
        logger.propagate = False
        for h in logger.handlers[:]:
            logger.removeHandler(h)
        handler = DiscordWebhookHandler(channel)
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        _notifiers[channel] = logger
        return logger


class Heartbeat(threading.Thread):
    """Posts a status message to the SYSTEM channel and edits it periodically."""

    def __init__(self, interval_seconds: int):
        super().__init__(daemon=True, name="heartbeat")
        self._interval = interval_seconds
        self._stop = threading.Event()
        self._start_time = datetime.now()
        self._message_id: Optional[str] = None
        self._init_text = (
            f"## {config.DISCORD_HEARTBEAT_TITLE}\n"
            f"> Started at `{self._start_time.strftime('%Y-%m-%d (%a) %H:%M:%S')}`"
        )

    def _ensure_message(self):
        if self._message_id:
            return
        msg = post_message(self._init_text, channel=Channel.SYSTEM, wait=True)
        if msg:
            self._message_id = msg.get("id")

    def _format_status(self) -> str:
        uptime = datetime.now() - self._start_time
        days = uptime.days
        hours, rem = divmod(uptime.seconds, 3600)
        minutes = rem // 60
        return (
            f"{self._init_text}\n"
            f"> **Uptime:** `{days:02d}d {hours:02d}h {minutes:02d}m`\n"
            f"> **Last Check:** `{datetime.now().strftime('%Y-%m-%d (%a) %H:%M:%S')}`"
        )

    def _mark_alive(self) -> None:
        # Touch a marker file on every successful tick so the kiosk-ui's
        # System page can surface "last Discord heartbeat" without grovelling
        # through journalctl. The file path is shared with kiosk-ui via the
        # ALARM_BRIDGE_HEARTBEAT_FILE env (set in alarm-bridge.nix). Failure
        # to write is silently ignored — heartbeat reporting is best-effort
        # diagnostic, not load-bearing.
        path = os.environ.get(
            "ALARM_BRIDGE_HEARTBEAT_FILE",
            "/run/alarm-bridge/discord-heartbeat-last",
        )
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = f"{path}.tmp"
            with open(tmp, "w") as f:
                f.write(f"{int(time.time())}\n{self._interval}\n")
            os.replace(tmp, path)
        except OSError:
            pass

    def run(self):
        self._ensure_message()
        if self._message_id:
            self._mark_alive()
        while not self._stop.wait(self._interval):
            self._ensure_message()
            if self._message_id:
                if edit_message(
                    self._message_id, self._format_status(), channel=Channel.SYSTEM
                ):
                    self._mark_alive()

    def stop(self):
        self._stop.set()
