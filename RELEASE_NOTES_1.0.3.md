# BE-Aero Desktop v1.0.3

Linux compatibility release, round two - a structural fix for input and a real
review of every Linux path. Installed Windows copies update automatically.

## Fixed / changed

- **Linux input, properly this time.** v1.0.2 tried cursor polling, which dies
  under XWayland: the moment the pointer is over the desktop (a Wayland
  surface), X11 apps stop seeing it, so the window stayed deaf. The window now
  always accepts input and an X11 shape region decides where: in docked mode
  the whole sidebar strip is interactive, in free-form mode exactly the widget
  rectangles are (reported live by the renderer, padded for grips and glows).
  No polling, no forwarding, no click-through games.
- **Aero Search knows Linux applications.** `.desktop` entries from the system,
  user, Flatpak and Snap application directories are indexed (respecting
  `NoDisplay`/`Hidden` and XDG user-over-system precedence) and launch through
  `gio launch`, with a direct `Exec=` fallback. Windows-only `ms-settings:`
  results no longer appear on Linux.
- **`--doctor` diagnostics.** `be-aero-desktop --doctor` prints app/Electron
  versions, session type (X11/Wayland), desktop environment, display map and
  capability report - paste it into any bug report.
- **Window position** is re-asserted twice after mapping and the app logs when
  a window manager refuses it.

## Linux install / update

```bash
curl -fLO --progress-bar https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/be-aero-desktop.tar.gz
curl -fLO https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh
sudo bash install-linux.sh be-aero-desktop.tar.gz
```
