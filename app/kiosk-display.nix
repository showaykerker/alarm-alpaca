# Touchscreen kiosk display: cage (wlroots-based single-window Wayland
# compositor) auto-starts Chromium fullscreen pointed at the local kiosk UI.
#
# This module brings the image from headless to graphical. It is wired into
# the alarm-alpaca deploy target ONLY — the SD-image installer stays headless
# on purpose (no need for a graphical session during install).
#
# Boot sequence: getty on tty1 → cage takes over the seat → spawns chromium
# in app/kiosk mode against http://localhost:8090. The kiosk-ui systemd
# service is ordered before cage so chromium doesn't hit a "site unreachable"
# splash on first paint.
{
  config,
  pkgs,
  lib,
  ...
}:
let
  # One frontend now serves both the on-device kiosk and LAN admin (see
  # kiosk-ui.nix). Chromium loads the root path — same URL LAN users would
  # type into their browser.
  kioskUrl = "http://localhost:8090";

  # wlroots draws its own compositor cursor whenever a pointer device is
  # present — chromium's `cursor: none` CSS only suppresses the in-page
  # cursor, not the compositor's. We generate a 1×1 fully-transparent
  # XCURSOR theme and point cage at it via XCURSOR_THEME / XCURSOR_PATH so
  # libwayland-cursor loads nothing visible. Covers every name wlroots can
  # ask for, so a fallback never picks up the system default.
  invisibleCursorTheme =
    pkgs.runCommand "invisible-cursor-theme"
      {
        nativeBuildInputs = [
          pkgs.xorg.xcursorgen
          pkgs.imagemagick
        ];
      }
      ''
        themeDir=$out/share/icons/invisible
        mkdir -p "$themeDir/cursors"
        cat > "$themeDir/index.theme" <<EOF
        [Icon Theme]
        Name=invisible
        Comment=Fully transparent cursors so cage's compositor cursor disappears.
        EOF
        convert -size 1x1 xc:transparent blank.png
        echo "1 0 0 $PWD/blank.png" > cur.cfg
        for name in default left_ptr arrow top_left_arrow X_cursor cell crosshair \
                    hand hand1 hand2 pointer text wait progress watch \
                    not-allowed forbidden no-drop dnd-no-drop fleur grabbing \
                    move all-scroll col-resize row-resize n-resize e-resize s-resize \
                    w-resize ne-resize nw-resize se-resize sw-resize \
                    size_ver size_hor size_fdiag size_bdiag size_all \
                    ibeam help question_arrow context-menu vertical-text \
                    copy alias zoom-in zoom-out
        do
          xcursorgen cur.cfg "$themeDir/cursors/$name"
        done

        # Alias common fallback theme names to point at the invisible theme.
        # wlroots/libwayland-cursor often ignore XCURSOR_THEME and load
        # "default" / "Adwaita" / "DMZ-White" directly when a client asks
        # for a cursor surface; routing every common name through us makes
        # the lookup land on transparent pixels no matter which name wins.
        for alias in default Adwaita Adwaita-cursors DMZ-White DMZ-Black \
                     core capitaine-cursors breeze_cursors Bibata-Modern-Classic
        do
          ln -s invisible "$out/share/icons/$alias"
        done
      '';

  # Combined flag set: `--app` opens chromium in standalone app mode (no
  # tab strip, no omnibox, no menu); `--kiosk` makes it fullscreen and blocks
  # exit. Together they give a clean kiosk experience even if cage's seat
  # protections weaken. Other flags suppress dialogs and updates that would
  # interrupt the touchscreen UX.
  chromiumFlags = [
    "--app=${kioskUrl}"
    "--kiosk"
    "--ozone-platform=wayland"
    "--enable-features=UseOzonePlatform"
    # GPU acceleration on the RPi5 v3d driver. Without these chromium falls
    # back to software rasterisation paths, which is the most plausible
    # cause of the touchscreen feeling laggy. EGL is the right backend on
    # wlroots; the blocklist bypass + zero-copy let chromium actually use
    # v3d instead of refusing on a precautionary basis.
    "--use-gl=egl"
    "--ignore-gpu-blocklist"
    "--enable-zero-copy"
    "--noerrdialogs"
    "--disable-infobars"
    "--disable-session-crashed-bubble"
    "--hide-crash-restore-bubble"
    "--disable-features=TranslateUI"
    "--no-first-run"
    "--disable-pinch"
    "--overscroll-history-navigation=0"
    # Defence in depth against drag-to-navigate gestures. The body has
    # touch-action: pan-y as well; the chromium feature flag covers the
    # cases where a touchpad horizontal swipe still tries to fire history
    # nav even with --overscroll-history-navigation=0.
    "--disable-features=TouchpadOverscrollHistoryNavigation,OverscrollHistoryNavigation"
    "--autoplay-policy=no-user-gesture-required"
    "--check-for-update-interval=31536000"
    "--disable-component-update"
    "--password-store=basic"
    "--disable-popup-blocking"
  ];
in
{
  # Seat access: cage needs DRM (video/render) and input devices. logind
  # handles seat assignment when systemd-logind is in use (NixOS default).
  users.users.nixos.extraGroups = [
    "video"
    "input"
    "render"
  ];

  # Kernel framebuffer blanking happens BEFORE the Wayland compositor takes
  # over — `consoleblank=0` keeps the screen lit from POST to first chromium
  # paint. Once cage is up, wlroots controls DPMS (and by default does not
  # blank without an explicit idle daemon).
  boot.kernelParams = [ "consoleblank=0" ];

  # Disable Magic SysRq. Defends against a physical-keyboard attacker who
  # could otherwise reboot (Alt+SysRq+B), poweroff (+O), or kill all
  # processes (+I) via the kernel-level path that bypasses the Wayland seat.
  # Pure DoS prevention — SysRq does not yield a shell — but cheap.
  boot.kernel.sysctl."kernel.sysrq" = 0;

  # Chromium managed policy: disable DevTools entirely. Without this, F12 /
  # Ctrl+Shift+I on a plugged-in USB keyboard opens DevTools inside the
  # cage'd Chromium, and the console can call kiosk-ui /api/* freely because
  # auth.py bypasses HTTP Basic for loopback. Value 2 =
  # "DeveloperToolsDisallowed" per Chromium enterprise policy docs.
  # `--app --kiosk` flags do NOT block DevTools by themselves.
  environment.etc."chromium/policies/managed/kiosk.json".text = builtins.toJSON {
    DeveloperToolsAvailability = 2;
  };

  # CJK fonts: without these, Chromium falls back to a font that has no
  # glyphs for Traditional Chinese and renders 中文 as tofu (□□). Noto Sans
  # CJK SC covers TC too via the unified codepoints; keep noto-fonts for
  # Latin coverage so en-mixed UI doesn't go monospace.
  fonts.packages = with pkgs; [
    noto-fonts
    noto-fonts-cjk-sans
    noto-fonts-color-emoji
  ];

  services.cage = {
    enable = true;
    user = "nixos";

    # The cage `program` is the single application that owns the seat. When
    # chromium exits (crash, manual quit somehow), cage exits, and the
    # systemd unit's Restart=on-failure brings the whole stack back up.
    program = lib.concatStringsSep " " ([ "${pkgs.chromium}/bin/chromium" ] ++ chromiumFlags);
  };

  # Give tty1 to cage exclusively. By default NixOS wires getty@tty1 (and the
  # logind-driven autovt@tty1 template) into multi-user.target; every deploy
  # re-evaluates that target and starts getty, which trips cage's
  # `Conflicts=getty@tty1.service` and blacks out the kiosk. Disabling both
  # template instances removes that path entirely so cage owns the VT for the
  # life of the system.
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@tty1".enable = false;

  # Lock down VT switching. By default logind exposes 6 virtual terminals
  # and will spawn `autovt@ttyN` on Ctrl+Alt+F2..F6, taking the seat away
  # from cage and showing a login prompt. nixos/root have no password so
  # the prompt itself is unloginable, but the VT switch is still a DoS
  # (kiosk goes black until VT1 is re-selected) and leaks journal scroll
  # on the foreground tty. NAutoVTs=0 stops logind from instantiating
  # autovt@ttyN at all; ReserveVT=0 releases the otherwise-reserved VT6
  # so nothing answers a switch to it either. cage owns tty1 via its own
  # service unit, independent of NAutoVTs.
  services.logind.settings.Login = {
    NAutoVTs = 0;
    ReserveVT = 0;
  };

  # Touch input calibration to match the wlr-randr display rotation.
  #
  # The DSI panel reports touch coordinates in its NATIVE portrait
  # orientation, regardless of the compositor's output transform — so when
  # cage-rotate-dsi rotates the screen 270° (landscape) but libinput still
  # delivers raw portrait coords, taps land in the wrong place. cage doesn't
  # auto-map touch to output transform.
  #
  # LIBINPUT_CALIBRATION_MATRIX is a 6-value affine matrix (first two rows
  # of a 3x3, last row implicit `0 0 1`) applied to normalised device
  # coords. For the panel's 270° output transform we want the touch input
  # rotated 90° counter-clockwise: (x, y) → (y, 1-x). That is matrix
  # `0 1 0 -1 0 1`. If the kiosk ever switches to a different rotation,
  # the four canonical matrices are:
  #     0°   "1 0 0 0 1 0"
  #     90°  "0 -1 1 1 0 0"
  #     180° "-1 0 1 0 -1 1"
  #     270° "0 1 0 -1 0 1"
  services.udev.extraRules = ''
    ATTRS{name}=="Goodix Capacitive TouchScreen", ENV{LIBINPUT_CALIBRATION_MATRIX}="0 1 0 -1 0 1"
  '';

  # Order cage after the kiosk web UI so chromium's first paint doesn't hit
  # "site unreachable". The cage NixOS module creates `cage-tty1.service`.
  systemd.services.cage-tty1 = {
    after = [
      "kiosk-ui.service"
      "network.target"
      "cage-touch-recalibrate.service"
    ];
    wants = [
      "kiosk-ui.service"
      "cage-touch-recalibrate.service"
    ];
    # Force the invisible XCURSOR theme so wlroots renders nothing where a
    # cursor would otherwise appear. XCURSOR_PATH wins over the default
    # search path so chromium and any wlroots fallback share the same
    # transparent set.
    environment = {
      XCURSOR_THEME = "invisible";
      XCURSOR_PATH = "${invisibleCursorTheme}/share/icons";
      XCURSOR_SIZE = "1";
    };
    # Auto-restart on exit. Without this, a stray Alt+F4 from a USB keyboard
    # plugged into the kiosk leaves a black screen forever — chromium exits
    # cleanly (rc=0), cage exits, and the NixOS upstream cage module ships
    # with Restart=no for first-deploy safety. With RestartIfChanged=false
    # already on the unit, this only fires on actual crashes / Alt+F4, not
    # on deploy activations. systemd's default StartLimit (5 in 10s) catches
    # a permanent failure loop (bad wayland socket etc.) and surfaces it as
    # "failed" rather than churning forever.
    serviceConfig = {
      Restart = "always";
      RestartSec = 2;
    };
  };

  # Re-fire udev on the Goodix touchscreen right before cage starts, so
  # libinput reads the latest LIBINPUT_CALIBRATION_MATRIX when it opens the
  # device. Without this, `nixos-rebuild switch` adds/updates the udev rule
  # but the already-attached device keeps its stale environment in
  # /run/udev/data/, and a manual `sudo systemctl restart cage-tty1` after
  # deploy ends up reopening the device with the old (uncalibrated) coords.
  # Wired as wantedBy=cage-tty1 (not graphical.target) for the same reason
  # cage-rotate-dsi is: that re-fires the oneshot on every cage restart.
  systemd.services.cage-touch-recalibrate = {
    description = "Re-trigger udev for the Goodix touchscreen before cage opens it";
    wantedBy = [ "cage-tty1.service" ];
    before = [ "cage-tty1.service" ];
    serviceConfig = {
      Type = "oneshot";
      # Inline script so we can quote the device name (it contains spaces)
      # without fighting systemd's ExecStart tokenizer.
      ExecStart = pkgs.writeShellScript "cage-touch-recalibrate" ''
        ${pkgs.systemd}/bin/udevadm trigger \
          --action=change \
          --subsystem-match=input \
          --attr-match=name='Goodix Capacitive TouchScreen'
        ${pkgs.systemd}/bin/udevadm settle --timeout=5 || true
      '';
    };
  };

  # Force landscape on the 5-inch DSI panel.
  #
  # Background: the panel's native orientation is portrait (720x1280) and
  # the rp1-dsi kernel driver does NOT expose the standard DRM
  # `panel-orientation` property, so the device tree overlay's `rotation`
  # parameter is a no-op for this connector. Wayland compositors that auto-
  # rotate based on that property therefore see "normal" and render portrait.
  #
  # cage 0.2.1 has no built-in transform flag, so we drive wlr-randr after
  # the wayland socket comes up. A retry loop covers the race where the
  # socket isn't visible yet by the time this unit starts.
  systemd.services.cage-rotate-dsi = {
    description = "Rotate cage's DSI output to landscape via wlr-randr";
    after = [ "cage-tty1.service" ];
    # wantedBy=cage-tty1 (not graphical.target) so this oneshot re-fires on
    # every cage restart — graphical.target stays active across cage cycles
    # and would not re-pull this unit. cage-tty1, in contrast, transitions
    # to active each time it (re)starts, which re-evaluates its wants.
    wantedBy = [ "cage-tty1.service" ];
    # partOf: when cage-tty1 is restarted (now happens automatically on
    # Alt+F4 / chromium crash via Restart=always), systemd propagates the
    # stop+start to this oneshot too. Without partOf, RemainAfterExit=true
    # leaves the unit in "active (exited)" and systemd's wantedBy resolution
    # treats it as already-satisfied, so the rotation doesn't re-apply and
    # the panel comes back in portrait. partOf forces it to deactivate
    # alongside cage so the next cage start re-pulls and re-fires it.
    partOf = [ "cage-tty1.service" ];

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "nixos";
      # cage's wayland socket lives in /run/user/<uid>/. Set explicitly so
      # wlr-randr can find it without depending on a login session.
      Environment = [
        "XDG_RUNTIME_DIR=/run/user/1000"
        "WAYLAND_DISPLAY=wayland-0"
      ];
      ExecStart = pkgs.writeShellScript "cage-rotate-dsi" ''
        # Apply + verify, retrying. Race: when cage-tty1 starts this unit (via
        # wantedBy), the wayland socket may exist before cage has finished
        # registering its DRM output handlers — wlr-randr returns success but
        # the transform doesn't stick. Retrying until `wlr-randr` reports
        # the target transform makes it idempotent and robust to that race.
        wlr_randr=${pkgs.wlr-randr}/bin/wlr-randr
        awk=${pkgs.gawk}/bin/awk
        for attempt in 1 2 3 4 5 6 7 8 9 10; do
          if [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then
            "$wlr_randr" --output DSI-1 --transform 270 2>/dev/null || true
            sleep 1
            current=$("$wlr_randr" 2>/dev/null | "$awk" '/Transform:/ {print $2; exit}')
            if [ "$current" = "270" ]; then
              echo "applied DSI-1 transform 270 after $attempt attempt(s)"
              exit 0
            fi
          fi
          sleep 1
        done
        echo "failed to apply transform after 10 attempts; current=$current" >&2
        exit 1
      '';
    };
  };

  # Pull chromium + wlr-randr into the system closure for ad-hoc ssh debugging
  # (the cage-rotate-dsi unit references wlr-randr by store path anyway).
  # invisibleCursorTheme lands under /run/current-system/sw/share/icons —
  # which is the only directory on chromium's XCURSOR_PATH that we control,
  # since the NixOS session profile overwrites the path we set via the
  # systemd Environment= block. The theme aliases "default" / "Adwaita" /
  # etc. so that whatever name the compositor or chromium falls back to,
  # the cursor renders as a 1×1 transparent pixel.
  environment.systemPackages = with pkgs; [
    chromium
    wlr-randr
    invisibleCursorTheme
  ];

  # Belt-and-suspenders cursor hiding: warp the compositor cursor into the
  # bottom-right corner on a 3-second loop. The transparent XCURSOR theme
  # alone does not always win — wlroots/cage may load a fallback theme out
  # of an unrelated XDG path and chromium 147+ sometimes ignores CSS
  # `cursor: none`. Parking the pointer past the visible viewport keeps
  # the cursor effectively invisible regardless of what theme actually
  # rendered. We use ydotool because it synthesises events through the
  # kernel `uinput` device — no Wayland protocol support required from
  # cage, and the warp survives chromium's per-surface cursor logic.
  programs.ydotool.enable = true;

  systemd.services.cursor-park = {
    description = "Park the kiosk cursor in the bottom-right corner on a loop";
    after = [
      "cage-tty1.service"
      "ydotoold.service"
    ];
    bindsTo = [ "cage-tty1.service" ];
    wantedBy = [ "cage-tty1.service" ];
    serviceConfig = {
      Type = "simple";
      Restart = "always";
      RestartSec = "5s";
      # ydotoold listens on /run/ydotoold/socket (per the NixOS module);
      # the client looks in /tmp/.ydotool_socket by default, so point it
      # at the real path. Running as root means the 0660-group=ydotool
      # socket permission still passes via CAP_DAC_OVERRIDE.
      Environment = [ "YDOTOOL_SOCKET=/run/ydotoold/socket" ];
      ExecStart = pkgs.writeShellScript "cursor-park-loop" ''
        # Sleep first so cage has time to expose the seat / virtual pointer
        # the first uinput device attaches to. Subsequent iterations re-park
        # every 3s — cursor stays where the user last tapped for up to 3s
        # then snaps to the corner.
        sleep 5
        while true; do
          ${pkgs.ydotool}/bin/ydotool mousemove --absolute -- 9999 9999 || true
          sleep 3
        done
      '';
    };
  };
}
