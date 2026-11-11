import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchZoneEntries, zoneEntered } from '../src/main/lootfilter/clientLog.js';

test('zoneEntered reads the area name from a Client.txt line', () => {
  assert.equal(zoneEntered('2026/10/10 12:01:00 99 abc [INFO Client 1] : You have entered The Coast.'), 'The Coast');
  assert.equal(zoneEntered('2026/10/10 12:01:00 99 abc [INFO Client 1] : Generating level 1 area "1_1_2"'), null);
});

test('watchZoneEntries reports only zones written after it started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lvl-log-'));
  const file = join(dir, 'Client.txt');
  writeFileSync(file, '2026/10/10 12:00:00 1 a [INFO Client 1] : You have entered Old Zone.\n');
  const seen: string[] = [];
  const w = watchZoneEntries(file, (n) => seen.push(n), 50);
  try {
    await new Promise((r) => setTimeout(r, 200));
    appendFileSync(file, '2026/10/10 12:01:00 2 a [INFO Client 1] : You have entered The Coast.\n2026/10/10 12:01:05 3 a [INFO Client 1] : You have entered The Mud Flats.\n');
    const t0 = Date.now();
    while (seen.length < 2 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, ['The Coast', 'The Mud Flats']);
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
