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

main() {
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
  rm -rf /usr/share/gnome-shell/extensions/be-aero-dock@be-ai-research
  rm -f /usr/local/sbin/be-aero-desktop-update /etc/sudoers.d/be-aero-desktop-update
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
# underneath it - every later launch would then quit silently. Stop it first,
# escalating to SIGKILL for a copy too wedged to honour SIGTERM.
if pkill -f "$APP_DIR/be-aero-desktop" 2>/dev/null; then
  echo "(stopped the running BE-Aero Desktop)"
  sleep 1
  pkill -9 -f "$APP_DIR/be-aero-desktop" 2>/dev/null && sleep 1 || true
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

# The Sound widget uses pactl. On PipeWire desktops (Debian 13, Fedora...)
# it is often missing; the package adds only the command-line tool, not the
# PulseAudio sound server. Best effort: the widget falls back to wpctl.
if ! command -v pactl >/dev/null; then
  echo "Installing pactl for the Sound widget..."
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q pulseaudio-utils >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null; then
    dnf install -y -q pulseaudio-utils >/dev/null 2>&1 || true
  elif command -v zypper >/dev/null; then
    zypper --non-interactive install pulseaudio-utils >/dev/null 2>&1 || true
  elif command -v pacman >/dev/null; then
    pacman -S --needed --noconfirm libpulse >/dev/null 2>&1 || true
  fi
  if command -v pactl >/dev/null; then echo "pactl installed."; else echo "Could not install pactl; the Sound widget uses PipeWire's wpctl instead."; fi
fi

# GNOME on Wayland: the dock can only mirror real windows through a Shell
# extension. Install it system-wide; the user enables it once.
EXT_UUID=be-aero-dock@be-ai-research
if [ -d /usr/share/gnome-shell ] && [ -d "$APP_DIR/resources/gnome-extension/$EXT_UUID" ]; then
  mkdir -p "/usr/share/gnome-shell/extensions/$EXT_UUID"
  cp "$APP_DIR/resources/gnome-extension/$EXT_UUID/"* "/usr/share/gnome-shell/extensions/$EXT_UUID/"
  chmod 644 "/usr/share/gnome-shell/extensions/$EXT_UUID/"*
  echo "GNOME dock helper installed. Enable it (then log out and back in on Wayland):"
  echo "    gnome-extensions enable $EXT_UUID"
fi

# Automatic updates (Linux): a root helper that installs ONE thing - a
# published release of BE-Aero Desktop, by version number, downloaded from
# GitHub and checked against the release's SHA256SUMS.txt. The app runs it
# through sudo; "--allow USER" (asked once, through pkexec, when the user
# turns automatic updates on) lets that user run it without a password.
UPD=/usr/local/sbin/be-aero-desktop-update
cat > "$UPD" <<'HELPER'
#!/bin/sh
# be-aero-desktop-update X.Y.Z      install that published release
# be-aero-desktop-update --allow USER | --disallow USER
set -eu
REPO=BE-AI-Research/be-aero-desktop
RULE=/etc/sudoers.d/be-aero-desktop-update
case "${1:-}" in
  --allow|--disallow)
    U="${2:-}"
    printf '%s' "$U" | grep -Eq '^[a-z_][a-z0-9_.-]{0,31}$' || { echo "bad user name" >&2; exit 2; }
    id "$U" >/dev/null 2>&1 || { echo "no such user" >&2; exit 2; }
    if [ "$1" = "--disallow" ]; then
      [ -f "$RULE" ] && grep -v "^$U " "$RULE" > "$RULE.tmp" || : > "$RULE.tmp"
    else
      { [ -f "$RULE" ] && grep -v "^$U " "$RULE" || true; echo "$U ALL=(root) NOPASSWD: /usr/local/sbin/be-aero-desktop-update [0-9]*"; } > "$RULE.tmp"
    fi
    chmod 440 "$RULE.tmp"
    if [ -s "$RULE.tmp" ]; then
      visudo -cf "$RULE.tmp" >/dev/null || { rm -f "$RULE.tmp"; echo "sudoers check failed" >&2; exit 1; }
      mv "$RULE.tmp" "$RULE"
    else
      rm -f "$RULE.tmp" "$RULE"
    fi
    echo ok; exit 0 ;;
esac
V="${1:-}"
printf '%s' "$V" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$' || { echo "usage: $0 X.Y.Z" >&2; exit 2; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
B="https://github.com/$REPO/releases/download/v$V"
get() { if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
get "$B/SHA256SUMS.txt" "$T/SHA256SUMS.txt" || { echo "v$V has no published checksums - not installing it automatically" >&2; exit 1; }
WANT="$(grep -E " \*?be-aero-desktop-$V\.tar\.gz$" "$T/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
[ -n "$WANT" ] || { echo "no checksum for be-aero-desktop-$V.tar.gz" >&2; exit 1; }
get "$B/be-aero-desktop-$V.tar.gz" "$T/app.tar.gz"
GOT="$(sha256sum "$T/app.tar.gz" | awk '{print $1}')"
[ "$GOT" = "$WANT" ] || { echo "checksum mismatch - not installing" >&2; exit 1; }
WANT_SH="$(grep -E " \*?install-linux\.sh$" "$T/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
get "$B/install-linux.sh" "$T/install-linux.sh"
[ -n "$WANT_SH" ] && [ "$(sha256sum "$T/install-linux.sh" | awk '{print $1}')" = "$WANT_SH" ] || { echo "installer checksum missing or wrong - not installing" >&2; exit 1; }
bash "$T/install-linux.sh" "$T/app.tar.gz"
HELPER
chmod 755 "$UPD"
chown root:root "$UPD"

echo "Done. Launch 'BE-Aero Desktop' from your app menu, or run: be-aero-desktop"
echo "Uninstall any time with: sudo bash install-linux.sh --uninstall"
}

main "$@"
