"""
Logger configuration: console + rotating file + optional Discord webhook.
"""

import os
import sys

curr_folder = os.path.abspath(os.path.dirname(__file__))
if curr_folder not in sys.path:
    sys.path.insert(0, curr_folder)

import logging
from logging.handlers import TimedRotatingFileHandler
from dotenv import load_dotenv

import config
from discord_notifier import DiscordWebhookHandler, Channel

load_dotenv()

log_dir = os.environ.get("ALARM_BRIDGE_LOG_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "logs",
)
os.makedirs(log_dir, exist_ok=True)

# Single shared Discord handler so we don't spawn one worker per logger.
_discord_handler = None
if config.ENABLE_DISCORD_WEBHOOK_LOGGING and os.environ.get(Channel.SYSTEM.value):
    _discord_handler = DiscordWebhookHandler(Channel.SYSTEM)
    _discord_handler.setLevel(config.DISCORD_LOG_LEVEL)
    _discord_handler.setFormatter(
        logging.Formatter(
            "%(asctime)s - **%(levelname)s** - `%(message)s`",
            "%Y-%m-%d %H:%M:%S",
        )
    )


def setup_logger(
    name,
    console_log_level=logging.INFO,
    console_output=True,
    file_log_level=logging.DEBUG,
    file_output=True,
    dc_output=True,
):
    logger = logging.getLogger(name)

    for handler in logger.handlers[:]:
        logger.removeHandler(handler)

    logger.setLevel(logging.DEBUG)

    formatter = logging.Formatter(
        "%(asctime)s.%(msecs)03d - %(name)-10s - %(levelname)-5s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    if console_output:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        console_handler.setLevel(console_log_level)
        logger.addHandler(console_handler)

    if file_output:
        log_file = os.path.join(log_dir, f"{name}.log")
        file_handler = TimedRotatingFileHandler(
            filename=log_file,
            when=config.LOG_ROTATE_WHEN,
            interval=config.LOG_ROTATE_INTERVAL,
            backupCount=config.LOG_ROTATE_BACKUPCOUNT,
            encoding="utf-8",
            delay=True,
        )
        file_handler.setFormatter(formatter)
        file_handler.setLevel(file_log_level)
        logger.addHandler(file_handler)

    if dc_output and _discord_handler is not None:
        logger.addHandler(_discord_handler)

    return logger
