import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedText, plainNotes } from '../src/shared/lootfilter/notes.js';

test('release notes lose badges, links and Markdown marks', () => {
  const md = [
    '[![Follow me on Twitter](https://img.shields.io/badge/Twitter-follow-blue)](https://twitter.com/x) [![Patreon](https://img.shields.io/badge/p.svg)](https://patreon.com/y)',
    '',
    '## Changes in 8.21.0',
    '',
    '- **Currency**: moved [Orb of Annulment](https://example.test/a) to tier 4',
    '- Fixed `Hide` blocks for <b>flasks</b>',
    '',
    '---',
    '![screenshot](https://example.test/s.png)',
    'See https://example.test/more for details',
  ].join('\n');
  const t = plainNotes(md);
  assert.equal(t, ['Changes in 8.21.0', '', '\u2022 Currency: moved Orb of Annulment to tier 4', '\u2022 Fixed Hide blocks for flasks', '', 'See for details'].join('\n'));
  assert.ok(!/[\[\]`*#]|https?:|!\[/.test(t), t);
  assert.ok(t.startsWith('Changes in 8.21.0'));
  assert.ok(t.includes('• Currency: moved Orb of Annulment to tier 4'));
  assert.ok(t.includes('Fixed Hide blocks for flasks'));
});

test('checked time reads as a sentence', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(checkedText(now - 5_000, now), 'Checked just now.');
  assert.equal(checkedText(now - 5 * 60_000, now), 'Checked 5 min ago.');
  assert.equal(checkedText(now - 3 * 3600_000, now), 'Checked 3 h ago.');
  assert.equal(checkedText(now - 4 * 86400_000, now), 'Checked 4 days ago.');
});
