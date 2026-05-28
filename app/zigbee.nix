# zigbee2mqtt + mosquitto stack, declared as podman oci-containers so they
# start at boot and survive reboots without manual intervention. Replaces
# the previous app/docker-compose.yaml.
{
  config,
  pkgs,
  lib,
  ...
}:
let
  # Sonoff Zigbee 3.0 USB Dongle Plus V2 (ZBDongle-E, EFR32MG21).
  # by-id path is stable across reboots and USB re-enumeration.
  zigbeeDevice = "/dev/serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_a469ee8fc84bef11a740baa079f42d1b-if00-port0";

  # Seeded once via systemd.tmpfiles 'C' action; z2m owns it afterwards
  # and persists pairings/network-key into the same file.
  initialZ2MConfig = pkgs.writeText "configuration.yaml" ''
    version: 4
    homeassistant:
      enabled: false
    frontend:
      enabled: true
      port: 8080
    mqtt:
      base_topic: zigbee2mqtt
      server: mqtt://mosquitto:1883
    serial:
      # Sonoff ZBDongle-E (EFR32MG21) uses EmberZNet.
      # z2m 2.x dropped autodetect for this; must set explicitly.
      adapter: ember
      port: /dev/ttyACM0
  '';
in
{
  systemd.tmpfiles.rules = [
    "d /var/lib/mosquitto       0755 root root - -"
    "d /var/lib/mosquitto/data  0755 root root - -"
    "d /var/lib/mosquitto/log   0755 root root - -"
    "d /var/lib/zigbee2mqtt     0755 root root - -"
    "C /var/lib/zigbee2mqtt/configuration.yaml 0644 root root - ${initialZ2MConfig}"
  ];

  # Broker is reachable only from the device itself (host loopback + the
  # podman alarm-net for the z2m container). LAN clients cannot publish, so
  # they cannot forge a `{"action":"single"}` payload on zigbee2mqtt/+ that
  # would trigger a real TAS callout. allow_anonymous=true is safe under
  # that constraint; broker auth + per-topic ACLs become relevant only if
  # we ever re-expose the listener beyond loopback.
  environment.etc."mosquitto/mosquitto.conf".text = ''
    listener 1883
    allow_anonymous true
    persistence true
    persistence_location /mosquitto/data/
    log_dest stdout
  '';

  virtualisation.oci-containers.backend = "podman";

  virtualisation.oci-containers.containers.mosquitto = {
    # Digest-pinned to defeat supply-chain repointing of the `:2` tag. To
    # bump: `skopeo inspect --raw docker://docker.io/library/eclipse-mosquitto:2 \
    # | sha256sum` (the index digest covers all arches; podman picks arm64/v8
    # on the device).
    image = "docker.io/library/eclipse-mosquitto:2@sha256:a908c65cc8e67ec9d292ef27c2c0360dbaaee7eb1b935cdd194e67697f15dea1";
    autoStart = true;
    # Bind to loopback only. Inter-container traffic (z2m → mosquitto) flows
    # over the podman alarm-net via container DNS, not this host port.
    # Host clients (alarm-bridge, kiosk-ui, alarm-smoke) reach the broker via
    # 127.0.0.1:1883 as before.
    ports = [ "127.0.0.1:1883:1883" ];
    volumes = [
      "/etc/mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro"
      "/var/lib/mosquitto/data:/mosquitto/data"
      "/var/lib/mosquitto/log:/mosquitto/log"
    ];
    environment.TZ = "Asia/Taipei";
    extraOptions = [ "--network=alarm-net" ];
  };

  virtualisation.oci-containers.containers.zigbee2mqtt = {
    # Digest-pinned (see mosquitto comment above for bump procedure).
    image = "docker.io/koenkk/zigbee2mqtt:2.1.1@sha256:c7b111384716247f057b449ebb242bf05f3fafb98dd6d5688c1ac1fc730d5e95";
    autoStart = true;
    # Same rationale as mosquitto above — frontend is for occasional
    # admin use via SSH port-forward, not LAN exposure.
    ports = [ "127.0.0.1:8080:8080" ];
    volumes = [
      "/var/lib/zigbee2mqtt:/app/data"
      "/run/udev:/run/udev:ro"
    ];
    environment.TZ = "Asia/Taipei";
    extraOptions = [
      "--network=alarm-net"
      "--device=${zigbeeDevice}:/dev/ttyACM0"
    ];
    dependsOn = [ "mosquitto" ];
  };

  # Default podman 'bridge' network has no DNS; containers need a
  # user-defined network to resolve each other by name (z2m → mosquitto).
  systemd.services.podman-network-alarm-net = {
    description = "Create podman network alarm-net";
    after = [ "network.target" ];
    before = [
      "podman-mosquitto.service"
      "podman-zigbee2mqtt.service"
    ];
    requiredBy = [
      "podman-mosquitto.service"
      "podman-zigbee2mqtt.service"
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      ${pkgs.podman}/bin/podman network exists alarm-net \
        || ${pkgs.podman}/bin/podman network create alarm-net
    '';
  };

  # No firewall openings: mosquitto and the z2m frontend are bound to
  # 127.0.0.1 in their port mappings above. Admin access to the z2m UI is
  # via `ssh -L 8080:localhost:8080 nixos@alarm-alpaca.local`.
}
