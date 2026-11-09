# BE-Aero Desktop v1.0.9

Bug-fix release for the dock. Installed Windows copies update automatically.

## Fixed

- **Dock hotkey.** Two problems hid behind one symptom. The settings store kept the
  layout mode and the app-dock settings under the same key, so the hotkey, pins and
  alignment could never be read back (and saving them would have broken the layout
  mode); the app-dock settings now have their own key, migrated automatically. And the
  summoned dock was being pushed back behind your windows 50 ms after it appeared;
  it now stays up until you pick an app or press the hotkey again.
- **Notification bell.** The bell in the dock had no clickable area, so the
  notification panel never opened from a real click. It is now a proper dock tile.
- **Pins and dock alignment** persist correctly as a result of the key fix.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
