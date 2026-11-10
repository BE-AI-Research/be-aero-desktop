# BE-Aero Desktop v1.1.2

A fix for Piper voices.

## Fixed

- **Some Piper voices failed with "Phonemes must be one codepoint".** 41 of the voices
  (including en_US amy, joe, mike, hfc_female and en_GB alba, cori, jenny) were made with a
  newer Piper that lists combined sounds the bundled engine cannot read. BE-Aero now gives
  the engine a compatible copy of the voice's settings, so all of them speak, on Linux and
  Windows. Your downloaded files are not modified.
- **Seven voices that need a newer engine** (Chinese, Japanese, Thai, Hebrew and two
  Lithuanian voices) are now shown as "not supported yet" instead of failing after a
  download.

Installed Windows copies update automatically.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
