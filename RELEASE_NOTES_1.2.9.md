# BE-Aero Desktop v1.2.9

A real file manager, control of your other devices' music and volume, tidier notifications, a
dock that knows your web apps, automatic updates on Linux, and a full review for security and
reliability.

- **File browser**: copy and move with progress, pause and stop; separate windows; drag and drop
  between them; click to open; a resizable sidebar.
- **Other devices' media and volume**: play, pause, skip and set the volume on your other
  devices from Now Playing and Sound.
- **Notifications**: grouped by app and by conversation, and shown on the web widget they came
  from.
- **Your widgets**: a widget tray in the dock and in the BE-Aero menu, with a close button on
  every widget the assistant makes.
- **Dock**: Chrome / Edge web apps and Store apps get their own tiles; Suspend and Hibernate in
  the power menu.
- **Devices**: removing a device removes it on both sides, pairing again just works, and you can
  keep your File Pool to yourself.
- **Linux**: automatic updates.
- **Security and reliability**: about 40 fixes from a review of the whole app.

Works with BE-Aero Relay Server 1.0.2 (older relays still work).

## File browser

- **Copy and move as jobs.** Paste, drag and drop, and "Copy to File Pool" show a panel under the
  list: progress, size, files, speed and time left, with **Pause**, **Resume** and **Stop**. A
  stopped copy leaves no half-written file; a move removes the original only once all of it was
  copied.
- **Separate windows.** The new-window button, or right-click a folder > **Open in new window**.
  Open as many as you like.
- **Drag and drop** between windows, onto a folder, and to and from other apps. Copy by default;
  hold **Shift** to move. Files on your other devices can be dragged too.
- **A click opens** a folder or file. **Ctrl** / **Shift**-click selects, and dragging a box over
  empty space selects what it covers.
- **Resizable sidebar.** Drag the divider; drag it all the way left, or double-click it, to hide
  the sidebar.
- Folders on a relay with tens of thousands of files open again: the relay now sends its file
  list in pages.

## Your other devices' music and volume

**Now Playing** and **Sound** have a device drop-down: this device, or any of your devices that is
connected. See what's playing there and control it, change its volume and its app mixer. In
Sound, **All devices** shows each device's volume side by side. Each device has a new
**Media & volume** permission in Settings > Devices.

## Notifications

- **Grouped.** Each app shows its newest notification; the older ones fold under it ("3 earlier")
  and, for chat apps, by conversation, each with its own earlier messages. Dismiss a whole app, a
  conversation, or one message.
- **On web widgets.** A web widget (Google Chat, Calendar...) gets a bell with its unread count;
  click it for that widget's notifications. A new one slides in at the top of the widget for a
  few seconds.

## Widgets

- **Widget tray**, left of the bell in the dock and as **Your widgets** in the BE-Aero menu: the
  widgets you made, each with show / hide, open and delete. The **+** adds one: ask the
  assistant, an HTML file, or a web page.
- **Close** on every widget and visual the assistant makes. A widget saves its state first (it
  gets an `aero:close` event) and comes back from the widget tray.

## Dock

- **Web apps** installed from Chrome or Edge (YouTube Music, GitHub...) get their own tile, name
  and icon instead of all appearing as Chrome.
- **Store apps** (Settings, Calculator, Photos...) get their own tiles instead of one "Store app".
- **Power menu:** **Suspend (sleep)** and **Hibernate**. Hibernate is greyed out, with how to turn
  it on, when Windows has it off.
- **Screen saver:** while it runs, the widgets step aside - nothing shows over it - and come back
  afterwards.

## Devices

- **Removing a device removes it on both sides**: at once if it's connected, or the next time it
  connects.
- **Pairing again just works.** If the other device still has an old pairing, it's replaced with a
  fresh one when you pair with the code.
- **Settings > Devices > Address…** tells a device or relay where it moved (a new IP address).
- **Share my File Pool with my devices** (in the BE-Aero menu): turn it off to keep your File Pool
  on this device - no syncing, browsing or relay copy - and still connect to other people's
  devices.
- **Relay storage:** uploads and downloads resume after an interruption; when two devices change
  the same file, both versions are kept.

## Linux: automatic updates

**Install updates automatically** now works on Linux. Turning it on asks for your password once,
to let BE-Aero run its update helper. New releases install when the computer has been idle for 5
minutes, and BE-Aero restarts; Settings shows **Install now** if you don't want to wait. Only
published releases whose checksums match are installed. Reinstall once with this release's
`install-linux.sh` to get the helper.

## Security and reliability

A review of the whole app, with about 40 fixes. The most important:

- **Web widgets** are fully sandboxed in installed builds, and a site can no longer use your
  camera, microphone or location, or open other apps through a link.
- **Files from other devices** can't be written outside the folder you copy them into.
- **The assistant** asks before reading your clipboard or saving memories, can't give a scheduled
  task full permission (only you can, in Settings), and shows the important parts of what it
  wants to run in full.
- **No lost data:** settings are saved safely (a torn file falls back to the backup), the relay
  confirms a file only once it's safely stored, and storage keys that can't be read are never
  replaced.
- **Fixes:** the assistant's tools work with Claude again (two tools shared a name), scheduled
  tasks no longer stall, Pause/Stop clicks are never lost, and a crashed background helper can no
  longer take the app down.

## Install or update

**Windows:** installed copies update themselves. New install: download
`BE-Aero-Desktop-Setup.exe`.

**Linux:**

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```

Checksums for every file are in `SHA256SUMS.txt`.
