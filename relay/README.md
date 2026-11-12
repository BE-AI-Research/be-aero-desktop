# BE-Aero Relay Server

Keeps your BE-Aero devices in touch when they are not online at the same time. Run it on any
always-on machine: a home server, a NAS, a Raspberry Pi, or a cloud VM.

When one of your devices is offline, the others leave its messages on the relay:
- state changes (theme, notes, pinned apps, conversations, tasks)
- AI requests, tasks and late answers
- clipboard and web-widget sends

The device collects them when it next connects. Everything is **sealed end to end** for the
device it's meant for. The relay can't read any of it; it only sees who sent an item, to whom,
what kind it is, its size and when.

## Requirements

Node.js 18 or newer. No other dependencies.

## Run it

```bash
node relay.js
```

Then, on the same machine, open pairing:

```bash
node relay.js pair
```

That prints the relay's addresses, its port and a 6-digit code. Then, on each of your devices:
1. Open BE-Aero > Settings > Devices.
2. Choose **Pair by address**.
3. Enter the relay's address and port, then the code.

The relay appears in the device list as **Relay Server**.

```bash
node relay.js status     # paired devices, online or not, and what is waiting for each
```

## Settings

All settings are environment variables.

| Variable | Default | |
|---|---|---|
| `RELAY_DATA` | `~/.be-aero-relay` | Identity, paired devices and the mailbox |
| `RELAY_PORT` | `41811` | The port devices connect to (TCP) |
| `RELAY_ADMIN_PORT` | `41813` | `pair` and `status`; listens on this machine only |
| `RELAY_MAX_GB` | `2` | Storage cap for waiting items |
| `RELAY_TTL_DAYS` | `30` | Items not collected by then are deleted |
| `RELAY_NAME` | `BE-Aero Relay Server (<host>)` | The name your devices see |

To reach the relay from outside your home network, forward `RELAY_PORT` (TCP), or put the
relay and your devices on the same VPN. Connections are TLS 1.3, and both sides are pinned by
device ID.

## Install as a service

- **Linux (systemd):** `sudo bash install-linux.sh`
  - Creates a `be-aero-relay` user and a service that starts at boot.
  - Then run `sudo -u be-aero-relay node /opt/be-aero-relay/relay.js pair` to pair.
- **Windows:** run `install-windows.ps1` in an elevated PowerShell. It creates a scheduled task
  that starts the relay at boot.
- **Docker:**
  ```bash
  docker build -t be-aero-relay .
  docker run -d --name be-aero-relay --restart unless-stopped -p 41811:41811 -v be-aero-relay:/data be-aero-relay
  docker exec be-aero-relay node relay.js pair
  ```
