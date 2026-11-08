# BE-Aero Desktop v1.0.4

The GNOME fix: the docked sidebar is now a real dock window. Installed
Windows copies update automatically; Windows behavior is unchanged.

## Fixed

- **Linux: the sidebar docks and takes input on GNOME.** Diagnosis from a
  live Debian GNOME (Wayland) system showed the window manager treating the
  sidebar as a normal application window: centered by placement policy, move
  requests refused, input dead. The docked sidebar now declares itself an X11
  dock window (`_NET_WM_WINDOW_TYPE_DOCK`) - window managers let docks
  position themselves, keep them on every workspace and give them input like
  any panel. Switching between docked and free-form rebuilds the window,
  since X11 window types are fixed at creation.
- **Input shape can never be empty.** The docked strip now sets its full
  rectangle as the interactive region instead of relying on "empty list means
  rectangular", which an implementation could read as an empty - deaf -
  region.
- **GNOME top bar no longer covers the toolbar.** GNOME on Wayland draws its
  top bar as shell chrome that the X work area knows nothing about, so the
  sidebar's toolbar (and its menu button) rendered underneath it. The strip
  now insets below the bar on GNOME.
- Tray creation can never disturb startup (stock GNOME has no tray; the
  toolbar's menu button is the menu there), and Linux startup logs one
  greppable session line.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
