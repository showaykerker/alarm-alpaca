# alarm-alpaca

## What it is

A Raspberry Pi 5 + 5" DSI touchscreen kiosk that runs Zigbee2MQTT (under
podman), a FastAPI control-plane backend with a React/Vite frontend
(displayed by chromium under cage), and an alarm-bridge daemon that
forwards Zigbee button presses to a TAS phone-callout REST API and a
Discord webhook. The whole system is one NixOS flake deployed via
deploy-rs.

Operator-facing manual for the touchscreen UI (繁體中文):
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## Hardware

- Raspberry Pi 5
- 5" DSI panel (ILI9881), rotated 270° for the physical mounting
- Zigbee USB dongle (driven by zigbee2mqtt in podman)

## Architecture

```
        Zigbee buttons
              |
              v
  +--------------------------+        +---------------------+
  | mosquitto + zigbee2mqtt  | -----> |     alarm-bridge    | --> TAS REST (phone callout)
  |       (podman)           |  MQTT  |  (app/scripts/...)  | --> Discord webhook
  +--------------------------+        +---------------------+
              ^                                  ^
              | MQTT                             | journal / state
              |                                  |
  +--------------------------+        +---------------------+
  |   chromium (under cage)  | -----> |   FastAPI backend   |
  |     on-device kiosk      |  HTTP  |  (kiosk-ui/backend) | --> systemd units
  +--------------------------+        +---------------------+ --> nmcli (WiFi)
                                                              --> MQTT (z2m permit-join)
```

## Repo layout

```
flake.nix                   Single host: nixosConfigurations.alarm-alpaca + deploy node
flake.lock
secrets/                    Gitignored; intent-to-add lets Nix read at eval time
  alarm-bridge.env          systemd EnvironmentFile for the bridge
  kiosk-password            HTTP Basic password for the kiosk UI
scripts/
  git-hooks/pre-commit      Blocks any commit that stages files under secrets/
app/
  flake.nix                 Per-app devshell (python313 + node_20)
  alarm-alpaca-host.nix     SD filesystem layout (NIXOS_SD / FIRMWARE labels)
  alarm-alpaca-runtime.nix  nixos user, podman, kiosk-ui LAN exposure, stateVersion
  hardware-display.nix      DSI ILI9881 rotation overlay
  networking.nix            NetworkManager + avahi (no declarative WiFi)
  zigbee.nix                podman: mosquitto + zigbee2mqtt (TZ=Asia/Taipei)
  alarm-bridge.nix          systemd unit running app/scripts/main.py
  alarm-doctor.nix          Per-button maintenance + layered network diagnostics
  kiosk-ui.nix              FastAPI uvicorn unit + buildNpmPackage of the frontend
  kiosk-display.nix         services.cage + chromium (Restart=always, partOf rotate)
  kiosk-ui/
    backend/                FastAPI app; main.py mounts built frontend + routes/
      routes/               dashboard, services, logs, wifi, zigbee, kiosk,
                            system, network, alarm, eng
      auth.py               HTTP Basic; loopback is auth-exempt
    frontend/               Vite + React + TypeScript SPA
  scripts/                  alarm-bridge daemon
    main.py                 Entry point
    config.py               Env-driven config
    mqtt_connection.py      paho-mqtt with reconnect backoff
    message_handler.py      Debounce filter
    tas_client.py           httpx async TAS REST client
    discord_notifier.py     Webhook embeds + heartbeat
    logger/                 Rotating logger
    smoke/                  tas/discord/zigbee smoke runners (use prod EnvironmentFile)
```

## Quick start

Root devshell (Nix tooling for the host flake):

```bash
nix develop                            # nil, nixfmt-tree, nom, shellcheck, gh
nix fmt .                              # format all nix files (nixfmt-tree)
nix flake check                        # evaluate flake + deploy checks
nix eval --raw .#nixosConfigurations.alarm-alpaca.config.system.build.toplevel.drvPath
                                       # cheap eval-only sanity check (no build)
nix build .#nixosConfigurations.alarm-alpaca.config.system.build.toplevel
                                       # build the deploy target locally (aarch64)
nix run github:serokell/deploy-rs -- .#alarm-alpaca --skip-checks
                                       # deploy to the running RPi
```

`deploy-rs` is not in the root devShell, so run it via `nix run` —
the devShell's `shellHook` exists only to wire `core.hooksPath` for
the pre-commit secrets guard.

Per-app devshell (Python + Node for working on `app/` code directly):

```bash
cd app && nix develop
```

## Building an SD image

`flake.nix` exposes `installerImages.rpi5` — a bootable SD image that
already has the full kiosk app baked in (alarm-bridge, kiosk-ui backend
+ frontend, kiosk-display, zigbee containers, hardware overlays). Flash
it onto a fresh card, boot the Pi, and the kiosk comes up without any
follow-up deploy.

**The image must be built on aarch64.** Cross-compiling from x86_64
breaks two ways: (a) `buildPlatform` propagates into every derivation
hash and invalidates cachix coverage, (b) the final ext4 image step
runs `mke2fs` under qemu-aarch64 user mode, which traps on the unimp-
lemented `semop` syscall (`mke2fs: semop(1): encountered an error:
Function not implemented`). Build natively on the Pi instead.

### Build on the deployed Pi as a remote builder (recommended)

Lets `nix build` evaluate locally on x86_64 (fast) and dispatch every
derivation to the Pi's `nix-daemon`. The resulting store path is copied
back via `nix copy` automatically.

One-time setup on host:

```bash
# Root SSH key (nix-daemon SSHs out as root for distributed builds):
sudo ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519
sudo ssh-keyscan -H alarm-alpaca.local | sudo tee -a /root/.ssh/known_hosts
sudo cat /root/.ssh/id_ed25519.pub   # install on the Pi:
ssh nixos@alarm-alpaca.local 'cat >> ~/.ssh/authorized_keys'
```

The Pi's `nix.settings.trusted-users` already includes `@wheel`, and
the local user must be in `nix.settings.trusted-users` on the host so
`--builders` can be passed at the CLI.

Build (from repo root):

```bash
nohup nix build .#installerImages.rpi5 \
  --builders 'ssh-ng://nixos@alarm-alpaca.local aarch64-linux /root/.ssh/id_ed25519 4 1 kvm,big-parallel - -' \
  --max-jobs 0 \
  --print-build-logs > /tmp/installer-build.log 2>&1 &
```

`--max-jobs 0` forces everything to the remote builder; the host only
evaluates + orchestrates. Expect ~20-40 min on a Pi 5 for a clean
build (kernel modules + boot partition + ext4 + zstd).

After it finishes, the image is local at
`result/sd-image/nixos-installer-rpi5-kernel.img.zst` (symlinked into
`/nix/store`). Copy it out of the store so a future
`nix-collect-garbage` doesn't delete it:

```bash
mkdir -p images
cp -L --no-preserve=mode \
  result/sd-image/nixos-installer-rpi5-kernel.img.zst \
  images/alarm-alpaca-installer-rpi5.img.zst
chmod 600 images/alarm-alpaca-installer-rpi5.img.zst   # baked secrets
```

`images/` is gitignored.

### Cleaning up the Pi's store after a build

The Pi's `/nix/store` accumulates all the intermediate + final build
paths. None of them are GC roots (the `result` symlink lives on the
host, not the Pi), so a normal collect reclaims everything not pinned
by the running system:

```bash
ssh nixos@alarm-alpaca.local 'sudo nix-collect-garbage'
```

No flake source ever needs to land on the Pi — `--builders` only ships
derivations, not the working tree.

### Flashing

```bash
zstd -d < images/alarm-alpaca-installer-rpi5.img.zst | \
  sudo dd of=/dev/sdX bs=4M status=progress conv=fsync
```

> **WARNING.** The image bakes
> `secrets/alarm-bridge.env` and `secrets/kiosk-password` into
> `/nix/store` (world-readable). Treat `.img.zst` artifacts as
> sensitive: do not upload, share, or flash onto an SD card that will
> leave trusted hands.

## Secrets

`secrets/` is gitignored. The files inside it are registered with
`git add -N -f` (intent-to-add, forced because gitignored) so Nix flake
evaluation can read them via `lib.fileContents`. Their content never
enters commits.

The pre-commit hook at `scripts/git-hooks/pre-commit` rejects any commit
that stages a path under `secrets/`. The root devShell's `shellHook`
wires `core.hooksPath = scripts/git-hooks` automatically. If you commit
outside `nix develop`, set it manually first:

```bash
git config core.hooksPath scripts/git-hooks
```

## Deploy gotchas

- **Use `--skip-checks`** — deploy-rs checks evaluate the full closure,
  which is slow on the Pi and routinely times out without the flag.

- **cage doesn't auto-restart on deploy.** `RestartIfChanged=false`
  means changes to `kioskUrl` or chromium flags produce a new unit
  definition but the running cage keeps the old args. After deploy:

  ```bash
  sudo systemctl restart cage-tty1.service
  ```

  Cage _does_ auto-restart on crashes (`Restart=always`), and
  `cage-rotate-dsi` + `cage-touch-recalibrate` re-fire automatically
  via `partOf`/`wantedBy`.

- **Chromium cache can serve stale bundles.** If the kiosk UI doesn't
  reflect frontend changes after cage restart, clear the cache:

  ```bash
  sudo systemctl stop cage-tty1.service
  rm -rf /home/nixos/.config/chromium/Default/{Cache,Code\ Cache,Service\ Worker}
  sudo systemctl start cage-tty1.service
  ```

- **Sudoers must use `/run/current-system/sw/bin/` paths**, not
  `${pkgs.*}/bin/...`. With `remoteBuild = true`, Nix eval runs on
  x86_64 but the Pi runs aarch64 — different store hashes make
  `${pkgs.*}` sudoers entries silently fail.

- **Bump `nixpkgs` and `nixos-raspberrypi` together.** The cachix mirror
  only stores natively-built aarch64 paths, so any input change
  invalidates every cache entry until the new image rebuilds. Bumping
  only one of the two also risks dropping out of cache coverage.

- **`remoteBuild = true` — never cross-compile from x86_64.** The RPi
  builds locally and fetches aarch64 paths from the
  nixos-raspberrypi cachix. Flipping to cross-compile from x86_64 would
  change `buildPlatform` in every derivation hash and blow past every
  cache entry.

## Network exposure / hardening posture

The deployed image binds every management plane to loopback. This is
the posture that survives an untrusted-LAN cutover; if you ever flip
any of the flags below, re-audit the threat model first
(`runbook-sd-compromise.md` describes the response side; see
`security-review-2026-05-21.md` in the obsidian notes for the prevention
side).

- `app/alarm-alpaca-runtime.nix` sets `services.alarm-kiosk.exposeToLan =
  false` (commit `70c9949`) → `kiosk-ui` (FastAPI uvicorn) binds
  `127.0.0.1:8090` only. The on-device chromium reaches it over
  loopback. No LAN port is opened and the firewall does not allow
  `8090/tcp`. The HTTP Basic password is provisioned for the
  `exposeToLan = true` case; it exists on disk, but no remote process
  can hit the auth challenge.
- `app/zigbee.nix` binds the mosquitto and zigbee2mqtt podman
  containers to `127.0.0.1` only. The alarm-bridge daemon reaches
  MQTT over loopback. No LAN MQTT broker is exposed.
- `app/networking.nix` keeps the firewall closed by default. The
  only externally reachable TCP port is `22/tcp` (SSH), key-only
  because the `nixos` user has no password set.
- `app/kiosk-ui/backend/auth.py` exempts loopback from HTTP Basic so
  the touch UI works without prompting. Any future write endpoint
  added to the backend must require auth that the loopback bypass
  does **not** cover — otherwise any process on the device (including
  an RCE in mosquitto/z2m/alarm-bridge) reaches it for free.

## Known TODOs

- **Finish splitting `flake.nix`** — extract the inline `kiosk-config`
  and `custom-user-config` blocks into per-concern `app/*.nix` files.
