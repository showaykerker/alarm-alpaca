# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository context

Single-purpose flake for the **alarm-alpaca** kiosk: a Raspberry Pi 5 + 5" DSI touchscreen running a podman-hosted Zigbee2MQTT stack, a FastAPI control-plane backend, a Vite/React kiosk frontend, and an alarm-bridge daemon that forwards Zigbee button actions to a TAS phone-callout REST API + Discord webhook.

Previously a fork of `nvmd/nixos-raspberrypi` with the kiosk app vendored under `app/`. The fork's upstream-mirroring scope (lib/modules/overlays/pkgs/devshells) was extracted out of the working tree on migration; the repo now consumes `nixos-raspberrypi` as a flake input. The deprecated tree is parked at `../alarm-alpaca-deprecated/` (local-only, no remote moved).

The input pins (`nixpkgs` rev `0c88e1f`, `nixos-raspberrypi` rev `8092648`) reproduce the deprecated repo's `nixosConfigurations.alarm-alpaca` toplevel drvPath bit-for-bit — verified at migration time. Bump both inputs together when you actually want a newer image; the cachix mirror only stores natively-built aarch64 paths, so a `nix flake update` invalidates every cache entry until the new image rebuilds.

## Common commands

```bash
nix develop                            # devshell: nil, nixfmt-tree, nom, shellcheck, gh
nix fmt .                              # format all nix files (nixfmt-tree)
nix flake check                        # evaluate flake + deploy checks
nix eval --raw .#nixosConfigurations.alarm-alpaca.config.system.build.toplevel.drvPath
                                       # cheap eval-only sanity check (no build)
nix build .#nixosConfigurations.alarm-alpaca.config.system.build.toplevel
                                       # build the deploy target locally (aarch64; uses cachix)
nix run github:serokell/deploy-rs -- .#alarm-alpaca --skip-checks
                                       # deploy to the running RPi (deploy-rs is NOT in devShell)

# App dev shell (Python + Node for working on app/ code directly):
cd app && nix develop
```

## Architecture

### Flake outputs (`flake.nix`)
- `nixosConfigurations.alarm-alpaca` — only host config. Built via `nixos-raspberrypi.lib.nixosSystem` (the helper from the upstream input, which prepends the RPi overlays + trusted-caches module). The inline `kiosk-config` and `custom-user-config` modules carry the shared host policy; the app modules under `./app/*.nix` are imported one by one.
- `deploy.nodes.alarm-alpaca` — deploy-rs target. `remoteBuild = true` (RPi builds locally, fetching aarch64 from the nixos-raspberrypi cachix). Cross-compiling on x86_64 would invalidate cache hits because `buildPlatform` propagates into every derivation hash.
- `devShells.<system>.default` — root tooling shell (nil, nixfmt-tree, nom, shellcheck, gh). The `shellHook` wires `core.hooksPath = scripts/git-hooks` so the secrets-guard pre-commit fires.
- `formatter` — `nixfmt-tree`.

There is no `installerImages` output here — the SD-image build lives in the deprecated repo. When a fresh card is needed, build it from there, then deploy this flake to the running device.

### App modules (`app/`)
- `alarm-bridge.nix` — systemd unit running `app/scripts/main.py`. `EnvironmentFile=` reads `/etc/secrets/alarm-bridge.env` at start time (file populated outside the store via activation script). One activation-time TAS_PHONES seed on first deploy.
- `kiosk-ui.nix` — FastAPI uvicorn unit + `buildNpmPackage` of the frontend (lock file = `app/kiosk-ui/frontend/package-lock.json`; bumping deps requires regenerating it and letting the nix build fail once to capture the new `npmDepsHash`). HTTP Basic password provisioned to `/etc/kiosk-ui/password` (0600). Sudoers entries for eng-mode endpoints (podman, nix-env, nix-collect-garbage, switch-to-configuration) use `/run/current-system/sw/bin/` paths — never `${pkgs.*}` (remoteBuild cross-arch hash mismatch). Phone presets persisted to `/var/lib/kiosk-ui/phone-presets.json`.
- `kiosk-display.nix` — `services.cage` + chromium pointed at the loopback FastAPI. `Restart=always` catches crashes / stray Alt+F4, but `RestartIfChanged=false` means deploy doesn't restart cage — URL/flag changes still need `sudo systemctl restart cage-tty1.service` on the device. `cage-rotate-dsi.service` uses `partOf = [ "cage-tty1.service" ]` so rotation re-fires automatically on every cage restart. `cage-touch-recalibrate.service` re-triggers Goodix udev before cage opens the touchscreen.
- `alarm-doctor.nix` — per-button maintenance jobs exposed to the kiosk Machine page (battery check, pairing reset, MQTT replay). Network section runs layered diagnostics: interface IP/gateway → WiFi signal → gateway ping → TCP 8.8.8.8:53 → DNS resolution (TAS + Discord) → diagnosis summary. Services section shows failed-service journal lines + ActiveEnterTimestamp for running services. MQTT section checks z2m bridge/state before bridge/devices.
- `zigbee.nix` — podman containers for mosquitto + zigbee2mqtt. `TZ=Asia/Taipei` set explicitly because podman doesn't inherit host TZ.
- `alarm-alpaca-host.nix` — SD filesystem layout (`/dev/disk/by-label/{NIXOS_SD,FIRMWARE}`), `system.stateVersion`.
- `alarm-alpaca-runtime.nix` — shared runtime config between deploy target and SD-image installer: `nixos` user (wheel + networkmanager + podman), kiosk-ui LAN exposure flag (`exposeToLan = false`). Separated from `alarm-alpaca-host.nix` because the installer image gets its own `fileSystems."/"` from `sdimage-installer`.
- `hardware-display.nix` — DSI ILI9881 5-inch panel rotation overlay (rotation 270 for the physical mounting).
- `networking.nix` — NetworkManager + avahi mDNS. No declarative WiFi profile: bootstrap via ethernet, then add WiFi from the kiosk Network page; nmcli persists to `/etc/NetworkManager/system-connections`. `podman0` excluded from avahi publish.
- `flake.nix` — per-app devshell (python313 + httpx + paho-mqtt + anyio + python-dotenv + fastapi + uvicorn, plus nodejs_20 for the frontend lock-file workflow). Kept separate so the Python toolchain doesn't bloat the host image's eval.

### Backend / frontend layout
- `app/kiosk-ui/backend/` — FastAPI app. `main.py` mounts the built frontend bundle (path injected by `kiosk-ui.nix`) and registers routers under `routes/` (network, wifi, services, logs, system, kiosk, alarm, dashboard, zigbee, eng). Phone preset CRUD endpoints and persistence also in `main.py`. `auth.py` bypasses HTTP Basic for loopback so the on-device chromium kiosk doesn't need the password.
- `app/kiosk-ui/backend/routes/eng.py` — engineering mode endpoints under `/api/eng/*`: zigbee devices/bridge, MQTT live stream (SSE with 60s auto-close), alarm-bridge stats/journal, system network/containers/SD-health/throttle-history, deploy status/generations/switch/cleanup.
- `app/kiosk-ui/frontend/` — Vite + React + TypeScript. Touch-only primitives (`NumericKeypad`, `OnScreenKeyboard`, `PullToRefresh`); shadcn-ish `components/ui/`; pages mirror the backend routers. `useKioskEvents.ts` subscribes to `/api/events` (SSE) for live service / WiFi / pairing state. Pages under `pages/config/` (Phone, Machine, Internet, Zigbee, Display) are settings subpages. `pages/Engineering.tsx` — 4-tab engineering mode (Zigbee, 通訊, 系統, 部署), accessed via 20-tap easter egg on Machine page. `pages/config/Phone.tsx` includes phone-number presets with phase-based dialog state machine for shift rotation.
- `app/scripts/` — alarm-bridge Python: `mqtt_connection.py` (paho-mqtt with reconnect backoff), `message_handler.py` (debounce filter), `tas_client.py` (httpx async TAS REST), `discord_notifier.py` (webhook embeds), `config.py` + `logger/` (env-driven config + rotating logger). `smoke/{tas,discord,zigbee}_smoke.py` are run-from-prod harnesses that systemd-run with the live `EnvironmentFile=`; they fail loudly if a required env key is missing.

### Secrets handling
- `secrets/` is gitignored. Files inside it (`secrets/kiosk-password`, `secrets/alarm-bridge.env`) are registered as `git add -N -f` (intent-to-add, forced because gitignored) so Nix flake evaluation can read them via `lib.fileContents`. Their content never enters commits.
- `scripts/git-hooks/pre-commit` blocks any commit that stages a file under `secrets/`. The devShell `shellHook` sets `core.hooksPath` to `scripts/git-hooks/` on `nix develop`. Before running `git commit` outside the devShell, run `git config core.hooksPath scripts/git-hooks` manually — otherwise the guard is silent.
- The kiosk-ui HTTP Basic password lands in `/nix/store` at build time (world-readable) and is copied 0600 to `/etc/kiosk-ui/password` via activation. Acceptable for a single-user kiosk where physical SD access already wins. The alarm-bridge `.env` is loaded by systemd `EnvironmentFile=` and never enters the store.

### Deploy
- `nix run github:serokell/deploy-rs -- .#alarm-alpaca --skip-checks`. Builds + activates `nixosConfigurations.alarm-alpaca` on the running RPi. `deploy-rs` is NOT in the devShell — always use `nix run`.
- `sshUser = "nixos"` (deploy-rs would default to host username otherwise).
- Use `--skip-checks` — deploy-rs checks require evaluating the full closure which is slow on the RPi. Without it, deploy routinely times out.
- **cage doesn't auto-restart on deploy** (`RestartIfChanged=false`): changes to `kioskUrl` / chromium flags in `app/kiosk-display.nix` produce a new unit definition but the running cage process keeps the old args until `sudo systemctl restart cage-tty1.service` on the device. Cage DOES auto-restart on crashes (Restart=always), and `cage-rotate-dsi` + `cage-touch-recalibrate` re-fire automatically via `partOf`/`wantedBy`.
- After frontend changes, verify by SSH + curl before iterating. If the kiosk shows stale UI after cage restart, clear Chromium cache: `rm -rf /home/nixos/.config/chromium/Default/{Cache,Code\ Cache,Service\ Worker}` then restart cage.
- Never run deploy in Claude background tasks — risks leaving nix store locks that require `nix-daemon` restart.

## CI

No CI in this repo. The deprecated repo had a `nix fmt --ci` job; if that's wanted back, copy `.github/workflows/ci.yaml` from there.

## Conventions

- `nix fmt` is enforced manually (no hook here yet).
- Only `aarch64-linux` is supported for the hardware output; `allSystems` is used only for `formatter` and `devShells`.
- Never `git add -A` / `git commit -a` blindly — the pre-commit hook blocks `secrets/`, but the intent-to-add workflow assumes you stage files explicitly by name.
- Bumping `nixpkgs` or `nixos-raspberrypi` together is fine; bumping one without the other risks dropping out of cache coverage.
