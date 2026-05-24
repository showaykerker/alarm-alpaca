# Kiosk web UI: FastAPI backend + React (Vite + shadcn/ui) frontend.
#
# Two access modes, controlled by services.alarm-kiosk.exposeToLan:
#   false (default) — bind 127.0.0.1 only. Only the on-device Chromium kiosk
#                     can talk to it. Firewall stays closed.
#   true            — bind 0.0.0.0 and open TCP/8080. LAN clients must present
#                     HTTP Basic credentials; loopback (the on-device kiosk)
#                     is exempted in code.
#
# Password comes from ./secrets/kiosk-password — gitignored, intent-to-add,
# same pattern as wifi-psk and alarm-bridge.env. Loaded into the service via
# systemd LoadCredential so the DynamicUser can read it without us inventing
# yet another shared group.
#
# Phones-list write access is the only thing that needs cross-service sharing:
# alarm-bridge owns /etc/alarm-bridge/phones.txt and reads it on every callout;
# kiosk-ui needs to write it from the UI. We bridge them via the
# `alarm-config` group (declared in alarm-bridge.nix) — both DynamicUsers join
# it via SupplementaryGroups.
#
# New pages (Dashboard, Services, Logs, WiFi, Zigbee) require additional access:
#   systemd-journal  — journalctl log reading (logs, dashboard events, services logs)
#   networkmanager   — nmcli WiFi scan and connect
#   NoNewPrivileges  — dropped to allow sudo (see extraRules below)
#   sudo rules       — passwordless systemctl start/stop/restart for the 4 watched units
{
  config,
  pkgs,
  lib,
  ...
}:
let
  cfg = config.services.alarm-kiosk;

  pythonEnv = pkgs.python313.withPackages (ps: [
    ps.fastapi
    ps.uvicorn
    # paho-mqtt: publish permit_join to MQTT for Zigbee pairing,
    # and subscribe to bridge/devices for device count.
    ps.paho-mqtt
    # httpx: POST alarm-doctor result to Discord webhook from
    # /api/alarm/doctor/send-discord.
    ps.httpx
  ]);

  backendSrc = pkgs.runCommand "kiosk-ui-backend" { } ''
    cp -r ${./kiosk-ui/backend} $out
  '';

  # Single React bundle serving both audiences: on-device Chromium kiosk and
  # LAN admin clients. The UI is kiosk-first (dark, oversized, touch-tuned);
  # LAN users get the same visual language. Hash bumps: if you edit
  # package.json, the first build will fail with a hash mismatch — copy the
  # `got:` value from the Nix error into npmDepsHash. (Regenerate locally via
  # `nix run nixpkgs#prefetch-npm-deps -- app/kiosk-ui/frontend/package-lock.json`.)
  frontendDist = pkgs.buildNpmPackage {
    pname = "alarm-alpaca-frontend";
    version = "0.1.0";
    src = ./kiosk-ui/frontend;

    npmDepsHash = "sha256-xVclppBielJbhpVvfpuiyt73zdMwLkRwbyIOb5WNKqA=";

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r dist/. $out/
      runHook postInstall
    '';
  };

  pwFile = pkgs.writeText "kiosk-password" (lib.fileContents ../secrets/kiosk-password);

  bindAddr = if cfg.exposeToLan then "0.0.0.0" else "127.0.0.1";

  # Units kiosk-ui is allowed to manage. Sourced once and propagated to the
  # backend via KIOSK_MANAGED_UNITS so the sudoers rule and the Python
  # allowlist can't drift — the Python side used to hardcode the same list,
  # which silently broke if this set ever changed.
  managedUnits = [
    "alarm-bridge.service"
    "kiosk-ui.service"
    "podman-mosquitto.service"
    "podman-zigbee2mqtt.service"
  ];

  # Sudoers entries: kiosk-ui (DynamicUser name = unit name without suffix) may
  # run systemctl start/stop/restart on exactly the four watched units, plus
  # poweroff/reboot for the admin page power controls, with no password.
  # NoNewPrivileges must be false to allow sudo.
  sudoRule = {
    users = [ "kiosk-ui" ];
    commands =
      (lib.concatMap (unit: [
        {
          command = "${pkgs.systemd}/bin/systemctl restart ${unit}";
          options = [ "NOPASSWD" ];
        }
        {
          command = "${pkgs.systemd}/bin/systemctl start ${unit}";
          options = [ "NOPASSWD" ];
        }
        {
          command = "${pkgs.systemd}/bin/systemctl stop ${unit}";
          options = [ "NOPASSWD" ];
        }
      ]) managedUnits)
      ++ [
        {
          command = "${pkgs.systemd}/bin/systemctl poweroff";
          options = [ "NOPASSWD" ];
        }
        {
          command = "${pkgs.systemd}/bin/systemctl reboot";
          options = [ "NOPASSWD" ];
        }
        # alarm-smoke needs sudo internally for `systemd-run --pty`. The
        # Machine page invokes it as `sudo -n alarm-smoke --yes --detach
        # <target>`; the inner sudo from the script is then a no-op (the
        # outer call already elevated). Locking the flag set to
        # "--yes --detach" keeps the kiosk's surface limited to fire-and-
        # forget runs that explicitly skip the TAS confirm prompt — there's
        # no Path through this rule to e.g. spawn an interactive shell.
        {
          command = "/run/current-system/sw/bin/alarm-smoke --yes --detach discord";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/run/current-system/sw/bin/alarm-smoke --yes --detach tas";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/run/current-system/sw/bin/alarm-smoke --yes --detach zigbee";
          options = [ "NOPASSWD" ];
        }
        # Streaming variants used by the kiosk-ui Machine page dialog —
        # output piped back over HTTP and rendered line-by-line.
        {
          command = "/run/current-system/sw/bin/alarm-smoke --yes --stream discord";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/run/current-system/sw/bin/alarm-smoke --yes --stream tas";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/run/current-system/sw/bin/alarm-smoke --yes --stream zigbee";
          options = [ "NOPASSWD" ];
        }
        # Stopping a transient smoke unit when the operator cancels the
        # Machine-page dialog. The unit name is alarm-smoke-<target>-<pid>;
        # the `*` matches the PID part. Without this, aborting an SSE
        # request would only kill the outer alarm-smoke shell — the
        # systemd-run transient unit would keep running until exit.
        {
          command = "${pkgs.systemd}/bin/systemctl stop alarm-smoke-*";
          options = [ "NOPASSWD" ];
        }
        # alarm-doctor is read-only and uses `sudo` internally to read the
        # bridge env file, `podman exec`, `journalctl -k`, and vcgencmd.
        # We grant NOPASSWD for the doctor binary itself; the inner sudo
        # calls run as root and become no-ops once the outer call elevated.
        {
          command = "/run/current-system/sw/bin/alarm-doctor";
          options = [ "NOPASSWD" ];
        }
        # The doctor's --print-secret mode is locked here to exactly the
        # one key the kiosk-ui needs (the Discord system webhook URL,
        # used by POST /api/alarm/doctor/send-discord). Any other key
        # request exits 1 inside the doctor, but pinning the flag set
        # here means a future "any --print-secret call" can't sneak in
        # via this rule.
        {
          command = "/run/current-system/sw/bin/alarm-doctor --print-secret DISCORD_SYSTEM_WEBHOOK_URL";
          options = [ "NOPASSWD" ];
        }
        # Engineering page: MQTT retained-message reads via podman exec,
        # container stats, and generation cleanup. Uses /run/current-system/sw
        # paths because ${pkgs.*} resolves to x86_64 store hashes at eval
        # time but the device runs aarch64 binaries with different hashes.
        {
          command = "/run/current-system/sw/bin/podman exec mosquitto mosquitto_sub *";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/run/current-system/sw/bin/podman stats --no-stream --format json";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/run/current-system/sw/bin/nix-env --list-generations *";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/run/current-system/sw/bin/nix-env --switch-generation *";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/run/current-system/sw/bin/nix-env --delete-generations *";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/nix/var/nix/profiles/system/bin/switch-to-configuration switch";
          options = [ "NOPASSWD" ];
        }
        {
          command = "/run/current-system/sw/bin/nix-collect-garbage";
          options = [ "NOPASSWD" ];
        }
      ];
  };
in
{
  options.services.alarm-kiosk = {
    exposeToLan = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        When true, the kiosk web UI listens on all interfaces and TCP/${toString cfg.port}
        is opened in the firewall. LAN clients are required to authenticate via
        HTTP Basic against secrets/kiosk-password. Loopback (the on-device
        Chromium kiosk) is always exempt from auth.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      # 8090 not 8080 — zigbee2mqtt frontend already owns 8080 (see zigbee.nix).
      default = 8090;
      description = "TCP port the kiosk UI listens on.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "admin";
      description = "HTTP Basic username (only checked for non-loopback clients).";
    };
  };

  config = {
    # /etc/kiosk-ui/password is the canonical on-disk password. LoadCredential
    # in the service unit reads it as root and hands a copy to the kiosk-ui
    # user via $CREDENTIALS_DIRECTORY.
    system.activationScripts.kiosk-ui-password = ''
      install -d -m 0700 /etc/kiosk-ui
      install -m 0600 -o root -g root ${pwFile} /etc/kiosk-ui/password
    '';

    # State dir for non-secret runtime files (e.g. events-last-cleared marker
    # used by /api/kiosk/events/clear). Owned by kiosk-ui:kiosk-ui so the
    # service can write without sudo.
    systemd.tmpfiles.rules = [
      "d /var/lib/kiosk-ui 0750 kiosk-ui kiosk-ui -"
      # alarm.py writes one file per /api/alarm/doctor invocation here and
      # prunes to the newest 1000. Pre-creating the dir avoids a race on
      # the first call after a fresh deploy.
      "d /var/lib/kiosk-ui/doctor-logs 0750 kiosk-ui kiosk-ui -"
    ];

    # Grant the kiosk-ui user (via `video` supplementary group) write access
    # to the panel backlight's brightness sysfs attribute, so the brightness
    # slider in the UI can apply changes without sudo. We do this in an
    # activation script rather than a udev rule because the DSI backlight is
    # not a hotplug device — by the time multi-user.target is reached,
    # /sys/class/backlight is populated.
    system.activationScripts.brightness-perms = ''
      for f in /sys/class/backlight/*/brightness; do
        [ -e "$f" ] || continue
        chgrp video "$f" 2>/dev/null || true
        chmod g+w "$f" 2>/dev/null || true
      done
    '';

    # Static `kiosk-ui` user. We originally used DynamicUser=true for the
    # automatic per-boot UID + ephemeral state isolation, but systemd treats
    # DynamicUser as forcing NoNewPrivileges=yes as a security invariant
    # (even when the unit explicitly sets it false). That blocks sudo, which
    # the Services page needs to restart/start/stop the managed units.
    # The remaining ProtectSystem=strict / ProtectHome / PrivateTmp settings
    # cover most of what we lost.
    users.users.kiosk-ui = {
      isSystemUser = true;
      group = "kiosk-ui";
      description = "alarm-alpaca kiosk web UI";
    };
    users.groups.kiosk-ui = { };

    # NetworkManager actions (connect, disconnect, modify) go through polkit.
    # The default NM policy authorises the `networkmanager` group only when
    # the caller has an "active session" (i.e. interactive logind seat). The
    # kiosk-ui systemd service has no session, so disconnect/modify requests
    # come back as "not authorized" — even though kiosk-ui is in the group.
    # Grant the user blanket NM access here so nmcli calls from the WiFi
    # page work non-interactively.
    security.polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
        if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0
            && subject.user === "kiosk-ui") {
          return polkit.Result.YES;
        }
      });
    '';

    networking.firewall.allowedTCPPorts = lib.optional cfg.exposeToLan cfg.port;

    # Passwordless sudo for systemctl on the four managed units.
    # NoNewPrivileges is set to false in the service below to allow this.
    security.sudo.extraRules = [ sudoRule ];

    systemd.services.kiosk-ui = {
      description = "alarm-alpaca kiosk web UI (FastAPI + React)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      # subprocess.exec lookups need these on PATH: nmcli (wifi page),
      # journalctl/systemctl (logs/services/dashboard pages), and the
      # NixOS setuid sudo wrapper (services restart via allowlisted
      # sudoers rule). We deliberately do NOT add `pkgs.sudo` here — that
      # gives the unwrapped /nix/store binary which lacks the setuid bit
      # and bails out at runtime. `/run/wrappers` resolves to the
      # security.wrappers-managed setuid wrappers; appending it as a
      # bare string makes the systemd path helper expand it to
      # `/run/wrappers/bin`.
      #
      # /run/current-system/sw/bin is the system-wide PATH segment
      # populated by environment.systemPackages. We add it (as a literal
      # so the wrapper-path string is left alone) so the Machine page can
      # invoke alarm-doctor / alarm-smoke without us having to thread the
      # individual derivations through this module. vcgencmd from
      # libraspberrypi (used by routes/system.py for throttle flags) also
      # lives there.
      path =
        (with pkgs; [
          networkmanager
          systemd
          # avahi-resolve: mDNS self-probe on the network info page.
          avahi
        ])
        ++ [
          "/run/wrappers"
          "/run/current-system/sw"
        ];

      environment = {
        KIOSK_STATIC_DIR = "${frontendDist}";
        KIOSK_PHONES_FILE = "/etc/alarm-bridge/phones.txt";
        KIOSK_AUTH_USER = cfg.user;
        # %d expands to $CREDENTIALS_DIRECTORY at unit start.
        KIOSK_PASSWORD_FILE = "%d/password";
        # Single source of truth for the managed-unit allowlist. The Python
        # services route parses this; the sudoers rule above is built from
        # the same `managedUnits` list, so adding/removing a unit only needs
        # to be done in this file.
        KIOSK_MANAGED_UNITS = lib.concatStringsSep "," managedUnits;
        PYTHONUNBUFFERED = "1";
      };

      serviceConfig = {
        Type = "simple";
        ExecStart = "${pythonEnv}/bin/uvicorn --app-dir ${backendSrc} main:app --host ${bindAddr} --port ${toString cfg.port}";
        LoadCredential = "password:/etc/kiosk-ui/password";
        User = "kiosk-ui";
        Group = "kiosk-ui";
        SupplementaryGroups = [
          # alarm-bridge.nix declares this group for phones.txt read/write.
          "alarm-config"
          # Read journal logs (events page, services page).
          "systemd-journal"
          # nmcli WiFi scan and connect (network page).
          "networkmanager"
          # Backlight write: brightness-perms activation script chgrps
          # /sys/class/backlight/*/brightness to `video` + g+w.
          "video"
        ];
        Restart = "always";
        RestartSec = 5;
        StandardOutput = "journal";
        StandardError = "journal";

        # Hardening (DynamicUser would have given us most of this for free
        # but it conflicted with sudo — see users.users.kiosk-ui above).
        # ProtectSystem=full instead of strict: leaves /var and /run
        # writable so sudo (used by alarm-doctor / alarm-smoke wrappers
        # invoked from the Machine page) can update its timestamp cache.
        # /usr, /boot, /etc remain read-only — that's enough hardening for
        # an LAN-facing service whose user is already in several privileged
        # groups by design.
        ProtectSystem = "full";
        ProtectHome = true;
        PrivateTmp = true;
        # /etc/alarm-bridge: phones.txt write (alarm-config group).
        # /var/lib/kiosk-ui: events-last-cleared marker file.
        ReadWritePaths = [
          "/etc/alarm-bridge"
          "/var/lib/kiosk-ui"
        ];
        # Explicitly false so the inherited default doesn't block sudo.
        NoNewPrivileges = false;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
          "AF_NETLINK" # ip route in engineering page
        ];
      };
    };
  };
}
