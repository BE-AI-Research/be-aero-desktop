const test = require('node:test');
const assert = require('node:assert');
const { toSpeech } = require('../src/shared/speech');

test('abbreviations become words', () => {
  assert.strictEqual(toSpeech('Use a small model, e.g. tiny.'), 'Use a small model, for example, tiny.');
  assert.strictEqual(toSpeech('Fast, i.e. under a second.'), 'Fast, that is, under a second.');
  assert.match(toSpeech('Apples vs. oranges, etc.'), /^Apples versus oranges, et cetera\.$/);
  assert.match(toSpeech('Do it w/ care, not w/o a backup.'), /with care, not without a backup/);
  assert.match(toSpeech('See No. 5 on p. 12.'), /number 5 on page 12/);
});

test('symbols, currency, percentages, temperatures and ranges are spoken', () => {
  assert.strictEqual(toSpeech('Save 50% & pay $1,299.'), 'Save 50 percent and pay 1299 dollars.');
  assert.strictEqual(toSpeech('22°C -> 25°C'), '22 degrees Celsius to 25 degrees Celsius.');
  assert.strictEqual(toSpeech('It takes 1-2 weeks.'), 'It takes 1 to 2 weeks.');
  assert.match(toSpeech('About ~5 items, #3 is best, 3x faster at 1920x1080.'), /about 5 items, number 3 is best, 3 times faster at 1920 by 1080/);
  assert.match(toSpeech('A budget of €2.5m'), /2\.5 million euros/);
  assert.match(toSpeech('input/output'), /input or output/);
});

test('units after numbers are expanded; acronyms are spelled', () => {
  assert.strictEqual(toSpeech('16 GB at 3.5GHz in 200ms'), '16 gigabytes at 3.5 gigahertz in 200 milliseconds.');
  assert.match(toSpeech('The API and CPU use HTTPS; NASA and JSON stay words.'), /The A P I and C P U use H T T P S; NASA and JSON stay words/);
  assert.strictEqual(toSpeech('Runs at 60fps for 5 mins.'), 'Runs at 60 frames per second for 5 minutes.');
  assert.match(toSpeech('I live in Seattle.'), /I live in Seattle/, '"in" is not read as inches');
});

test('markdown structure reads as sentences; code, links and emoji are handled', () => {
  const md = '## Steps\n\n1. Run `npm install`\n2. Open `app.js`, edit `set_settings`\n- **Note:** be *careful* 🎉\n\n| Name | Size |\n|---|---|\n| foo.png | 2 MB |\n\n```js\nconst x = 1;\n```\nMore at https://www.example.com/docs.';
  assert.strictEqual(toSpeech(md), 'Steps. Run npm install. Open app dot J S, edit set settings. Note: be careful. Name, Size. foo dot P N G, 2 megabytes. There is a code example here. More at a link to example dot com.');
  assert.strictEqual(toSpeech('Mail john.doe@example.com now'), 'Mail john doe at example dot com now.');
});

test('rates after a slash read as "per"', () => {
  assert.strictEqual(toSpeech('Only $5/mo or $50/yr.'), 'Only 5 dollars per month or 50 dollars per year.');
  assert.match(toSpeech('Driving at 60 km/h, downloading 10 MB/s.'), /60 kilometers per hour, downloading 10 megabytes per second/);
  assert.match(toSpeech('on/off'), /on or off/);
});
