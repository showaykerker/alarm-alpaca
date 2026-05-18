"""Smoke: post to both Discord webhooks via the production code path.

Verifies that DISCORD_USER_WEBHOOK_URL / DISCORD_SYSTEM_WEBHOOK_URL are set
correctly in the deployment's EnvironmentFile and reachable from the device.

Invoked on the RPi as: alarm-smoke discord
"""

import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from discord_notifier import Channel, get_notifier, post_message  # noqa: E402


def main() -> int:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    user_url = os.environ.get(Channel.USER.value)
    sys_url = os.environ.get(Channel.SYSTEM.value)
    print(f"[discord_smoke] USER webhook set?   {bool(user_url)}")
    print(f"[discord_smoke] SYSTEM webhook set? {bool(sys_url)}")

    missing = []
    if not user_url:
        missing.append(Channel.USER.value)
    if not sys_url:
        missing.append(Channel.SYSTEM.value)
    if missing:
        print(f"[discord_smoke] missing env: {', '.join(missing)} — aborting")
        return 2

    print("[discord_smoke] notifier→USER ...")
    get_notifier(Channel.USER).info(f"🧪 alarm-smoke USER @ {stamp}")

    print("[discord_smoke] notifier→SYSTEM ...")
    get_notifier(Channel.SYSTEM).info(f"🧪 alarm-smoke SYSTEM @ {stamp}")

    print("[discord_smoke] direct post_message→SYSTEM (wait=true) ...")
    result = post_message(
        f"🧪 alarm-smoke direct @ {stamp}", channel=Channel.SYSTEM, wait=True
    )
    print(f"[discord_smoke] direct returned: {result}")
    if result is None:
        print(
            "[discord_smoke] direct post failed (None) — webhook URL invalid or network unreachable"
        )
        return 1

    # Webhook handler queues via a worker thread; flush before exit.
    try:
        time.sleep(3)
    except KeyboardInterrupt:
        print(
            "\n[discord_smoke] interrupted before flush — Discord posts may not have left the queue"
        )
        return 130
    print("[discord_smoke] done — check both channels in Discord")
    return 0


if __name__ == "__main__":
    sys.exit(main())
