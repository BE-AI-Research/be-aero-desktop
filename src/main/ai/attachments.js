// File attachments for chat messages. Conversations store only metadata
// ({ name, path, size, mime, kind }); the bytes are read from disk when a
// request is built, so history stays small and a moved file degrades to a
// note instead of a broken request.
const fs = require('fs');
const path = require('path');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.sh', '.ps1', '.bat', '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.svg', '.env', '.gitignore', '.dockerfile']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;     // API image limit
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_CHARS = 120000;

function describe(filePath) {
  const st = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  let kind = 'other';
  let mime = 'application/octet-stream';
  if (IMAGE_TYPES[ext]) { kind = 'image'; mime = IMAGE_TYPES[ext]; }
  else if (ext === '.pdf') { kind = 'pdf'; mime = 'application/pdf'; }
  else if (TEXT_EXTS.has(ext) || ext === '') { kind = 'text'; mime = 'text/plain'; }
  return { name: path.basename(filePath), path: filePath, size: st.size, mime, kind };
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readText(att) {
  const txt = fs.readFileSync(att.path, 'utf8');
  return txt.length > MAX_TEXT_CHARS ? txt.slice(0, MAX_TEXT_CHARS) + `\n... (${txt.length - MAX_TEXT_CHARS} more characters)` : txt;
}

// Provider-neutral rendering: a list of parts the adapters map to their
// wire format. Part types: text | image (base64) | pdf (base64).
function render(att) {
  try {
    if (!fs.existsSync(att.path)) return [{ type: 'text', text: `[Attachment "${att.name}" is no longer available at ${att.path}]` }];
    if (att.kind === 'image') {
      if (att.size > MAX_IMAGE_BYTES) return [{ type: 'text', text: `[Image "${att.name}" is ${human(att.size)} - over the ${human(MAX_IMAGE_BYTES)} limit, not sent]` }];
      return [{ type: 'image', mime: att.mime, data: fs.readFileSync(att.path).toString('base64'), name: att.name }];
    }
    if (att.kind === 'pdf') {
      if (att.size > MAX_PDF_BYTES) return [{ type: 'text', text: `[PDF "${att.name}" is ${human(att.size)} - too large to send]` }];
      return [{ type: 'pdf', mime: 'application/pdf', data: fs.readFileSync(att.path).toString('base64'), name: att.name }];
    }
    if (att.kind === 'text') {
      return [{ type: 'text', text: `File "${att.name}" (${human(att.size)}):\n\`\`\`\n${readText(att)}\n\`\`\`` }];
    }
    return [{ type: 'text', text: `[Attached file "${att.name}" (${human(att.size)}, ${att.mime}) - binary content not readable; path: ${att.path}]` }];
  } catch (err) {
    return [{ type: 'text', text: `[Could not read attachment "${att.name}": ${err.message}]` }];
  }
}

// Anthropic content blocks for a user message with attachments.
function toAnthropicContent(text, attachments) {
  const blocks = [];
  for (const att of attachments || []) {
    for (const part of render(att)) {
      if (part.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mime, data: part.data } });
      else if (part.type === 'pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.data }, title: part.name });
      else blocks.push({ type: 'text', text: part.text });
    }
  }
  blocks.push({ type: 'text', text: String(text || '') || '(see attachments)' });
  return blocks;
}

// OpenAI chat/completions content parts (vision models take image_url
// data URLs; PDFs have no wire format here, so they become a note).
function toOpenAiContent(text, attachments) {
  const parts = [];
  for (const att of attachments || []) {
    for (const part of render(att)) {
      if (part.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.data}` } });
      else if (part.type === 'pdf') parts.push({ type: 'text', text: `[PDF "${part.name}" attached - this provider cannot read PDFs directly; ask the user for a text export if the content is needed]` });
      else parts.push({ type: 'text', text: part.text });
    }
  }
  parts.push({ type: 'text', text: String(text || '') || '(see attachments)' });
  return parts;
}

module.exports = { describe, render, toAnthropicContent, toOpenAiContent, human, IMAGE_TYPES, TEXT_EXTS, MAX_IMAGE_BYTES };
