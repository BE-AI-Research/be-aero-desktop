# BE-Aero Desktop v1.0.5

The actual Linux fix. Research against Electron's issue tracker found the
root cause behind every Linux symptom since 1.0.1: Electron 38+ selects its
display platform *before application code runs*, so the app's own "force
X11" switch never took effect and under a Wayland session it ran as a
native Wayland client - where a window cannot position itself (it is always
centered on the active display) and every X11 facility the sidebar depends
on (dock window type, input shape regions) silently does nothing.

## Fixed

- **The app now really runs on X11/XWayland.** The `--ozone-platform=x11`
  flag is placed on the real command line at every launch path: the CLI
  command is now a wrapper script carrying it, the menu entry and the
  autostart entry include it, and if the raw binary is started flagless
  under Wayland the app relaunches itself once with the flag. With the
  platform actually X11, the 1.0.4 dock-window model finally applies:
  the sidebar docks to the screen edge, takes mouse input, and its toolbar
  (with the menu button) sits below GNOME's top bar.
- **`--doctor` now reports the effective platform** ("x11 (forced via
  command line)" vs a warning that the app is running native Wayland),
  instead of echoing the app's intention.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```

If you installed 1.0.4 or earlier, re-running the installer is required:
the fix lives partly in the launcher files it writes.
