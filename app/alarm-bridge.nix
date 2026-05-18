# Emergency-button bridge: subscribes to zigbee2mqtt/# on mosquitto, dispatches
# button presses to CHT TAS (IVR callout) and Discord webhooks. Runs as a
# DynamicUser systemd service alongside the podman containers from zigbee.nix.
#
# Secrets (TAS_API_KEY, Discord webhook URLs, phone list) come from
# ./secrets/alarm-bridge.env — gitignored, same pattern as wifi-psk. Will be
# migrated to agenix once a second consumer appears (see project memory).
{
  config,
  pkgs,
  lib,
  ...
}:
let
  pythonEnv = pkgs.python313.withPackages (ps: [
    ps.httpx
    ps.paho-mqtt
    ps.python-dotenv
    ps.anyio
  ]);

  # Source tree as a /nix/store derivation; main.py prepends its own dir to
  # sys.path so sibling imports (config, logger, …) resolve from here.
  bridgeSrc = pkgs.runCommand "alarm-bridge-src" { } ''
    cp -r ${./scripts} $out
  '';

  envFile = pkgs.writeText "alarm-bridge.env" (lib.fileContents ../secrets/alarm-bridge.env);

  # Manual end-to-end smoke runners. Each invocation spawns a transient
  # systemd unit via systemd-run --pty so the script sees the exact same
  # EnvironmentFile the production alarm-bridge.service does — a passing
  # smoke therefore proves the deployment is wired correctly (env, network,
  # credentials, peer reachability). NOT mocked on purpose.
  #
  # Mutex with prod: Conflicts=alarm-bridge.service is bi-directional, so
  # starting a smoke stops the prod service (and vice versa). OnSuccess +
  # OnFailure both trigger a fresh start of alarm-bridge.service when the
  # smoke unit exits — covers clean exit, error exit, ^C, and being killed
  # by a conflict-triggered SIGTERM. Restart=always on alarm-bridge does
  # NOT fire here: systemd treats Conflicts-induced stops as clean.
  #
  # Why mutex: zigbee_smoke and prod would both receive the same MQTT
  # button press → real TAS callout fires during what should be a test.
  # tas_smoke's TasClient cooldown is process-local and wouldn't dedupe
  # against prod either. Cleanest rule: at most one of {alarm-bridge,
  # alarm-smoke-*} active at a time. Trade-off: real button presses
  # during a smoke are NOT dispatched.
  #
  # ALARM_BRIDGE_LOG_DIR is overridden to /tmp because tas_smoke imports
  # tas_client → setup_logger, which would otherwise try to mkdir under the
  # read-only ${bridgeSrc} path.
  alarmSmoke = pkgs.writeShellApplication {
    name = "alarm-smoke";
    runtimeInputs = [ pkgs.systemd ];
    text = ''
      # --yes      skip the TAS confirmation prompt
      # --detach   drop --pty/--wait/--collect: fire-and-forget
      # --stream   like the default (wait) but use --pipe instead of --pty,
      #            so output streams cleanly to a captured pipe (kiosk-ui
      #            tails the smoke output into the Machine-page dialog)
      yes=
      detach=
      stream=
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --yes) yes=1; shift ;;
          --detach) detach=1; shift ;;
          --stream) stream=1; shift ;;
          -h|--help)
            echo "Usage: alarm-smoke [--yes] [--detach|--stream] discord|tas|zigbee" >&2
            exit 0
            ;;
          *) break ;;
        esac
      done
      target="''${1:-}"
      case "$target" in
        discord|tas|zigbee) ;;
        *) echo "Usage: alarm-smoke [--yes] [--detach] discord|tas|zigbee" >&2; exit 1 ;;
      esac

      if [ "$target" = "tas" ] && [ -z "$yes" ]; then
        echo "WARNING: this places a REAL phone call to every number in TAS_PHONES."
        read -r -p "Continue? (type 'yes'): " confirm
        [ "$confirm" = "yes" ] || { echo "Aborted."; exit 1; }
      fi

      echo "[alarm-smoke] alarm-bridge.service will be stopped for the duration of this smoke and restarted on exit."

      # Three exec modes:
      #   --detach: fire-and-forget. systemd-run returns immediately;
      #     OnSuccess/OnFailure brings alarm-bridge back.
      #   --stream: --pipe instead of --pty so stdout streams over a
      #     captured pipe rather than expecting a tty (kiosk-ui dialog).
      #     Default: interactive --pty for direct CLI use.
      if [ -n "$detach" ]; then
        exec sudo systemd-run \
          --unit="alarm-smoke-$target-$$" \
          --service-type=exec \
          --property=Conflicts=alarm-bridge.service \
          --property=OnSuccess=alarm-bridge.service \
          --property=OnFailure=alarm-bridge.service \
          --property=EnvironmentFile=/etc/alarm-bridge/env \
          --setenv=ALARM_BRIDGE_LOG_DIR=/tmp \
          ${pythonEnv}/bin/python ${bridgeSrc}/smoke/"$target"_smoke.py
      fi

      if [ -n "$stream" ]; then
        # --pipe is the headless analogue of --pty. --quiet drops systemd-run's
        # own banner so the dialog only sees the smoke script's output.
        # Print the transient unit name on the very first line so the
        # kiosk-ui can `systemctl stop` it when the operator hits "停止"
        # (otherwise killing the SSE process leaves the unit running, and
        # alarm-bridge stays Conflicts-suppressed until OnSuccess fires).
        unit="alarm-smoke-$target-$$"
        echo "[unit] $unit"
        exec sudo systemd-run \
          --unit="$unit" \
          --pipe --wait --collect --quiet \
          --service-type=exec \
          --property=Conflicts=alarm-bridge.service \
          --property=OnSuccess=alarm-bridge.service \
          --property=OnFailure=alarm-bridge.service \
          --property=EnvironmentFile=/etc/alarm-bridge/env \
          --setenv=ALARM_BRIDGE_LOG_DIR=/tmp \
          ${pythonEnv}/bin/python -u ${bridgeSrc}/smoke/"$target"_smoke.py
      fi

      exec sudo systemd-run \
        --unit="alarm-smoke-$target-$$" \
        --pty --wait --collect \
        --service-type=exec \
        --property=Conflicts=alarm-bridge.service \
        --property=OnSuccess=alarm-bridge.service \
        --property=OnFailure=alarm-bridge.service \
        --property=EnvironmentFile=/etc/alarm-bridge/env \
        --setenv=ALARM_BRIDGE_LOG_DIR=/tmp \
        ${pythonEnv}/bin/python ${bridgeSrc}/smoke/"$target"_smoke.py
    '';
  };
in
{
  environment.systemPackages = [ alarmSmoke ];

  # Shared group so kiosk-ui (also DynamicUser) can write phones.txt while
  # alarm-bridge keeps reading it. Members are granted via SupplementaryGroups
  # on each service.
  users.groups.alarm-config = { };

  # Mirror wifi-psk pattern: writeText output is world-readable in /nix/store,
  # so re-install at 0600 in /etc/ for defence-in-depth. Single-user kiosk —
  # physical SD access already wins; this is the lightweight tier.
  #
  # Dir is 0775 root:alarm-config so kiosk-ui can drop a temp file alongside
  # phones.txt for atomic rename. The env file inside stays 0600 root:root —
  # that's what holds the actual secrets, and systemd reads it as root before
  # privilege drop.
  #
  # phones.txt is seeded from the .env TAS_PHONES on first deploy and then
  # never overwritten. Ops edit it via `sudoedit /etc/alarm-bridge/phones.txt`
  # OR via the kiosk UI's "通知電話" page; both write the same file and
  # tas_client re-reads it on every button press — no service restart needed.
  # See app/scripts/tas_client.py:load_phones().
  # deps = ["users"] — needs the alarm-config group to exist before chgrp.
  # Without this, activation order is undefined and `install -g alarm-config`
  # races against the user/group setup.
  #
  # Dir is mode 2775 (setgid bit on group): new files created inside inherit
  # group alarm-config. kiosk-ui writes phones.txt via atomic rename of a
  # temp file in this dir; the setgid bit means even the rewritten file ends
  # up group-owned by alarm-config so alarm-bridge keeps reading it.
  system.activationScripts.alarm-bridge-env = lib.stringAfter [ "users" ] ''
    install -d -m 2775 -o root -g alarm-config /etc/alarm-bridge
    install -m 0600 -o root -g root ${envFile} /etc/alarm-bridge/env

    if [ ! -e /etc/alarm-bridge/phones.txt ]; then
      {
        echo "# Production dial list — one number per line."
        echo "# '#' starts a comment; blank lines are ignored."
        echo "# Edit with: sudoedit /etc/alarm-bridge/phones.txt OR the kiosk UI."
        echo "# Changes apply on the next button press (no restart needed)."
        echo "# Seeded from secrets/alarm-bridge.env TAS_PHONES on first deploy;"
        echo "# subsequent deploys never overwrite this file."
        echo ""
        # NixOS activation PATH has coreutils + gnugrep but NOT gnused, so
        # use tr+grep only. tr -d '\r' guards against CRLF endings; the
        # tas_client.load_phones() Python side also .strip()s each line.
        grep "^TAS_PHONES=" ${envFile} \
          | cut -d= -f2- \
          | tr -d '\r' \
          | tr ',' '\n' \
          | grep -v '^$' || true
      } > /etc/alarm-bridge/phones.txt
    fi

    # Idempotently enforce shared-group perms — covers both first-deploy seed
    # AND drift after kiosk-ui rewrites (temp file's owner is the DynamicUser,
    # only the group bit keeps both services able to access it).
    if [ -e /etc/alarm-bridge/phones.txt ]; then
      chgrp alarm-config /etc/alarm-bridge/phones.txt
      chmod 0664 /etc/alarm-bridge/phones.txt
    fi
  '';

  systemd.services.alarm-bridge = {
    description = "Emergency button bridge (zigbee2mqtt → CHT TAS + Discord)";
    wantedBy = [ "multi-user.target" ];
    after = [
      "network-online.target"
      "podman-mosquitto.service"
    ];
    wants = [
      "network-online.target"
      "podman-mosquitto.service"
    ];

    serviceConfig = {
      Type = "simple";
      ExecStart = "${pythonEnv}/bin/python ${bridgeSrc}/main.py";
      EnvironmentFile = "/etc/alarm-bridge/env";
      Environment = [
        "ALARM_BRIDGE_LOG_DIR=/var/lib/alarm-bridge/logs"
        # Heartbeat marker on tmpfs so the kiosk-ui's System page can show
        # "last Discord heartbeat". /run is world-readable by default and
        # is wiped on reboot, which is what we want — a fresh kiosk should
        # show "no heartbeat yet" until alarm-bridge ticks the file.
        "ALARM_BRIDGE_HEARTBEAT_FILE=/run/alarm-bridge/discord-heartbeat-last"
      ];
      DynamicUser = true;
      # Joins kiosk-ui in the alarm-config group so phones.txt is readable
      # even after kiosk-ui rewrites it (file group flips to alarm-config).
      SupplementaryGroups = [ "alarm-config" ];
      StateDirectory = "alarm-bridge/logs";
      # /run/alarm-bridge for the heartbeat marker. Default mode 0755 lets
      # kiosk-ui (different user) read it; only alarm-bridge can write.
      RuntimeDirectory = "alarm-bridge";
      Restart = "always";
      RestartSec = 5;
      StandardOutput = "journal";
      StandardError = "journal";
    };
  };
}
