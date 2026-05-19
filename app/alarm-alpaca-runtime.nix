# Host-runtime bits shared between the deploy target (`alarm-alpaca`) and the
# bootable SD-image installer (`rpi5-installer`): normal `nixos` user, podman,
# kiosk-ui LAN exposure, stateVersion.
#
# Kept separate from `alarm-alpaca-host.nix` (which carries the on-device SD
# filesystem layout) because the installer image gets its filesystem layout
# from `nixos-images.nixosModules.sdimage-installer` and would conflict on
# `fileSystems."/"` if it imported the host module wholesale.
#
# Note on the `nixos` user: the installer profile (`installation-device.nix`,
# pulled in via `sdimage-installer`) also declares `users.users.nixos` with
# `extraGroups = [ "wheel" "networkmanager" "video" ]` and an empty initial
# password. NixOS module merging concatenates `extraGroups` lists, so the
# installer image ends up with both sets (duplicate `wheel` is harmless). The
# deployed system only sees this module's definition (`wheel` only), matching
# previous behaviour.
{ ... }:
{
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
