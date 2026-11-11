# BE-Aero Desktop v1.2.5

Connected devices. Your PCs running BE-Aero can now pair with each other and work as one: shared
files, a shared File Pool, search across devices, assistants that ask each other for help, and the
same theme everywhere. Everything travels directly between your own devices, encrypted, with no
cloud service in between. This release also adds a file browser and a Recycle Bin in the dock.

- **Connected devices**: pair your PCs with a 6-digit code, then choose what each one may do.
- **File browser**: a new widget with network drives, the File Pool, the AI Folder and other
  devices' shared folders.
- **File Pool**: one folder kept the same on all your devices.
- **Search across devices**: the file browser's search also finds files on your other devices.
- **State sync**: the theme everywhere by default; notes, pinned apps, conversations and tasks
  when you turn them on.
- **AI bus**: your assistants can send each other tasks and questions.
- **Shared AI servers**: devices using the same Ollama server stop swapping models out from under
  each other.
- **Send to device**: the clipboard and web widgets, by hand.
- **Dock**: a Recycle Bin / Trash, the bell beside the settings gear, a gear for the system's own
  Settings, and a UAC shield that now really brings up a waiting prompt.
- **Windows**: other apps' notifications in the notification center.
- **Widgets**: right-click any widget to lock it in place.

Device connections are **off** until you turn them on. Nothing changes for a single PC until you
do.

## Connected devices

Turn them on in **Settings > Devices**.

- **Pairing.** One device shows a 6-digit code (valid for 5 minutes, 5 tries). Enter it on the
  other. Devices on the same network find each other automatically; you can also pair by address.
- **Private by design.**
  - Every device has its own identity: a key pair created on first use, stored encrypted with the
    system's secure storage. Its device ID is a long code you can copy from Settings.
  - Devices talk directly over TLS 1.3, and each side checks it's talking to the exact device it
    paired with.
  - No passwords are stored anywhere.
- **You decide what each device may do.** Each paired device has its own switches:
  - **Browse files**: see the folders you share with it (only the File Pool until you share more).
  - **File Pool**: keep the File Pool in sync with it.
  - **Synced state**: theme, notes, pins, conversations, tasks, shared web widgets.
  - **AI requests**: its assistant may send yours tasks and questions.
  - **Notifications** and **Clipboard**: it may send them here.
- **Rename, unpair, or check a connection** from the same list.
- Uses TCP port 41801 and UDP port 41802 (discovery) on your local network.

## File browser

A new widget, parked in the dock until you open it.

- **Places**: your home folders, drives, the File Pool, the AI Folder, network drives and your
  other devices.
- **Address bar**: click the path (or press Ctrl+L) to type one. `~` and environment variables
  work.
- **List or tiles**: a tile view with picture thumbnails and app icons.
- **Search**: type to filter the current folder; it also searches this PC's index, and your other
  devices' shared folders (shown as "On <device>").
- **Everything you'd expect**: open, show in Explorer / Files, copy, cut, paste, rename, new folder,
  copy path, drag files out to other apps and in from them. Deleting sends to the Recycle Bin /
  Trash, never straight to oblivion.
- **Live**: folders refresh by themselves when their contents change.
- **Network drives (SMB)**: connect to `\\server\share` or `smb://server/share`. Your password goes
  straight to Windows or GNOME's own tools and is never stored by BE-Aero.
- **Other devices**: open a paired device to browse what it shares with you. Remote folders are
  read-only here; opening a file downloads it first, and you can copy files to this PC.

### The shared index

Right-click any folder, or empty space for the folder you're in, and choose **Shared index**:
- **All my devices**, or tick devices one at a time.
- Ticked devices can search that folder's files and open them.
- The same list appears under Settings > Devices > "Shared with it", so either place works.

### The AI Folder

The assistant has its own folder, `~/BE-Aero AI` by default:
- Files you attach in chat are kept in **Uploads**.
- The assistant can **write files**, but only inside this folder.
- Every visual it makes is saved in **Visuals** as a web page you can open later.

## File Pool

One folder (`~/BE-Aero Pool`) kept the same on every paired device that allows "File Pool".

- New files, edits, renames and deletes travel both ways.
- Large files are fine: they're sent in pieces and checked by fingerprint (SHA-256).
- A delete on one device moves the file to the Recycle Bin / Trash on the others, never a
  permanent delete. A delete only applies if the other device still has the same version of the
  file.
- When two devices edit the same file at once, neither copy is lost: the other version is kept
  as a "conflict" copy beside it.
- "Copy to File Pool" is on the file browser's right-click menu.

## State sync

Keep things the same on all your devices. Choose what in **Settings > Devices > Keep the same on
my devices**. Only the **theme** is on by default:
- **Theme**
- **Scratchpad notes**
- **Pinned apps** (between devices with the same operating system)
- **AI conversations**
- **Scheduled tasks**
- **Clipboard** (see "Send to device")

How it behaves:
- The newest change to each item wins, and deletes travel too.
- **Conversations** get two sections in the chat list: "Synced to your devices" and "Local - this
  device only". Right-click a chat tab to move it between them. New conversations can start Local.
  Conversations with other devices' assistants (the AI bus) always stay Local.
- **Tasks** sync what they are, not their run history. Each task runs only on the device that
  created it; the others show it with "runs on <device>". A task can be kept to this device only.
- **Web widgets** are shared one at a time instead: right-click a web widget and choose **Share
  with all my devices**, or **Send to** one device as a one-off copy.
- **Window state stays per device.** Size, position, zoom and minimized never sync, so a widget
  can be minimized on your laptop and open on your desktop.

## AI bus: assistants that work together

Your assistants on different devices can now talk to each other (each device needs "AI requests"
allowed for the other).

- **New tools**: the assistant can list your devices, ask another device's assistant a question
  and wait for the answer, send it a task, and check what has arrived.
- **Answers always come back.** A question waits up to 5 minutes. An answer that arrives later
  still reaches the conversation that asked.
- **Your desktop stays yours.** Work from another device runs in its own "AI bus" conversation and
  can't drive this desktop (windows, mouse, keyboard) unless you allow it in Settings > AI
  assistant.
- **Safeguards**: rate limits, and requests can't be passed along more than 3 times.

## Shared AI servers

When your devices use the same local AI server (for example one Ollama box on your network),
they now coordinate instead of fighting over it:
- **Follow the loaded model.** If your model isn't loaded but one your other device uses is, this
  turn uses that one instead of swapping models, and says so in the chat. Turn this off in
  Settings > AI assistant.
- **Never evict each other.** A model one of your devices is using (or used in the last few
  minutes) is never unloaded to make room. BE-Aero waits for it instead.

## Send to device

- **Clipboard**: "Send clipboard to ▸ <device>" in the tray menu sends text or an image. The other
  device puts it on its clipboard and shows a notification. Only ever sent by hand. Turn on
  "Clipboard" in Settings > Devices first. While it's off, the menu item is hidden and clipboards
  from other devices are refused.
- **Web widgets**: right-click a web widget > **Send to** a device.

## Dock

- **Recycle Bin / Trash.** A new tile:
  - The icon fills when there's something in it.
  - Click to open it.
  - Right-click to open or empty it. Emptying asks first.
  - Drop files on it to delete them.
  - Turn it off under Settings > Dock.
- **The bell moved** next to the settings gear, on its left.
- **The system's own Settings**: a gear next to the power button opens Windows Settings or your
  Linux desktop's settings.
- **UAC shield**: when Windows holds an admin prompt back (a flashing "User Account Control"
  button on the taskbar), click the shield to bring it up. In 1.2.1 this could fail silently. A
  click with no prompt waiting opens the shield's menu, as before.
- **Pinned apps follow the dock's lock**: unlocked, drag them to reorder; locked, they stay put.

## Widgets and layout

- **Lock a widget in place.** Right-click any widget > **Lock in place** (free-form layout). It
  can't be moved or resized until you unlock it. The global lock in Settings still locks them all.
- **New widgets open in the middle of the display** in free-form layout, instead of at the edge.
- **Search bar**: a drop-down of recent files and recently used apps.
- **The assistant's visuals on the desktop** now show their reload, delete and close buttons on
  hover. Before, they never appeared.

## Windows

- **Other apps' notifications** appear in the notification center, as they already do on Linux.
  BE-Aero reads Windows' own notification list; it never changes or dismisses anything, and
  Windows still shows its usual pop-ups. Use "Collect notifications from all apps" in the
  notification settings to turn it off.

## Linux

- **Dock**: apps are matched to their real names and icons from every installed `.desktop` file
  and your icon theme. Apps started through a wrapper script are recognised, each app gets one
  tile, and installed web apps get their own.

## Fixed

- The browser list under "Browser the assistant uses" sometimes stayed empty.
- A hidden control character in the chat code broke a text-matching check.
- File browser margins, a readable notification count badge, and quieter scrollbars.

## Install and update

Installed Windows copies update automatically.

Linux install or update:

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
