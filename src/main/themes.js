// Glass colour themes. Each preset sets the CSS variables used by the widget
// and Spotlight stylesheets; users can override any field with theme.custom.
const PRESETS = {
  aero:     { name: 'Aero (default)', tint: '#121828', tintAlpha: 0.55, accent: '#38bdf8', border: 0.2,  glow: 0.15, text: '#fafafa', radius: 16 },
  midnight: { name: 'Midnight',       tint: '#05070d', tintAlpha: 0.72, accent: '#818cf8', border: 0.14, glow: 0.08, text: '#e5e7eb', radius: 16 },
  frost:    { name: 'Frosted glass',  tint: '#dbe4f0', tintAlpha: 0.28, accent: '#0ea5e9', border: 0.45, glow: 0.35, text: '#ffffff', radius: 18 },
  emerald:  { name: 'Emerald',        tint: '#062a22', tintAlpha: 0.6,  accent: '#34d399', border: 0.2,  glow: 0.12, text: '#ecfdf5', radius: 16 },
  sunset:   { name: 'Sunset',         tint: '#3b1220', tintAlpha: 0.55, accent: '#fb923c', border: 0.22, glow: 0.18, text: '#fff7ed', radius: 16 },
  rose:     { name: 'Rose quartz',    tint: '#3a1530', tintAlpha: 0.5,  accent: '#f472b6', border: 0.25, glow: 0.2,  text: '#fdf2f8', radius: 20 },
  amber:    { name: 'Amber terminal', tint: '#120c02', tintAlpha: 0.78, accent: '#f59e0b', border: 0.18, glow: 0.06, text: '#fde68a', radius: 6 },
  mono:     { name: 'Graphite',       tint: '#1c1c1e', tintAlpha: 0.65, accent: '#d4d4d8', border: 0.16, glow: 0.1,  text: '#f4f4f5', radius: 12 },
  clear:    { name: 'Clear',          tint: '#000000', tintAlpha: 0.18, accent: '#38bdf8', border: 0.3,  glow: 0.2,  text: '#ffffff', radius: 16 }
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [18, 24, 40];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Resolve preset + custom overrides into a flat theme object.
function resolveTheme(theme) {
  const t = theme || {};
  const base = PRESETS[t.preset] || PRESETS.aero;
  const out = { ...base };
  for (const [k, v] of Object.entries(t.custom || {})) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

// CSS custom properties for a resolved theme.
function themeVars(theme) {
  const t = resolveTheme(theme);
  const [r, g, b] = hexToRgb(t.tint);
  const [ar, ag, ab] = hexToRgb(t.accent);
  const [tr, tg, tb] = hexToRgb(t.text);
  return {
    '--glass-rgb': `${r}, ${g}, ${b}`,
    '--glass-alpha': String(t.tintAlpha),
    '--glass-border': String(t.border),
    '--glass-glow': String(t.glow),
    '--accent': t.accent,
    '--accent-rgb': `${ar}, ${ag}, ${ab}`,
    '--text': t.text,
    '--text-rgb': `${tr}, ${tg}, ${tb}`,
    '--radius': `${t.radius}px`
  };
}

module.exports = { PRESETS, resolveTheme, themeVars, hexToRgb };
