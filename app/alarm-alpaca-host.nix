# Host-specific bits for the running alarm-alpaca RPi5: disk layout,
# normal user, podman, kiosk-ui LAN exposure, stateVersion.
#
# Distinct from the installer image (which gets a generic root user and
# nixos-images' own filesystem layout) because the deploy target needs
# the real SD-card filesystem definitions to activate via deploy-rs.
{ ... }:
{
  # Hardware: SD card filesystem layout (from /etc/fstab on the running system).
  fileSystems."/" = {
    device = "/dev/disk/by-label/NIXOS_SD";
    fsType = "ext4";
    options = [ "noatime" ];
  };
  fileSystems."/boot/firmware" = {
    device = "/dev/disk/by-label/FIRMWARE";
    fsType = "vfat";
    options = [
      "noatime"
      "noauto"
      "x-systemd.automount"
      "x-systemd.idle-timeout=1min"
    ];
  };

  users.users.nixos = {
    isNormalUser = true;
    group = "users";
    extraGroups = [
      "wheel"
    ];
  };

  virtualisation.podman.enable = true;
  virtualisation.podman.dockerCompat = true;

  # Open the kiosk UI to the LAN so phones.txt etc. can be edited from a
  # phone/laptop on the same network. HTTP Basic auth (admin /
  # secrets/kiosk-password) gates non-loopback clients; the on-device
  # Chromium kiosk hits 127.0.0.1 and is exempt.
  services.alarm-kiosk.exposeToLan = true;

  system.stateVersion = "25.11";
}
