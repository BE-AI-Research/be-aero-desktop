# BE-Aero Desktop v1.0.2

Linux usability release: the app is now actually operable on Linux desktops.
Installed Windows copies update themselves to this release automatically.

## Fixed

- **Linux: mouse input works.** The click-through layer relied on mouse-event
  forwarding that Electron only provides on Windows and macOS, so on Linux the
  window ignored the mouse forever. The app now polls the cursor while
  click-through and hands the renderer probe points, so widgets reclaim the
  mouse exactly like they do on Windows.
- **Linux: window lands where it should.** The app now runs on X11/XWayland
  (`--ozone-platform=x11`) because Wayland gives apps no control over window
  position, and re-asserts its bounds right after the window maps - window
  managers that center frameless windows (GNOME) no longer leave it in the
  middle of the screen.
- **Menu without a tray.** Stock GNOME has no system tray, which orphaned
  every tray-only control. The sidebar toolbar now has a menu button opening
  the full app menu (widgets, position, theme, updates, quit) in-window, on
  every platform.
- **Update checks could silently stop.** Changing telemetry settings cleared
  the periodic release-check timer; it now survives.

## Linux install / update

```bash
curl -fsSLO https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/be-aero-desktop.tar.gz
curl -fsSLO https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh
sudo bash install-linux.sh be-aero-desktop.tar.gz
```
