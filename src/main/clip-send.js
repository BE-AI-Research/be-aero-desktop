// Send to device: this device's clipboard (text or an image) to one paired
// device, only when asked (tray / menu "Send clipboard to"). The receiving
// device puts it on its clipboard and says so; it needs the "clipboard"
// permission for the sender (Settings > Devices).
const MAX_TEXT = 1024 * 1024;          // 1 MB of text
const MAX_IMAGE = 8 * 1024 * 1024;     // 8 MB PNG (fits one mesh frame as base64)

// What is on the clipboard now, as a message - or null when nothing sendable.
function readClip(clipboard) {
  const img = clipboard.readImage();
  if (img && !img.isEmpty()) {
    const png = img.toPNG();
    if (png.length > MAX_IMAGE) throw new Error('the image on the clipboard is too large to send (8 MB at most)');
    const { width, height } = img.getSize();
    return { kind: 'image', png: png.toString('base64'), width, height };
  }
  const text = clipboard.readText();
  if (text) {
    if (Buffer.byteLength(text) > MAX_TEXT) throw new Error('the text on the clipboard is too long to send (1 MB at most)');
    const html = clipboard.readHTML();
    return { kind: 'text', text, ...(html && html.length < MAX_TEXT ? { html } : {}) };
  }
  return null;
}

// Put a received message on the clipboard; returns a short description.
function writeClip(clipboard, nativeImage, msg) {
  if (!msg || typeof msg !== 'object') throw new Error('nothing to paste');
  if (msg.kind === 'image') {
    const buf = Buffer.from(String(msg.png || ''), 'base64');
    if (!buf.length || buf.length > MAX_IMAGE) throw new Error('bad image');
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) throw new Error('bad image');
    clipboard.writeImage(img);
    const { width, height } = img.getSize();
    return `An image (${width} × ${height})`;
  }
  if (msg.kind === 'text') {
    const text = String(msg.text || '');
    if (!text || Buffer.byteLength(text) > MAX_TEXT) throw new Error('bad text');
    if (msg.html) clipboard.write({ text, html: String(msg.html) }); else clipboard.writeText(text);
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > 80 ? `${one.slice(0, 80)}…` : one;
  }
  throw new Error('unknown clipboard content');
}

module.exports = { readClip, writeClip, MAX_TEXT, MAX_IMAGE };
