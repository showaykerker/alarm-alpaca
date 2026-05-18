# Official 5-inch ILI9881 DSI touch panel orientation.
#
# The overlay's `rotation` param sets the DRM connector's `panel-orientation`
# property; Wayland/X11 compositors honour it and rotate their output
# accordingly. The kernel framebuffer console does *not* read this property,
# so on a headless image the panel still shows its native portrait
# orientation — rotation only becomes visible once a compositor (cage +
# chromium for the kiosk UI) is rendering to this connector.
#
# display_auto_detect (firmware default = 1) is left ON. Setting it to 0
# caused the panel to stop being probed entirely; with it on, declaring
# the overlay adds our rotation param without losing detection. Try
# rotation = 90 if the eventual compositor output is upside-down for the
# physical mounting.
{ ... }:
{
  hardware.raspberry-pi.config.all.dt-overlays.vc4-kms-dsi-ili9881-5inch = {
    enable = true;
    params.rotation = {
      enable = true;
      value = 270;
    };
  };
}
