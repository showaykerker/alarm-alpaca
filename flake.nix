{
  description = "alarm-alpaca — Raspberry Pi 5 emergency-button kiosk";

  nixConfig = {
    extra-substituters = [
      "https://nixos-raspberrypi.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nixos-raspberrypi.cachix.org-1:4iMO9LXa8BqhU+Rpg6LQKiGa2lsNh/j2oiYLNOQ5sPI="
    ];
    connect-timeout = 5;
  };

  inputs = {
    # Pinned to the nixpkgs rev the deprecated upstream-fork repo had in
    # its flake.lock — keeps app-layer derivation hashes byte-identical
    # across the repo migration. `nix flake update nixpkgs` to advance.
    nixpkgs.url = "github:NixOS/nixpkgs/0c88e1f2bdb93d5999019e99cb0e61e1fe2af4c5";

    nixos-raspberrypi = {
      # Pinned to the upstream merge-base of the deprecated repo
      # (`git merge-base main upstream/main` at migration time). The
      # deprecated repo had 11 fork-side commits on top of this, but
      # only `4472a77` (cross-compile fix) touched anything outside
      # app/, and that one lives in flake.nix here — not consumed
      # through nixos-raspberrypi.
      url = "github:nvmd/nixos-raspberrypi/8092648247da085d42aee356b8e2146f6f0abaa5";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # SD-image installer module set used by `nixosConfigurations.rpi5-installer`
    # / `installerImages.rpi5`. Pinned to the same fork branch the deprecated
    # repo used so the installer drvPath matches what we built before. The
    # `nixos-raspberrypi.lib.nixosInstaller` helper expects
    # `nixos-images.nixosModules.sdimage-installer` to be passed in by the
    # caller (us) — it isn't pulled implicitly through the rpi flake.
    nixos-images = {
      url = "github:nvmd/nixos-images/sdimage-installer";
      inputs.nixos-stable.follows = "nixpkgs";
      inputs.nixos-unstable.follows = "nixpkgs";
    };

    deploy-rs = {
      url = "github:serokell/deploy-rs";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixos-raspberrypi,
      nixos-images,
      deploy-rs,
      ...
    }@inputs:
    let
      allSystems = nixpkgs.lib.systems.flakeExposed;
      forSystems = systems: f: nixpkgs.lib.genAttrs systems (system: f system);
    in
    {
      formatter = forSystems allSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      devShells = forSystems allSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            name = "alarm-alpaca";
            nativeBuildInputs = with pkgs; [
              nil
              nixfmt-tree
              nix-output-monitor
              bash-language-server
              shellcheck
              gh
            ];
            shellHook = ''
              # Route git hooks to the repo-tracked scripts/git-hooks/ so the
              # pre-commit guard against committing secrets/ is always active.
              if [ -d .git ] && [ "$(git config core.hooksPath)" != "scripts/git-hooks" ]; then
                git config core.hooksPath scripts/git-hooks
                echo "[shellHook] set core.hooksPath = scripts/git-hooks"
              fi
            '';
          };
        }
      );

      nixosConfigurations =
        let
          # Installer helper. We deliberately use `nixos-raspberrypi.lib.nixosSystem`
          # (the narrow-overlay path) and re-inject the two installer-specific
          # modules ourselves, instead of using upstream's `nixosInstaller`
          # helper. Reason: `nixosInstaller` pulls in the
          # `full-nixos-raspberrypi-config` module, which sets
          # `nixpkgs.overlays = lib.mkBefore [ self.overlays.pkgs ]` globally.
          # Upstream's own comment on that overlay reads:
          #   "!!! causes _lots_ of rebuilds for graphical stuff via
          #    ffmpeg, pipewire"
          # — chromium / gstreamer / pipewire / ffmpeg all get rehashed,
          # which means cachix misses on every one of them and the build
          # spends hours qemu-emulating chromium on x86. The deploy target
          # uses `nixosSystem` (narrow `default-nixos-raspberrypi-config`)
          # and substitutes cleanly; matching that here keeps the installer
          # closure cache-compatible with what's already on the device.
          #
          # The `sd-image` + `raspberrypi-installer.nix` modules
          # `nixosInstaller` was implicitly adding are added explicitly
          # below.
          mkNixOSRPiInstaller =
            modules:
            nixos-raspberrypi.lib.nixosSystem {
              specialArgs = inputs // {
                nixos-raspberrypi = nixos-raspberrypi;
              };
              modules = [
                nixos-raspberrypi.nixosModules.sd-image
                "${nixos-raspberrypi}/modules/installer/raspberrypi-installer.nix"
                nixos-images.nixosModules.sdimage-installer
                (
                  {
                    config,
                    lib,
                    modulesPath,
                    ...
                  }:
                  {
                    disabledModules = [
                      # disable the sd-image module that nixos-images uses
                      (modulesPath + "/installer/sd-card/sd-image-aarch64-installer.nix")
                    ];
                    # nixos-images sets this with `mkForce`, thus `mkOverride 40`
                    image.baseName =
                      let
                        cfg = config.boot.loader.raspberry-pi;
                      in
                      lib.mkOverride 40 "nixos-installer-rpi${cfg.variant}-${cfg.bootloader}";
                  }
                )
              ]
              ++ modules;
            };

          # Shared kiosk config — used by the alarm-alpaca deploy target and
          # the rpi5-installer image. Mirrors the layout the deprecated
          # upstream-fork repo had so app-layer derivations hash the same.
          kiosk-config = (
            {
              config,
              pkgs,
              lib,
              nixos-raspberrypi,
              ...
            }:
            {
              imports =
                (with nixos-raspberrypi.nixosModules; [
                  # Hardware configuration
                  raspberry-pi-5.base
                  raspberry-pi-5.page-size-16k
                  raspberry-pi-5.display-rp1 # RP1-connected DSI/MIPI display (RPi5 official Touch Display)
                  raspberry-pi-5.bluetooth
                ])
                ++ [
                  ./app/hardware-display.nix
                  ./app/networking.nix
                ];

              nixpkgs.overlays = [
                (_: prev: {
                  # wireplumber docs/meson.build has unconditional lxml check at line 14;
                  # must remove subdir('docs') entirely — pattern handles both quote styles
                  wireplumber = prev.wireplumber.overrideAttrs (old: {
                    mesonFlags = (lib.filter (f: f != "-Ddoc=enabled") (old.mesonFlags or [ ])) ++ [ "-Ddoc=disabled" ];
                    postPatch = (old.postPatch or "") + ''
                      sed -i '/subdir.*docs/d' meson.build
                    '';
                  });
                })
              ];

              networking.hostName = "alarm-alpaca";

              # All logs, heartbeats, journalctl output, and Discord posts use
              # local wall-clock time (matches the room the device sits in,
              # which is in Taiwan). Containers (mosquitto/zigbee2mqtt) already
              # set TZ=Asia/Taipei explicitly in zigbee.nix.
              time.timeZone = "Asia/Taipei";

              # SD-card wear mitigation. journald default is unbounded
              # SystemMaxUse and fsync every 30s; on a kiosk that runs for
              # years the steady write load (heartbeats, MQTT reconnects,
              # occasional container restart spam) accumulates. Cap total
              # journal size and batch fsyncs to ~5min so writes coalesce.
              services.journald.extraConfig = ''
                SystemMaxUse=200M
                SyncIntervalSec=5min
              '';

              services.openssh = {
                enable = true;
                settings = {
                  PasswordAuthentication = false;
                  # Explicit defence-in-depth: NixOS default is `false`, but
                  # sshd still advertises `keyboard-interactive` in its
                  # method list unless we set it here. Setting both makes
                  # the auth surface unambiguously pubkey-only.
                  KbdInteractiveAuthentication = false;
                  # mkForce: the upstream image-installer module sets this
                  # to "yes" so the recovery shell is reachable. Lock it
                  # down to key-only on the nixos user — root never logs in.
                  PermitRootLogin = lib.mkForce "no";
                };
              };

              # Block console foothold via USB keyboard. The kiosk-display
              # module already disables `getty@tty1.service` so cage owns the
              # seat, but NixOS' default `autovt@.service` template would
              # still spawn a getty on tty2..tty6 the moment someone hits
              # Ctrl+Alt+F2 with a USB keyboard attached.
              #
              # Two layers:
              #   1. NAutoVTs=0 + ReserveVT=0 tell systemd-logind not to
              #      reserve or spin up any autovt slot. This is the
              #      authoritative kill — without an autovt the VT switch
              #      lands on a black tty with no agetty.
              #   2. Belt-and-suspenders: also disable the static
              #      getty@tty{2..6} unit instances in case something
              #      (recovery image, future module addition) re-enables
              #      autovt globally. Disabling a not-yet-instantiated
              #      template instance is a no-op, which is fine.
              services.logind.settings.Login = {
                NAutoVTs = 0;
                ReserveVT = 0;
              };
              systemd.services."getty@tty2".enable = false;
              systemd.services."getty@tty3".enable = false;
              systemd.services."getty@tty4".enable = false;
              systemd.services."getty@tty5".enable = false;
              systemd.services."getty@tty6".enable = false;

              # Force the `nixos` account to a locked password. The user is
              # ssh-key-only by design (PasswordAuthentication=false above),
              # but `users.users.nixos` declares no `hashedPassword`/
              # `initialPassword`, so on a mutableUsers=true system someone
              # could `sudo passwd nixos` (or the upstream image's first-
              # boot prompt could set one) and inadvertently open a console
              # login path on top of the VT lockdown above. `!` is the
              # canonical "no valid password" sentinel — passwd refuses to
              # match it for either local login or `su`.
              users.users.nixos.hashedPassword = "!";

              # nixos user has no password; wheel must not require one for sudo to work
              security.sudo.wheelNeedsPassword = false;
            }
          );

          custom-user-config = (
            {
              config,
              pkgs,
              lib,
              nixos-raspberrypi,
              self,
              ...
            }:
            {

              users.users.nixos.openssh.authorizedKeys.keys = [
                "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHKXnS/8wQXuVCeqpjprVRNcJzvPjDXiVut5zUjDvcZS zack@53-0A90285-01"
              ];

              nix.settings.trusted-users = [
                "root"
                "@wheel"
              ];

              environment.systemPackages = with pkgs; [
                tree
                git
                vim
                htop
              ];

              # Surface the flake's git rev to userspace so the kiosk 版本資訊
              # card can show "which commit is on this device". `dirtyRev`
              # carries a `-dirty` suffix when the working tree had uncommitted
              # changes at deploy time — exactly the signal we want on the card.
              system.configurationRevision = self.rev or self.dirtyRev or null;

              # NixOS upstream does NOT write `system.configurationRevision`
              # anywhere readable from userspace — only `nixos-version` is
              # dropped into the toplevel store path. Mirror it to /etc so the
              # kiosk backend can read it without poking nix internals.
              environment.etc."configuration-revision" = lib.mkIf (config.system.configurationRevision != null) {
                text = config.system.configurationRevision;
              };

              system.nixos.tags =
                let
                  cfg = config.boot.loader.raspberry-pi;
                in
                [
                  "raspberry-pi-${cfg.variant}"
                  cfg.bootloader
                  config.boot.kernelPackages.kernel.version
                ];
            }
          );

        in
        {
          # SD-image installer for first-boot provisioning of a fresh card.
          # Bakes the full kiosk stack (zigbee/alarm-bridge/alarm-doctor/
          # kiosk-ui/kiosk-display + alarm-alpaca-runtime) so a freshly
          # flashed card boots straight into the running kiosk with no
          # separate deploy step. The on-device SD filesystem layout
          # (`alarm-alpaca-host.nix`) is deliberately omitted — the
          # installer's `/` and `/boot/firmware` come from
          # `nixos-images.nixosModules.sdimage-installer` and would
          # otherwise collide.
          #
          # Native aarch64 build (no `nixpkgs.buildPlatform = x86_64-linux`
          # override): cross-compilation breaks `libcamera-rpi` (the
          # nixos-raspberrypi overlay's meson subproject for `libpisp`
          # can't be located under cross), which knocks out the cage →
          # wireplumber → pipewire chain. Building native aarch64 hits the
          # nixos-raspberrypi cachix for the heavy hardware bits and only
          # emulates the small app-layer derivations (kiosk-ui frontend
          # npm build, alarm-bridge python wrap) under host binfmt
          # qemu-aarch64.
          rpi5-installer = mkNixOSRPiInstaller [
            kiosk-config
            custom-user-config
            ./app/alarm-alpaca-runtime.nix
            ./app/zigbee.nix
            ./app/alarm-bridge.nix
            ./app/alarm-doctor.nix
            ./app/kiosk-ui.nix
            ./app/kiosk-display.nix
          ];

          # Deploy target for the running RPi5 — used with deploy-rs.
          # Native aarch64 build only (no nixpkgs.buildPlatform override):
          # the nixos-raspberrypi cachix mirror only stores natively-built
          # aarch64 paths, so cross-compiling would invalidate every cache
          # entry. Build on the RPi itself via deploy-rs remoteBuild=true.
          alarm-alpaca = nixos-raspberrypi.lib.nixosSystem {
            specialArgs = inputs // {
              nixos-raspberrypi = nixos-raspberrypi;
            };
            modules = [
              kiosk-config
              custom-user-config
              ./app/zigbee.nix
              ./app/alarm-bridge.nix
              ./app/alarm-doctor.nix
              ./app/kiosk-ui.nix
              ./app/kiosk-display.nix
              ./app/alarm-alpaca-host.nix
              ./app/alarm-alpaca-runtime.nix
              # Not added to rpi5-installer — first-boot image doesn't need
              # to nag about CVEs before the device is provisioned.
              ./app/cve-monitor.nix
            ];
          };
        };

      # SD-image artifacts. `nix build .#installerImages.rpi5` produces a
      # zstd-compressed .img under `<out>/sd-image/`. Used for fresh-card
      # provisioning only; the deploy target is updated via deploy-rs, not
      # by reflashing.
      installerImages =
        let
          nixos = self.nixosConfigurations;
          mkImage = cfg: cfg.config.system.build.sdImage;
        in
        {
          rpi5 = mkImage nixos.rpi5-installer;
        };

      deploy.nodes.alarm-alpaca = {
        hostname = "alarm-alpaca.local";
        sshUser = "nixos";
        profiles.system = {
          user = "root";
          # Build on the RPi itself so aarch64 packages are fetched from
          # the binary cache rather than (re)built on x86_64. The
          # nixos-raspberrypi cachix only mirrors natively-built aarch64
          # paths, so flipping this to false either pays for qemu-user
          # emulation locally or — if cross-compile were enabled — would
          # blow past every cache entry.
          remoteBuild = true;
          path = deploy-rs.lib.aarch64-linux.activate.nixos self.nixosConfigurations.alarm-alpaca;
        };
      };

      checks = builtins.mapAttrs (_: deployLib: deployLib.deployChecks self.deploy) deploy-rs.lib;
    };
}
