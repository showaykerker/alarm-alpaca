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
          # Shared kiosk config — currently used only by the alarm-alpaca
          # deploy target. Mirrors the layout the deprecated upstream-fork
          # repo had so app-layer derivations hash the same.
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
                  # mkForce: the upstream image-installer module sets this
                  # to "yes" so the recovery shell is reachable. Lock it
                  # down to key-only on the nixos user — root never logs in.
                  PermitRootLogin = lib.mkForce "no";
                };
              };

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
            ];
          };
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
