const test = require('node:test');
const assert = require('node:assert');
const { familyOf, logoFromManifest, pickIconAsset } = require('../src/main/uwp');
const { dedupeApps } = require('../src/main/indexer');

test('familyOf reduces a package id to its family name', () => {
  assert.strictEqual(
    familyOf('Microsoft.WindowsCalculator_11.2607.0.0_x64__8wekyb3d8bbwe'),
    'Microsoft.WindowsCalculator_8wekyb3d8bbwe');
  assert.strictEqual(
    familyOf('chatgpt.com-DFCB3CE4_1.0.0.0_neutral__ch69rtgtz055j'),
    'chatgpt.com-DFCB3CE4_ch69rtgtz055j');
  // Already a family name, or junk: returned unchanged rather than throwing.
  assert.strictEqual(familyOf('NoUnderscores'), 'NoUnderscores');
});

test('logoFromManifest picks the logo of the matching Application', () => {
  const xml = `<Package><Applications>
      <Application Id="Other" Executable="o.exe">
        <uap:VisualElements Square44x44Logo="Assets\\OtherLogo.png" />
      </Application>
      <Application Id="App" Executable="a.exe">
        <uap:VisualElements Square44x44Logo="Assets\\RightLogo.png" />
      </Application>
    </Applications></Package>`;
  assert.strictEqual(logoFromManifest(xml, 'App'), 'Assets\\RightLogo.png');
  assert.strictEqual(logoFromManifest(xml, 'Other'), 'Assets\\OtherLogo.png');
  // Unknown id falls back to the first logo rather than returning nothing.
  assert.strictEqual(logoFromManifest(xml, 'Missing'), 'Assets\\OtherLogo.png');
});

test('logoFromManifest tolerates ids containing regex characters', () => {
  const xml = `<Package><Applications>
      <Application Id="My.App+v2" Executable="a.exe">
        <uap:VisualElements Square44x44Logo="Assets\\L.png" />
      </Application>
    </Applications></Package>`;
  assert.strictEqual(logoFromManifest(xml, 'My.App+v2'), 'Assets\\L.png');
  assert.strictEqual(logoFromManifest('<Package/>', 'App'), null);
});

test('pickIconAsset prefers the crisp unplated 48px variant', () => {
  const files = [
    'CalcLogo.scale-100.png',
    'CalcLogo.scale-200.png',
    'CalcLogo.targetsize-16.png',
    'CalcLogo.targetsize-48.png',
    'CalcLogo.targetsize-48_altform-unplated.png',
    'CalcLogo.targetsize-48_contrast-black.png',
    'OtherLogo.targetsize-48.png'
  ];
  assert.strictEqual(pickIconAsset(files, 'CalcLogo'), 'CalcLogo.targetsize-48_altform-unplated.png');
  // High-contrast accessibility variants are never chosen.
  assert.ok(!pickIconAsset(files, 'CalcLogo').includes('contrast'));
});

test('pickIconAsset falls back through the size ladder', () => {
  assert.strictEqual(pickIconAsset(['L.scale-200.png', 'L.scale-100.png'], 'L'), 'L.scale-200.png');
  assert.strictEqual(pickIconAsset(['L.png'], 'L'), 'L.png');
  assert.strictEqual(pickIconAsset(['Unrelated.png'], 'L'), null);
  assert.strictEqual(pickIconAsset([], 'L'), null);
});

test('dedupeApps drops AppsFolder entries already covered by a shortcut', () => {
  const shortcuts = [{ name: 'Spotify', path: 'C:\\x\\Spotify.lnk', kind: 'app' }];
  const uwp = [
    { name: 'Spotify', path: 'shell:AppsFolder\\Spotify_abc!App', kind: 'app' },
    { name: 'Calculator', path: 'shell:AppsFolder\\Calc_abc!App', kind: 'app' },
    { name: 'calculator', path: 'shell:AppsFolder\\Dupe_abc!App', kind: 'app' }
  ];
  const kept = dedupeApps(shortcuts, uwp);
  assert.deepStrictEqual(kept.map((a) => a.name), ['Calculator']);
});
