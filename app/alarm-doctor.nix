# Diagnostic CLI: alarm-doctor. Inspects the running deployment and reports
# health across services, secrets, network, MQTT, zigbee, and system metrics.
# Read-only by design (no smoke tests, no fixes) — complements alarm-smoke,
# which actively exercises external integrations.
#
# Exit code: 0 if no failures (warnings allowed), 1 if any failure.
{ pkgs, ... }:
let
  alarmDoctor = pkgs.writeShellApplication {
    name = "alarm-doctor";
    runtimeInputs = with pkgs; [
      systemd
      curl
      networkmanager
      podman
      coreutils
      gnugrep
      gawk
      jq
      iputils # ping
      libraspberrypi # vcgencmd
    ];
    # The doctor expects many commands to fail (that's the diagnostic point);
    # writeShellApplication's default `set -e` would abort on the first one.
    bashOptions = [
      "nounset"
      "pipefail"
    ];
    text = ''
      # --- secret-print mode -------------------------------------------
      # `alarm-doctor --print-secret KEY` reads /etc/alarm-bridge/env and
      # prints just the value of KEY to stdout, then exits. Used by the
      # kiosk-ui backend to fetch the Discord webhook URL without
      # widening its sudoers footprint to "read the whole env file".
      # Only the allowlist below is honoured; anything else exits 1.
      if [ "''${1:-}" = "--print-secret" ]; then
        key="''${2:-}"
        case "$key" in
          DISCORD_SYSTEM_WEBHOOK_URL) ;;
          *) echo "alarm-doctor: secret '$key' not exposed" >&2; exit 1 ;;
        esac
        env_file=/etc/alarm-bridge/env
        if ! sudo test -e "$env_file"; then
          echo "alarm-doctor: $env_file missing" >&2; exit 1
        fi
        val=$(sudo grep -E "^''${key}=" "$env_file" 2>/dev/null | head -n1 | cut -d= -f2-)
        if [ -z "$val" ]; then
          echo "alarm-doctor: $key empty or unset" >&2; exit 1
        fi
        printf '%s' "$val"
        exit 0
      fi

      # --- output helpers (colors only when stdout is a TTY) ---
      if [ -t 1 ]; then
        c_g=$'\033[0;32m'; c_y=$'\033[0;33m'; c_r=$'\033[0;31m'; c_d=$'\033[2m'; c_0=$'\033[0m'
      else
        c_g=""; c_y=""; c_r=""; c_d=""; c_0=""
      fi

      fails=0; warns=0

      check_ok()   { printf "  %s✓%s %s\n"        "$c_g" "$c_0" "$1"; }
      check_warn() { printf "  %s⚠%s %s — %s%s%s\n" "$c_y" "$c_0" "$1" "$c_d" "$2" "$c_0"; warns=$((warns+1)); }
      check_fail() { printf "  %s✗%s %s — %s%s%s\n" "$c_r" "$c_0" "$1" "$c_d" "$2" "$c_0"; fails=$((fails+1)); }
      section()    { printf "\n%s== %s ==%s\n" "$c_d" "$1" "$c_0"; }

      tcp_open() {
        # $1=host $2=port; returns 0 if TCP connect succeeds within 2s.
        timeout 2 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
      }

      # --- services ---
      section "Services"
      for svc in alarm-bridge.service kiosk-ui.service podman-mosquitto.service podman-zigbee2mqtt.service; do
        state=$(systemctl is-active "$svc" 2>/dev/null || true)
        if [ "$state" = "active" ]; then
          since=$(systemctl show -p ActiveEnterTimestamp --value "$svc" 2>/dev/null || true)
          check_ok "$svc''${since:+ (since $since)}"
        else
          check_fail "$svc" "state=$state"
          # Last 3 journal lines for DC quick-triage.
          printf "        %s" "$c_d"
          journalctl -u "$svc" -n 3 --no-pager -o short-iso 2>/dev/null \
            | sed 's/^/        /'
          printf "%s\n" "$c_0"
        fi
      done

      # kiosk-ui readiness — bound to localhost or LAN depending on exposeToLan,
      # but /api/health is always reachable from 127.0.0.1.
      if curl -sf --max-time 3 -o /dev/null http://127.0.0.1:8090/api/health; then
        check_ok "kiosk-ui /api/health (127.0.0.1:8090)"
      else
        check_fail "kiosk-ui /api/health" "no HTTP response on 127.0.0.1:8090"
      fi

      # --- config / secrets ---
      section "Configuration"
      env_file=/etc/alarm-bridge/env
      # Secrets captured for the deeper network probes further down. The
      # Configuration loop only validates presence; we keep the strings here
      # so the TAS / Discord probes don't have to re-shell-out per check.
      TAS_API_KEY_VAL=""
      DISCORD_USER_WEBHOOK_URL_VAL=""
      DISCORD_SYSTEM_WEBHOOK_URL_VAL=""
      if sudo test -e "$env_file"; then
        mode=$(sudo stat -c %a "$env_file")
        if [ "$mode" = "600" ]; then
          check_ok "$env_file (0600)"
        else
          check_warn "$env_file mode" "expected 0600, got $mode"
        fi
        for key in DISCORD_USER_WEBHOOK_URL DISCORD_SYSTEM_WEBHOOK_URL TAS_API_KEY TAS_SERVICE_NUMBER TAS_PHONES; do
          val=$(sudo grep -E "^''${key}=" "$env_file" 2>/dev/null | head -n1 | cut -d= -f2-)
          if [ -n "$val" ]; then
            check_ok "$key set"
            case "$key" in
              TAS_API_KEY)               TAS_API_KEY_VAL="$val" ;;
              DISCORD_USER_WEBHOOK_URL)   DISCORD_USER_WEBHOOK_URL_VAL="$val" ;;
              DISCORD_SYSTEM_WEBHOOK_URL) DISCORD_SYSTEM_WEBHOOK_URL_VAL="$val" ;;
            esac
          else
            check_fail "$key" "empty or missing in $env_file"
          fi
        done
      else
        check_fail "$env_file" "not found"
      fi

      phones_file=/etc/alarm-bridge/phones.txt
      if [ -f "$phones_file" ]; then
        count=$(grep -cvE '^\s*(#|$)' "$phones_file" || true)
        if [ "$count" -gt 0 ]; then
          check_ok "$phones_file ($count phone(s) loaded)"
        else
          check_fail "$phones_file" "no valid numbers — calls will be aborted"
        fi
      else
        # Activation script auto-seeds this on every deploy; missing means
        # someone rm'd it. alarm-bridge still falls back to TAS_PHONES env
        # so the alarm rings, but the misconfig is real.
        check_fail "$phones_file" "missing — re-deploy or recreate to restore"
      fi

      # --- network ---
      section "Network"
      net_diag=""

      # -- L2/L3: interfaces, IPs, gateway --
      primary_dev=$(nmcli -t -f DEVICE,STATE device status 2>/dev/null \
        | awk -F: '$2=="connected"{print $1; exit}')
      if [ -n "$primary_dev" ]; then
        dev_ip=$(nmcli -t -f IP4.ADDRESS device show "$primary_dev" 2>/dev/null \
          | head -n1 | cut -d: -f2-)
        dev_gw=$(nmcli -t -f IP4.GATEWAY device show "$primary_dev" 2>/dev/null \
          | head -n1 | cut -d: -f2-)
        check_ok "$primary_dev ip=''${dev_ip:-none} gw=''${dev_gw:-none}"
      else
        check_fail "no connected interface" "nmcli shows no device in connected state"
        net_diag="no interface connected — check cable or WiFi config"
      fi

      # WiFi signal strength — weak signal is a common silent failure mode
      # in hospital/factory deployments where the AP is far away.
      ssid=$(nmcli -t -f NAME,TYPE connection show --active 2>/dev/null \
        | awk -F: '$2=="802-11-wireless"{print $1; exit}')
      if [ -n "$ssid" ]; then
        signal=$(nmcli -t -f IN-USE,SIGNAL device wifi list 2>/dev/null \
          | awk -F: '$1=="*"{print $2; exit}')
        if [ -n "$signal" ]; then
          if [ "$signal" -ge 50 ]; then
            check_ok "WiFi SSID=$ssid signal=''${signal}%"
          elif [ "$signal" -ge 30 ]; then
            check_warn "WiFi SSID=$ssid" "signal=''${signal}% (weak)"
          else
            check_warn "WiFi SSID=$ssid" "signal=''${signal}% (very weak — packet loss likely)"
            net_diag="''${net_diag:+$net_diag; }WiFi signal very weak — move AP closer or use ethernet"
          fi
        else
          check_ok "WiFi SSID=$ssid signal=?"
        fi
      fi

      # NM state is informational — "connected (site only)" is a stale NM
      # heuristic that doesn't reflect actual reachability.
      nm_state=$(nmcli -t -f STATE general 2>/dev/null || echo "unknown")
      check_ok "NetworkManager state=$nm_state"

      # -- L3: gateway reachability --
      if [ -n "''${dev_gw:-}" ] && [ "$dev_gw" != "--" ]; then
        if ping -c1 -W2 "$dev_gw" >/dev/null 2>&1; then
          check_ok "gateway $dev_gw reachable"
        else
          check_fail "gateway $dev_gw" "ping failed — LAN-side issue"
          net_diag="''${net_diag:+$net_diag; }gateway unreachable — check AP/router power and LAN cable"
        fi
      fi

      # -- L3: internet reachability (IP only, no DNS) --
      # TCP connect to 8.8.8.8:53 — consistent with kiosk-ui /api/network/info.
      if tcp_open 8.8.8.8 53; then
        check_ok "internet reachable (8.8.8.8:53)"
      else
        check_fail "internet unreachable" "TCP connect to 8.8.8.8:53 failed"
        if [ -z "$net_diag" ]; then
          net_diag="gateway OK but no internet — router WAN/uplink down?"
        fi
      fi

      # -- DNS resolution --
      # getent uses system nsswitch — tests the same path the services use.
      resolve_dns() {
        local label="$1" domain="$2"
        local ip
        ip=$(getent ahosts "$domain" 2>/dev/null | awk 'NR==1{print $1}')
        if [ -n "$ip" ]; then
          check_ok "DNS $domain → $ip"
        else
          check_warn "DNS $domain" "resolution failed"
          net_diag="''${net_diag:+$net_diag; }cannot resolve $domain — check DNS settings"
        fi
      }
      resolve_dns "TAS" "tasapi.cht.com.tw"
      resolve_dns "Discord" "discord.com"

      # -- network diagnosis summary --
      if [ -n "$net_diag" ]; then
        printf "\n  %s→ diagnosis: %s%s\n" "$c_y" "$net_diag" "$c_0"
      fi

      # Outbound HTTPS probes. Hospital firewalls may block arbitrary hosts;
      # the doctor can't know what SHOULD be reachable, so failures degrade
      # to WARN. Any non-000 HTTP code counts as "reachable" — we don't care
      # about the status, only that DNS + routing + TLS handshake succeeded.
      http_reachable() {
        code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" "$1" 2>/dev/null || echo "000")
        [ "$code" != "000" ]
      }
      probe_host() {
        if http_reachable "$2"; then
          check_ok "$1"
        else
          check_warn "$1" "no HTTP response from $2 (firewall/DNS?)"
        fi
      }

      # api.cloudflare.com is the control plane any cloudflared tunnel or
      # Worker integration depends on; reach here confirms DNS + TLS to
      # Cloudflare works from the device. /client/v4/ips is unauthenticated
      # and tiny.
      probe_host "api.cloudflare.com" "https://api.cloudflare.com/client/v4/ips"

      # Authenticated TAS probe. The old `probe_host tasapi.cht.com.tw`
      # only confirmed TLS reach; it would pass even if the API key was
      # wrong or revoked. GET /phone-conn/v1/reg lists the account's
      # service numbers and is the cheapest no-side-effect endpoint that
      # exercises the key — a 200 means the credentials TAS will use to
      # place real calls actually work.
      if [ -n "$TAS_API_KEY_VAL" ]; then
        tas_code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" \
          -H "x-api-key: $TAS_API_KEY_VAL" \
          "https://tasapi.cht.com.tw/apis/CHTIoT/phone-conn/v1/reg" 2>/dev/null || echo "000")
        case "$tas_code" in
          200)     check_ok   "TAS /phone-conn/v1/reg (authed)" ;;
          401|403) check_fail "TAS /phone-conn/v1/reg" "HTTP $tas_code — TAS_API_KEY rejected" ;;
          000)     check_warn "TAS /phone-conn/v1/reg" "no HTTP response (firewall/DNS?)" ;;
          *)       check_warn "TAS /phone-conn/v1/reg" "unexpected HTTP $tas_code" ;;
        esac
      else
        check_warn "TAS /phone-conn/v1/reg" "TAS_API_KEY not loaded — skipped"
      fi

      # Discord webhook validity. GET on a Discord webhook URL returns the
      # webhook metadata as JSON (200) without sending a message, so this
      # is safe to run on every doctor invocation. A 404 means the webhook
      # was deleted server-side; 401 means the token segment is wrong.
      probe_webhook() {
        local label="$1" url="$2"
        if [ -z "$url" ]; then
          check_warn "$label" "URL not loaded — skipped"
          return
        fi
        local code
        code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
        case "$code" in
          200) check_ok   "$label reachable" ;;
          404) check_fail "$label" "HTTP 404 — webhook deleted or wrong ID" ;;
          401) check_fail "$label" "HTTP 401 — webhook token invalid" ;;
          000) check_warn "$label" "no HTTP response (firewall/DNS?)" ;;
          *)   check_warn "$label" "unexpected HTTP $code" ;;
        esac
      }
      probe_webhook "Discord user webhook"   "$DISCORD_USER_WEBHOOK_URL_VAL"
      probe_webhook "Discord system webhook" "$DISCORD_SYSTEM_WEBHOOK_URL_VAL"

      # --- MQTT ---
      section "MQTT"
      if tcp_open 127.0.0.1 1883; then
        check_ok "mosquitto :1883 TCP open"
      else
        check_fail "mosquitto :1883" "TCP connect failed"
      fi

      # z2m bridge/state — "online" means z2m is connected to mosquitto and
      # the coordinator. This is the fastest indicator of z2m health.
      bridge_state=$(sudo podman exec mosquitto mosquitto_sub -h localhost \
        -t 'zigbee2mqtt/bridge/state' -C 1 -W 5 2>/dev/null || true)
      if [ -n "$bridge_state" ]; then
        # z2m >= 1.28 publishes JSON {"state":"online"}, older versions
        # publish the bare string "online".
        parsed=$(echo "$bridge_state" | jq -r '.state // empty' 2>/dev/null || true)
        state_val="''${parsed:-$bridge_state}"
        if [ "$state_val" = "online" ]; then
          check_ok "z2m bridge/state=online"
        else
          check_fail "z2m bridge/state" "state=$state_val"
        fi
      else
        check_warn "z2m bridge/state" "no retained message within 5s"
      fi

      # bridge/devices is retained by z2m on each (re)connect. On a freshly
      # booted device, mosquitto can come up before z2m has had a chance to
      # publish its retained state — and we've seen real-world cases where
      # 3s wasn't long enough for the retain to arrive. -W 10 with two
      # retries is much more forgiving without making a healthy run slower
      # (the first call returns immediately when the retained message is
      # already on the broker).
      dev_json=""
      for _ in 1 2; do
        dev_json=$(sudo podman exec mosquitto mosquitto_sub -h localhost \
          -t 'zigbee2mqtt/bridge/devices' -C 1 -W 10 2>/dev/null || true)
        [ -n "$dev_json" ] && break
      done
      if [ -n "$dev_json" ]; then
        # Use jq for accurate counts — naive grep matches nested type fields
        # inside each device's exposes/options definitions.
        coord=$(echo "$dev_json"     | jq '[.[] | select(.type=="Coordinator")] | length' 2>/dev/null || echo 0)
        non_coord=$(echo "$dev_json" | jq '[.[] | select(.type!="Coordinator")] | length' 2>/dev/null || echo 0)
        if [ "$coord" -ge 1 ] && [ "$non_coord" -ge 1 ]; then
          check_ok "z2m paired: $non_coord device(s) + coordinator"
        elif [ "$coord" -ge 1 ]; then
          check_warn "z2m paired" "coordinator only, no end devices"
        else
          check_warn "z2m paired" "no coordinator in bridge/devices"
        fi
      else
        check_warn "z2m bridge/devices" "no retained message within 20s"
      fi

      # --- zigbee ---
      section "Zigbee"
      shopt -s nullglob
      dongles=(/dev/serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_*)
      shopt -u nullglob
      if [ ''${#dongles[@]} -gt 0 ]; then
        check_ok "Zigbee dongle ($(basename "''${dongles[0]}"))"
      else
        check_fail "Zigbee dongle" "no Sonoff ZBDongle-E by-id symlink"
      fi

      if curl -sf --max-time 5 -o /dev/null http://127.0.0.1:8080; then
        check_ok "z2m frontend http://localhost:8080"
      else
        check_fail "z2m frontend :8080" "HTTP request failed"
      fi

      # --- recent errors ---
      section "Recent errors (24h)"
      for svc in alarm-bridge.service podman-mosquitto.service podman-zigbee2mqtt.service; do
        n=$(journalctl -u "$svc" --since "24 hours ago" -p err --no-pager 2>/dev/null | grep -cv '^-- ' || true)
        if [ "$n" -eq 0 ]; then
          check_ok "$svc: no error-level log lines"
        else
          check_warn "$svc" "$n error-level lines in last 24h"
        fi
      done

      # --- SD card health ---
      # SD cards don't expose SMART, so we infer health from three signals:
      # rootfs mount mode, an actual write/read/delete round-trip on rootfs,
      # and the kernel ring buffer over 24h. A failed write or RO remount
      # is a hard failure (deployment is dying); kernel errors are a warn
      # (something happened but the device may still be functional).
      section "SD card"
      if grep -qE '^[^ ]+ / [^ ]+ rw,' /proc/mounts; then
        check_ok "rootfs mounted rw"
      else
        mode=$(awk '$2=="/" {print $4}' /proc/mounts)
        check_fail "rootfs mount mode" "expected rw,..., got '$mode'"
      fi

      # /var/tmp is on rootfs (/tmp may be tmpfs on NixOS).
      probe=/var/tmp/.alarm-doctor-probe.$$
      if printf "ok\n" > "$probe" 2>/dev/null \
         && [ "$(cat "$probe" 2>/dev/null)" = "ok" ] \
         && rm -f "$probe"; then
        check_ok "rootfs write+read+delete probe (/var/tmp)"
      else
        rm -f "$probe" 2>/dev/null || true
        check_fail "rootfs write+read" "round-trip in /var/tmp failed"
      fi

      sd_errs=$(sudo journalctl --since "24 hours ago" -k --no-pager 2>/dev/null \
        | grep -ciE 'i/o error|ext4-fs.*error|remount.*read-only|mmc.*error|buffer i/o error' \
        || true)
      if [ "$sd_errs" -eq 0 ]; then
        check_ok "no SD/FS errors in kernel log (24h)"
      else
        check_warn "SD/FS kernel errors" "$sd_errs line(s) in last 24h — check 'journalctl -k | grep -iE \"i/o|ext4-fs|mmc\"'"
      fi

      # --- system ---
      section "System"
      disk=$(df -P / | awk 'NR==2 {gsub("%",""); print $5}')
      if   [ "$disk" -lt 80 ]; then check_ok   "rootfs $disk% used"
      elif [ "$disk" -lt 90 ]; then check_warn "rootfs $disk% used" "consider cleanup"
      else                          check_fail "rootfs $disk% used" "running out of space"; fi

      if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
        tc=$(($(cat /sys/class/thermal/thermal_zone0/temp) / 1000))
        if   [ "$tc" -lt 70 ]; then check_ok   "SoC temp ''${tc}°C"
        elif [ "$tc" -lt 80 ]; then check_warn "SoC temp ''${tc}°C" "warm"
        else                        check_fail "SoC temp ''${tc}°C" "throttling likely"; fi
      fi

      # vcgencmd throttle bitmask: low nibble = active right NOW,
      # bits 16-19 = "has occurred since boot". Past events are an early
      # warning even when the instant temp/voltage looks fine.
      throttled=$(sudo vcgencmd get_throttled 2>/dev/null | cut -d= -f2 || true)
      if [ -n "$throttled" ] && [ "$throttled" = "0x0" ]; then
        check_ok "vcgencmd get_throttled=0x0 (no events)"
      elif [ -n "$throttled" ]; then
        v=$((throttled))
        bits=""
        [ $((v & 0x1))     -ne 0 ] && bits="''${bits}under-voltage,"
        [ $((v & 0x2))     -ne 0 ] && bits="''${bits}arm-capped,"
        [ $((v & 0x4))     -ne 0 ] && bits="''${bits}throttled,"
        [ $((v & 0x8))     -ne 0 ] && bits="''${bits}soft-temp-limit,"
        [ $((v & 0x10000)) -ne 0 ] && bits="''${bits}past-under-voltage,"
        [ $((v & 0x20000)) -ne 0 ] && bits="''${bits}past-arm-capped,"
        [ $((v & 0x40000)) -ne 0 ] && bits="''${bits}past-throttled,"
        [ $((v & 0x80000)) -ne 0 ] && bits="''${bits}past-soft-temp-limit,"
        bits="''${bits%,}"
        if [ $((v & 0xF)) -ne 0 ]; then
          check_fail "vcgencmd get_throttled=$throttled" "ACTIVE: $bits"
        else
          check_warn "vcgencmd get_throttled=$throttled" "past events: $bits"
        fi
      else
        check_warn "vcgencmd get_throttled" "could not read (vcio perms?)"
      fi

      # Parse /proc/uptime directly — portable, doesn't depend on which
      # `uptime` variant is on PATH (procps vs BSD).
      if [ -r /proc/uptime ]; then
        secs=$(cut -d. -f1 < /proc/uptime)
        days=$((secs / 86400)); hours=$(((secs % 86400) / 3600)); mins=$(((secs % 3600) / 60))
        check_ok "uptime ''${days}d ''${hours}h ''${mins}m"
      fi

      # --- summary ---
      section "Summary"
      if [ "$fails" -eq 0 ] && [ "$warns" -eq 0 ]; then
        printf "%sAll checks passed.%s\n" "$c_g" "$c_0"
        exit 0
      elif [ "$fails" -eq 0 ]; then
        printf "%s%d warning(s), 0 failures.%s\n" "$c_y" "$warns" "$c_0"
        exit 0
      else
        printf "%s%d failure(s), %d warning(s).%s\n" "$c_r" "$fails" "$warns" "$c_0"
        exit 1
      fi
    '';
  };
in
{
  environment.systemPackages = [ alarmDoctor ];
}
