import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readStampedVersions, shownVersion } from '../src/main/layerVersions.js';

const dir = mkdtempSync(join(tmpdir(), 'layer-versions-'));

test('reads the stamped engine and interface numbers', () => {
  const f = join(dir, 'ok.json');
  writeFileSync(f, JSON.stringify({ engine: '1.4.2', interface: '0.9.0' }));
  assert.deepEqual(readStampedVersions(f), { engine: '1.4.2', interface: '0.9.0', official: false });
});

test('only an explicit official stamp marks a release build', () => {
  const f = join(dir, 'official.json');
  writeFileSync(f, JSON.stringify({ engine: '1.4.2', interface: '0.9.0', official: true }));
  assert.equal(readStampedVersions(f).official, true);
  writeFileSync(f, JSON.stringify({ engine: '1.4.2', interface: '0.9.0', official: 'yes' }));
  assert.equal(readStampedVersions(f).official, false);
});

test('a missing, broken or non-numeric stamp is "unknown", never "dev" or the app version', () => {
  assert.deepEqual(readStampedVersions(join(dir, 'nope.json')), { engine: 'unknown', interface: 'unknown', official: false });
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.deepEqual(readStampedVersions(bad), { engine: 'unknown', interface: 'unknown', official: false });
  const dev = join(dir, 'dev.json');
  writeFileSync(dev, JSON.stringify({ engine: 'dev', interface: 7 }));
  assert.deepEqual(readStampedVersions(dev), { engine: 'unknown', interface: 'unknown', official: false });
});

test('an installed update wins; an unpackaged build ("dev") shows the stamped number', () => {
  assert.equal(shownVersion('2.0.1', '1.4.2'), '2.0.1');
  assert.equal(shownVersion('dev', '1.4.2'), '1.4.2');
  assert.equal(shownVersion('dev', 'unknown'), 'unknown');
});
