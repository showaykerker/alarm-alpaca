# NetworkManager + avahi mDNS.
#
# No declarative WiFi profile: new devices bootstrap via ethernet, then a
# user adds WiFi from the kiosk UI (Network page → tap SSID). nmcli stores
# the resulting profile in /etc/NetworkManager/system-connections, which
# is persistent across reboots, so the device autoconnects on next boot
# without further intervention.
#
# avahi publishes the device's hostname so SSH/HTTP via <hostname>.local
# works on the LAN without knowing the IP. publish.* defaults are all off
# in NixOS — without enabling them, avahi only listens and never
# broadcasts.
{ ... }:
{
  networking.networkmanager.enable = true;
  users.users.nixos.extraGroups = [ "networkmanager" ];

  services.avahi = {
    enable = true;
    nssmdns4 = true;
    publish = {
      enable = true;
      addresses = true;
      workstation = true;
    };
    # Exclude container bridge to avoid confusing avahi's interface selection
    denyInterfaces = [ "podman0" ];
  };
}
