#!/usr/bin/env bash
# BE-Aero Desktop - one-shot Linux installer for the tar.gz build.
#
#   sudo ./install-linux.sh be-aero-desktop-1.0.0.tar.gz
#
# Installs to /opt/aero-widgets, adds a launcher entry and a CLI shim.
# Uninstall later with:  sudo ./install-linux.sh --uninstall
set -euo pipefail

APP_DIR=/opt/be-aero-desktop
BIN_LINK=/usr/local/bin/be-aero-desktop
DESKTOP=/usr/share/applications/be-aero-desktop.desktop
ICON=/usr/share/icons/hicolor/256x256/apps/be-aero-desktop.png

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$APP_DIR"
  rm -f "$BIN_LINK" "$DESKTOP" "$ICON"
  command -v update-desktop-database >/dev/null && update-desktop-database || true
  echo "BE-Aero Desktop removed."
  exit 0
fi

TARBALL="${1:-}"
if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then
  echo "usage: sudo $0 <be-aero-desktop-*.tar.gz>   (or --uninstall)" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "run with sudo: it installs into /opt and /usr/share" >&2
  exit 1
fi

echo "Installing to $APP_DIR ..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
tar -xzf "$TARBALL" -C "$APP_DIR" --strip-components=1

ln -sf "$APP_DIR/be-aero-desktop" "$BIN_LINK"

install -Dm644 "$APP_DIR/resources/app.asar.unpacked/build/icon.png" "$ICON" 2>/dev/null \
  || install -Dm644 "$APP_DIR/resources/icon.png" "$ICON" 2>/dev/null \
  || echo "(icon not found in archive - launcher will use a generic one)"

cat > "$DESKTOP" <<DESK
[Desktop Entry]
Name=BE-Aero Desktop
Comment=Desktop widget sidebar: clock, weather, telemetry, dock, web widgets
Exec=$APP_DIR/be-aero-desktop %U
Icon=be-aero-desktop
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=BE-Aero Desktop
DESK

command -v update-desktop-database >/dev/null && update-desktop-database || true
echo "Done. Launch 'BE-Aero Desktop' from your app menu, or run: be-aero-desktop"
echo "Uninstall any time with: sudo $0 --uninstall"
