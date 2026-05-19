# On-device SD-card filesystem layout for the deployed alarm-alpaca host.
#
# Distinct from the installer image (`rpi5-installer` /
# `installerImages.rpi5`), which sources its filesystem layout from
# `nixos-images.nixosModules.sdimage-installer`. Importing this module into
# the installer would collide on `fileSystems."/"`.
#
# Everything that is shared between the deploy target and the installer image
# (normal user, podman, kiosk-ui LAN exposure, stateVersion) lives in
# `alarm-alpaca-runtime.nix`.
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
}
