# BE-Aero Desktop v1.1.1

A fix for the media controller on Linux.

## Fixed

- **The media widget said "unavailable" on Linux.** It relied on `playerctl`, which most
  distributions (Debian included) do not install. It now talks to media players directly
  over D-Bus, which every desktop session has, so Spotify, Firefox, Chrome, VLC and other
  players show up with title, artist, cover art and a live progress line. Play/pause,
  next/previous and dragging to seek work the same way. If `playerctl` is installed it is
  still used.

Installed Windows copies update automatically (no change in behaviour on Windows).

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
