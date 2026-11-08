#!/usr/bin/env bash
# BE-Aero Desktop - one-shot Linux installer.
#
#   curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
#
# With no argument it downloads the latest release itself; pass a local
# tar.gz to install that instead. Installs to /opt/be-aero-desktop, adds a
# launcher entry and a CLI shim.
# Uninstall later with:  sudo ./install-linux.sh --uninstall
set -euo pipefail

APP_DIR=/opt/be-aero-desktop
BIN_LINK=/usr/local/bin/be-aero-desktop
DESKTOP=/usr/share/applications/be-aero-desktop.desktop
ICON=/usr/share/icons/hicolor/256x256/apps/be-aero-desktop.png
TARBALL_URL="https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/be-aero-desktop.tar.gz"

if [[ $EUID -ne 0 ]]; then
  echo "run with sudo: it works in /opt and /usr/share" >&2
  exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$APP_DIR"
  rm -f "$BIN_LINK" "$DESKTOP" "$ICON"
  command -v update-desktop-database >/dev/null && update-desktop-database || true
  echo "BE-Aero Desktop removed."
  exit 0
fi

TARBALL="${1:-}"
CLEANUP=""
if [[ -z "$TARBALL" ]]; then
  # No tarball given: fetch the latest release ourselves.
  CLEANUP="$(mktemp -d)"
  TARBALL="$CLEANUP/be-aero-desktop.tar.gz"
  echo "Downloading the latest release (~120 MB) ..."
  if command -v curl >/dev/null; then
    curl -fL --progress-bar -o "$TARBALL" "$TARBALL_URL"
  elif command -v wget >/dev/null; then
    wget -q --show-progress -O "$TARBALL" "$TARBALL_URL"
  else
    echo "need curl or wget to download $TARBALL_URL" >&2
    exit 1
  fi
elif [[ ! -f "$TARBALL" ]]; then
  echo "usage: sudo $0 [be-aero-desktop-*.tar.gz]   (no argument = download latest; or --uninstall)" >&2
  exit 1
fi
trap '[[ -n "$CLEANUP" ]] && rm -rf "$CLEANUP"' EXIT

echo "Installing to $APP_DIR ..."
# A running copy would keep its single-instance lock while its files vanish
# underneath it - every later launch would then quit silently. Stop it first.
if pkill -f "$APP_DIR/be-aero-desktop" 2>/dev/null; then
  echo "(stopped the running BE-Aero Desktop)"
  sleep 1
fi
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
tar -xzf "$TARBALL" -C "$APP_DIR" --strip-components=1

# The tarball is produced on Windows, which has no Unix permission bits, so
# every file arrives mode 644 - the app would be unlaunchable without this.
chmod 755 "$APP_DIR/be-aero-desktop" "$APP_DIR/chrome_crashpad_handler"
chown root:root "$APP_DIR/chrome-sandbox"
chmod 4755 "$APP_DIR/chrome-sandbox"   # Chromium's setuid sandbox helper

# A wrapper, not a symlink: the Ozone platform flag has to be on the real
# command line (Electron picks X11 vs Wayland before app code runs, and as
# a native Wayland client the app cannot position itself or shape input).
cat > "$BIN_LINK" <<'SHIM'
#!/bin/sh
exec /opt/be-aero-desktop/be-aero-desktop --ozone-platform=x11 "$@"
SHIM
chmod 755 "$BIN_LINK"

install -Dm644 "$APP_DIR/resources/app.asar.unpacked/build/icon.png" "$ICON" 2>/dev/null \
  || install -Dm644 "$APP_DIR/resources/icon.png" "$ICON" 2>/dev/null \
  || echo "(icon not found in archive - launcher will use a generic one)"

cat > "$DESKTOP" <<DESK
[Desktop Entry]
Name=BE-Aero Desktop
Comment=Desktop widget sidebar: clock, weather, telemetry, dock, web widgets
Exec=$APP_DIR/be-aero-desktop --ozone-platform=x11 %U
Icon=be-aero-desktop
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=BE-Aero Desktop
DESK

command -v update-desktop-database >/dev/null && update-desktop-database || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
echo "Done. Launch 'BE-Aero Desktop' from your app menu, or run: be-aero-desktop"
echo "Uninstall any time with: sudo $0 --uninstall"
