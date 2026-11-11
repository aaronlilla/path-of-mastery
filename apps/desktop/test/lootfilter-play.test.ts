import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAreas, readClientLog } from '../src/main/lootfilter/clientLog.js';
import { suggestFromPlay, summarize } from '../src/shared/lootfilter/play.js';
import type { HiddenCounts } from '../src/shared/lootfilter/ipcTypes.js';

const LOG = [
  '2026/09/30 21:00:01 1000 aa [INFO Client 1] Generating level 1 area "1_1_town" with seed 5',
  '2026/09/30 21:00:02 1000 aa [INFO Client 1] : You have entered Lioneye\'s Watch.',
  '2026/09/30 21:10:00 2000 bb [INFO Client 1] Generating level 83 area "MapWorldsStrand" with seed 11',
  '2026/09/30 21:10:01 2000 bb [INFO Client 1] : You have entered Strand.',
  '2026/09/30 21:11:00 3000 cc [INFO Client 1] @From Someone: hello, I would like to buy',
  '2026/09/30 21:20:00 2000 bb [INFO Client 1] Generating level 70 area "HideoutShaped" with seed 12',
  '2026/09/30 21:20:01 2000 bb [INFO Client 1] : You have entered Shaped Hideout.',
  '2026/09/30 21:30:00 2000 bb [INFO Client 1] Generating level 82 area "MapWorldsCemetery" with seed 13',
  '2026/09/30 21:30:01 2000 bb [INFO Client 1] : You have entered Cemetery.',
  'not a log line',
].join('\r\n');

test('Client.txt areas: level from the Generating line, name from the entered line, nothing about drops', () => {
  const a = parseAreas(LOG);
  assert.deepEqual(a.map((x) => [x.id, x.name, x.level]), [
    ['1_1_town', "Lioneye's Watch", 1],
    ['MapWorldsStrand', 'Strand', 83],
    ['HideoutShaped', 'Shaped Hideout', 70],
    ['MapWorldsCemetery', 'Cemetery', 82],
  ]);
  assert.equal(new Date(a[1]!.at).getHours(), 21);
  const s = summarize(a);
  assert.equal(s.count, 2, 'towns and hideouts are not counted');
  assert.equal(s.maxLevel, 83);
  assert.equal(s.last?.name, 'Cemetery');
});

test('the reader finds a configured file, reports a missing one, and only reads the tail of a big log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-log-'));
  try {
    const f = join(dir, 'Client.txt');
    writeFileSync(f, 'x'.repeat(5000) + '\n' + LOG);
    const r = await readClientLog(f, { maxBytes: 1200 });
    assert.equal(r.found, true);
    assert.ok(r.areas.some((a) => a.name === 'Cemetery'));
    const none = await readClientLog(join(dir, 'nope.txt'));
    assert.equal(none.found, false);
    assert.match(none.note ?? '', /no file/i);
    const auto = await readClientLog('', { candidates: [join(dir, 'a.txt'), f] });
    assert.equal(auto.path, f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strictness hints need enough areas and quote the real counts', () => {
  const hidden: HiddenCounts = { version: 'x', total: 2157, hidden: [1, 331, 335, 339, 675, 923, 1272], mask: {} };
  const areas = Array.from({ length: 12 }, (_, i) => ({ at: i, id: 'Map' + i, name: 'M' + i, level: 80 + (i % 4) }));
  const mapping = suggestFromPlay(summarize(areas), 0, hidden);
  assert.equal(mapping.length, 1);
  assert.equal(mapping[0]!.toStrictness, 2);
  assert.match(mapping[0]!.text, /Soft hides 1 of 2157 item types; Semi-Strict hides 335/);
  assert.deepEqual(suggestFromPlay(summarize(areas), 2, hidden), [], 'already on a fitting level');
  assert.deepEqual(suggestFromPlay(summarize(areas.slice(0, 5)), 0, hidden), [], 'too few areas to say');
  const leveling = Array.from({ length: 10 }, (_, i) => ({ at: i, id: 'A' + i, name: 'A' + i, level: 20 + i }));
  assert.equal(suggestFromPlay(summarize(leveling), 4, hidden)[0]?.toStrictness, 1);
});
