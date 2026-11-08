const test = require('node:test');
const assert = require('node:assert');
const { webSearchUrl, ENGINES } = require('../src/main/spotlight');

test('webSearchUrl builds a url for each known engine', () => {
  for (const key of Object.keys(ENGINES)) {
    const url = webSearchUrl(key, 'hello world');
    assert.ok(url.startsWith('https://'), `${key} should be https`);
    assert.ok(url.includes('hello%20world'), `${key} should carry the encoded query`);
    assert.ok(!url.includes('{q}'), `${key} should have no placeholder left`);
  }
});

test('webSearchUrl escapes characters that would break the url', () => {
  const url = webSearchUrl('bing', 'a&b=c d?e');
  assert.ok(url.includes('a%26b%3Dc%20d%3Fe'));
});

test('webSearchUrl accepts a custom template and falls back otherwise', () => {
  assert.strictEqual(webSearchUrl('https://example.com/s?term={q}', 'cats'),
    'https://example.com/s?term=cats');
  // Unknown engine names fall back to the default rather than breaking search.
  assert.strictEqual(webSearchUrl('nonsense', 'cats'), ENGINES.bing.replace('{q}', 'cats'));
  assert.strictEqual(webSearchUrl(undefined, 'cats'), ENGINES.bing.replace('{q}', 'cats'));
});
