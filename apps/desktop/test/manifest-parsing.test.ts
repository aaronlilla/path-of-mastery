import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, ManifestParseError, fetchManifest, manifestUrlFor } from '../src/main/updater/manifestClient.js';

function validLayer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    size: 1024,
    url: 'https://cdn.example/engine-1.0.0.pack',
    signature: 'c2lnbmF0dXJl',
    ...overrides,
  };
}

function validManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    channel: 'stable',
    generatedAt: '2026-09-28T00:00:00Z',
    layers: {
      engine: validLayer(),
      interface: validLayer({ version: '2.0.0' }),
      app: validLayer({ version: '3.0.0' }),
    },
    ...overrides,
  };
}

test('parseManifest accepts a well-formed manifest', () => {
  const manifest = parseManifest(validManifest());
  assert.equal(manifest.channel, 'stable');
  assert.equal(manifest.layers.engine.version, '1.0.0');
  assert.equal(manifest.layers.interface.version, '2.0.0');
  assert.equal(manifest.layers.app.version, '3.0.0');
});

test('parseManifest lowercases sha256 for consistent comparison', () => {
  const manifest = parseManifest(validManifest({ layers: { ...validManifest().layers, engine: validLayer({ sha256: 'A'.repeat(64) }) } }));
  assert.equal(manifest.layers.engine.sha256, 'a'.repeat(64));
});

test('parseManifest rejects a non-object payload', () => {
  assert.throws(() => parseManifest('not json'), ManifestParseError);
  assert.throws(() => parseManifest(null), ManifestParseError);
});

test('parseManifest rejects an unknown channel', () => {
  assert.throws(() => parseManifest(validManifest({ channel: 'nightly' })), ManifestParseError);
});

test('parseManifest rejects a manifest missing a layer', () => {
  const manifest = validManifest();
  const layers = { ...manifest.layers } as Record<string, unknown>;
  delete layers.app;
  assert.throws(() => parseManifest({ ...manifest, layers }), ManifestParseError);
});

test('parseManifest rejects a layer with a malformed sha256', () => {
  const manifest = validManifest({ layers: { ...validManifest().layers, engine: validLayer({ sha256: 'not-hex' }) } });
  assert.throws(() => parseManifest(manifest), ManifestParseError);
});

test('parseManifest rejects a layer with a negative size', () => {
  const manifest = validManifest({ layers: { ...validManifest().layers, engine: validLayer({ size: -1 }) } });
  assert.throws(() => parseManifest(manifest), ManifestParseError);
});

test('parseManifest rejects a layer missing its signature', () => {
  const layer = validLayer() as Record<string, unknown>;
  delete layer.signature;
  const manifest = validManifest({ layers: { ...validManifest().layers, engine: layer } });
  assert.throws(() => parseManifest(manifest), ManifestParseError);
});

test('fetchManifest fetches, parses, and surfaces HTTP failures', async () => {
  const manifest = await fetchManifest('https://updates.example/manifest.json', async () => ({
    ok: true,
    status: 200,
    json: async () => validManifest(),
  }));
  assert.equal(manifest.channel, 'stable');

  await assert.rejects(
    fetchManifest('https://updates.example/manifest.json', async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })),
  );
});

test('manifestUrlFor appends the channel as a query param', () => {
  assert.equal(manifestUrlFor('https://updates.example/manifest.json', 'beta'), 'https://updates.example/manifest.json?channel=beta');
  assert.equal(manifestUrlFor('https://updates.example/manifest.json?x=1', 'stable'), 'https://updates.example/manifest.json?x=1&channel=stable');
});
