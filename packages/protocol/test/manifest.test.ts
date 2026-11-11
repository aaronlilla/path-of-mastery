import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerSigningPayload, isUpdateChannel } from '../src/manifest.js';
import * as manifestMod from '../src/manifest.js';

test('layerSigningPayload is stable and includes every signed field', () => {
  const payload = layerSigningPayload('engine', {
    version: '1.2.3',
    sha256: 'abc123',
    size: 42,
    url: 'https://example.com/engine.pack',
  });
  assert.equal(payload, 'pom-update:engine:1.2.3:abc123:42:https://example.com/engine.pack');
});

test('layerSigningPayload differs per layer name so signatures cannot be replayed across layers', () => {
  const layer = { version: '1.0.0', sha256: 'deadbeef', size: 1, url: 'https://x/y' };
  const engine = layerSigningPayload('engine', layer);
  const iface = layerSigningPayload('interface', layer);
  const app = layerSigningPayload('app', layer);
  assert.notEqual(engine, iface);
  assert.notEqual(engine, app);
  assert.notEqual(iface, app);
});

test('isUpdateChannel accepts only stable/beta', () => {
  assert.equal(isUpdateChannel('stable'), true);
  assert.equal(isUpdateChannel('beta'), true);
  assert.equal(isUpdateChannel('nightly'), false);
  assert.equal(isUpdateChannel(undefined), false);
});

test('layerSigningPayload: delivery fields switch to the v2 form, which names every one before the url', () => {
  const { layerSigningPayload } = manifestMod;
  const base = { version: '1.2.0', sha256: 'ab', size: 7, url: 'https://x/y.exe' };
  assert.equal(layerSigningPayload('app', base), 'pom-update:app:1.2.0:ab:7:https://x/y.exe', 'no delivery fields: unchanged v1 form');
  assert.equal(
    layerSigningPayload('app', { ...base, rolloutPercent: 25 }),
    'pom-update2:app:1.2.0:ab:7:min=:critical=0:rollout=25:downgrade=0:forApp=:https://x/y.exe',
  );
  assert.equal(
    layerSigningPayload('interface', { ...base, minimumVersion: '1.1.0', critical: true, allowDowngrade: true, forApp: '1.2.0' }),
    'pom-update2:interface:1.2.0:ab:7:min=1.1.0:critical=1:rollout=100:downgrade=1:forApp=1.2.0:https://x/y.exe',
  );
  // Stripping the fields gives the v1 form, a different string: the old signature cannot match it.
  assert.notEqual(layerSigningPayload('app', base), layerSigningPayload('app', { ...base, minimumVersion: '1.0.0' }));
});
