#!/usr/bin/env bash
# BE-Aero Relay Server: install as a systemd service.
#   sudo bash install-linux.sh             install / update
#   sudo bash install-linux.sh --uninstall remove (keeps its data)
set -euo pipefail
DIR=/opt/be-aero-relay
USER_NAME=be-aero-relay
DATA=/var/lib/be-aero-relay
UNIT=/etc/systemd/system/be-aero-relay.service
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now be-aero-relay 2>/dev/null || true
  rm -f "$UNIT"; systemctl daemon-reload
  rm -rf "$DIR"
  echo "Removed. Its data is still in $DATA (delete it to forget the paired devices)."
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "Node.js 18+ is needed (e.g. apt install nodejs)" >&2; exit 1; fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then echo "Node.js 18+ is needed (found $("$NODE" -v))" >&2; exit 1; fi

id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$DIR" "$DATA"
cp -r "$HERE"/. "$DIR"/
chown -R root:root "$DIR"
chown -R "$USER_NAME": "$DATA"
chmod 700 "$DATA"

cat > "$UNIT" <<UNIT
[Unit]
Description=BE-Aero Relay Server
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
Environment=RELAY_DATA=$DATA
ExecStart=$NODE $DIR/relay.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now be-aero-relay
sleep 1
systemctl --no-pager --lines=3 status be-aero-relay || true
echo
echo "Installed. Pair your devices with:"
echo "    sudo -u $USER_NAME RELAY_DATA=$DATA node $DIR/relay.js pair"
