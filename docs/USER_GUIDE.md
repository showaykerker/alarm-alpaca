# Operator Manual — Alarm-Alpaca Kiosk

Audience: whoever physically uses the touchscreen day-to-day (the
person who will reset a button, re-add WiFi, or check whether last
night's alarm actually placed a phone call).

Everything in this manual is reachable from the touchscreen — no
laptop, no SSH, no command line. The kiosk UI is in Traditional
Chinese; this manual quotes the exact on-screen labels so an
English-reading user can point at the right tile.

## Home screen (`主頁`)

![Home screen](screenshots/main.png)


| Tile          | What it means                                                              | Tap to                       |
| ------------- | -------------------------------------------------------------------------- | ---------------------------- |
| `緊急通報`    | The alarm-bridge daemon. Forwards button presses to phone + Discord.       | Drill into service detail.   |
| `Zigbee 接收` | The zigbee2mqtt container. Talks to buttons over the radio.                | Drill into service detail.   |
| `事件紀錄`    | Alarm history (button presses, phone calls placed, self-tests).            | Open the history page.       |
| `系統資訊`    | Host health snapshot (uptime, IP, temperature, fan, version).              | Open the system page.        |
| `MQTT 交換`   | The mosquitto container. Sits between Zigbee and the bridge.               | Drill into service detail.   |
| `設定`        | All operator settings: phones, Zigbee pairing, display, WiFi, power.       | Open the settings menu.      |

A green tile with `運作中` means the service is up. A red or amber
tile means it isn't — tap it to see the log and restart options.

## System info (`系統資訊`)

![System info](screenshots/system.png)

The single page that answers "is the kiosk healthy?"

- `mDNS` — internal status indicator; operators can ignore it. The
  kiosk web UI is bound to loopback only, so even when this tile
  shows `已廣播` you cannot reach the kiosk from a phone or laptop
  on the LAN.
- `網際網路` — which interface has internet. A green `外網正常` badge
  means the kiosk can reach the outside world (TCP check to 8.8.8.8).
  A red `外網不通` badge means it cannot — check WiFi/cable first.
  Empty `未取得 IP` means the cable is unplugged or WiFi isn't connected.
- `Discord 心跳` — last successful heartbeat post to Discord. Should
  refresh every 15 minutes. If it shows `已斷線` for an hour or more,
  the kiosk **can't reach Discord** — could be no outbound internet,
  could be Discord itself being unreachable, could be the network
  blocking Discord. Check WiFi first; if WiFi is fine and this tile
  still shows disconnected, raise it for follow-up (snap this card
  when you do).
- `版本資訊` — git commit + NixOS generation + build time. Snap a
  photo when reporting an issue.
- `主機` — uptime, disk usage, CPU throttling counter (`節流` should
  stay at `0x0`; anything else means thermal or undervoltage events).
- `即時狀態` — CPU temp + fan RPM. Anything over 65°C is unusual for
  this device; the kiosk will start warning above that.

Bottom-right `回主頁` returns to the home screen. Every sub-page has
a back arrow in that corner.

## Alarm history (`事件紀錄`)

![Alarm history](screenshots/log.png)

Reverse chronological list of alarm events.

- Red dot + `急救按鈕被按下` — a real button press.
- Red dot + `已撥出緊急電話` — the phone callout fired (lines up
  with the press above it).
- Blue dot + `按鈕自我測試` — a self-test press (e.g. weekly check).

`清除紀錄` wipes only the kiosk's local cache — the underlying
journald log is preserved, so the original record stays recoverable.

## Drill into a service (`緊急通報` / `Zigbee 接收` / `MQTT 交換`)

![Service detail — alarm-bridge](screenshots/service-alarm-bridge.png)

Live tail of the last 50 journal lines on the left, ops buttons on
the right.

- `重啟` — restart the service. Use when a tile shows red on the
  home screen, or when a known-good button isn't triggering.
- `停止` — stop the service. **Rarely useful** for an operator;
  stopping `緊急通報` means the next button press will not place a
  phone call. Confirm before tapping.

Errors are tinted red, warnings amber. **Amber lines are usually
fine to ignore** as long as the service's tile on the home screen
is green. If you don't recognize what a line means, snap the screen
for your report.

## Settings (`設定`)

![Settings menu](screenshots/settings.png)

| Tile         | What it does                                                            |
| ------------ | ----------------------------------------------------------------------- |
| `通知電話`   | Manage the list of phone numbers that get called when a button fires.   |
| `Zigbee`     | Pair a new button, view paired devices.                                 |
| `顯示`       | Screen brightness.                                                      |
| `網際網路`   | WiFi + wired status, scan and join networks.                            |
| `機器操作`   | Reboot, power off, run self-tests.                                      |
| `回主頁`     | Back.                                                                   |

### Manage callout phones (`通知電話`)

![Phone list](screenshots/settings-phone.png)

Tap a number to edit it. Trash-can icon deletes it. `新增號碼` adds
a new one. Use the on-screen numeric keypad — no physical keyboard
needed.

Numbers are dialed in the order shown. The TAS service places real
phone calls under the registered account; **double-check before
saving** — there is no per-press confirm step when an alarm fires.

#### Phone presets (`預設號碼組`)

The `預設號碼組` button (top-right of the phone page) opens a preset
manager for shift rotation — different shifts may need different call
lists.

- **Apply a preset**: tap the preset row. The numbers are loaded
  immediately and you return to the phone list.
- **Edit a preset**: tap the pencil icon. The editor mirrors the main
  phone page (add/remove/reorder numbers). Tap the preset name at the
  top of the editor to rename it.
- **Delete a preset**: tap the trash icon, then confirm in the dialog.
- **Add a new preset**: tap `新增預設`. A default name is generated
  automatically; you can rename it later from the editor.

Presets are saved on the device and persist across reboots. Applying
a preset overwrites the current phone list — the old list is not
saved automatically, so create a preset for it first if you want to
switch back later.

### Connect to WiFi (`網際網路`)

![Internet settings](screenshots/settings-internet.png)

Three tiles:

- `有線網路` — current ethernet state. `未插上網路線` means no cable;
  plug in a cable and it auto-connects (no password needed).
- `WiFi` — current WiFi state and SSID.
- `搜尋 WiFi` — scan for networks. Tap a result, enter the password
  with the on-screen keyboard, tap `加入`. The kiosk remembers the
  network across reboots.

If you change the WiFi router or its password, come here first —
the kiosk does **not** auto-fall-back to "hotspot mode," and a
disconnected kiosk cannot place callouts.

### Pair a new button (`Zigbee`)

![Zigbee settings](screenshots/settings-zigbee.png)

1. Tap `開啟配對` — the device opens a 60-second pairing window
   (shown in the countdown).
2. On the new Zigbee button, **hold the pair button** until the LED
   blinks rapidly. (Different button models have different gestures
   — refer to the button's own card.)
3. The middle tile `已配對裝置` increments and the new device
   appears in the list. Tap that tile to verify.
4. If pairing fails, tap `重新整理` to force the coordinator to
   re-scan its current device list — useful after a reset.

`協調器 已連線` is the green badge on the left. If it's red, Zigbee
is offline and pairing will never succeed — go to home → `Zigbee 接收`
service drill-down and restart it first.

### Reboot / power off / self-tests (`機器操作`)

![Machine menu](screenshots/settings-machine.png)

| Tile           | What it does                                                                      |
| -------------- | --------------------------------------------------------------------------------- |
| `健康檢查`     | Runs `alarm-doctor` — battery / pairing / MQTT sanity checks. No calls placed.    |
| `煙霧測試`     | Opens a picker dialog — choose which leg to test (see below). **Not a routine check**, use only when troubleshooting. |
| `重新開機`     | Soft reboot. Comes back in ~45s.                                                  |
| `關機`         | Power off. The kiosk does **not** auto-power-on; press the white rubber button on the enclosure to turn it back on (or pull/replug power). |
| `回設定`       | Back.                                                                             |

#### `煙霧測試` — three targets

Tapping `煙霧測試` does **not** immediately do anything; it opens a
target picker:

![Smoke picker dialog](screenshots/smoke-dialog.png)

Three options:

- `📞 TAS（真實撥號）` — **places a real emergency phone call to
  every number in `通知電話`**. Most destructive option, costs you
  real call charges; warn everyone on the list before tapping.
- `💬 Discord` — sends a test message to both the USER and SYSTEM
  Discord channels. Does not place calls or touch Zigbee.
- `📡 Zigbee` — simulates a Zigbee button event and verifies the
  MQTT pipeline (**does not** fire a TAS call). **While this runs,
  the `Zigbee 接收` tile on the home screen turns red temporarily**
  (shown below); it returns to green automatically when the test
  finishes.

![Home with Zigbee tile in test state](screenshots/home-zigbee-red.png)

The first line of the dialog (`測試期間 alarm-bridge 會暫停`) is
expected — to keep the simulated event from accidentally dialing out,
the main `緊急通報` service is paused for the duration of the test
and automatically resumes when it ends.

If `健康檢查` is green, you usually don't need to run any of these.
Smoke is a directed troubleshooting tool, not a routine check.

## Edge glow

When an event happens, a colored halo overlays the entire viewport
edge so you notice from peripheral vision (no need to stare at the
screen). Only two:

- **Red glow + red triangle badge top-right** — an emergency call
  was just placed. Lasts ~15 s.

![Edge glow — alarm](screenshots/edge-glow-alarm.png)

- **Green glow + green check badge top-right** — a self-test press
  was just received (no call placed). Lasts ~5 s.

![Edge glow — selftest](screenshots/edge-glow-selftest.png)

The glow itself is informational — nothing to do. Red means a call
did fire just now (cross-check with `事件紀錄`). Green means a
self-test button was received.

Thermal warnings do **not** appear on the edge glow. The home-screen
`系統資訊` tile turns amber when CPU temperature exceeds 65 °C — that
is the thermal indicator.

## Common operator playbook

### "An alarm fired but I'm not sure if anyone got called."

→ `事件紀錄`. Look for a red-dot `已撥出緊急電話` row directly after
the `急救按鈕被按下` row. Same timestamp = call placed. If the press
row exists but no call row follows, the callout failed; drill into
`緊急通報` from the home screen and check the journal tail.

### "Home screen shows a red tile."

→ Tap the red tile. Read the last few log lines. Tap `重啟`. Wait
~10s. The tile should turn green. If it stays red, snap the screen
for your report.

### "Discord stopped showing heartbeats."

→ `系統資訊` → `Discord 心跳` shows `已斷線`. Most common cause is
WiFi — go to `設定` → `網際網路` and check the WiFi tile first. If
WiFi is fine but Discord still won't reconnect, drill into
`緊急通報` and tap `重啟`. Still stuck after that → raise it for
follow-up (could be Discord itself, or the router blocking Discord;
snap the screen when reporting).

### "I'm doing a routine check."

Weekly: tap `機器操作` → `健康檢查`. Look for green-ticks. That's
it for routine — `煙霧測試` is not a routine check, only run it
against a specific leg when something looks wrong (Zigbee target
for unresponsive buttons, Discord target for missing notifications,
TAS target only when you genuinely need to verify the call path).

## What this manual deliberately doesn't cover

- SSH into the device, journal grep, `nixos-rebuild` — out of scope.
- Editing the flake, deploying new versions — out of scope.
- Hardware swap (SD card, DSI panel) — out of scope; see
  `runbook-sd-compromise.md` if the SD card is suspected stolen.

If something on the kiosk looks wrong and isn't covered by a tile in
this manual, **snap the screen and report it**. Do not pull SD cards
and do not power-cycle repeatedly.
