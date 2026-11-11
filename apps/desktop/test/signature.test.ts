import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyLayerSignature, verifyDownloadedLayer, sha256File } from '../src/main/updater/signature.js';
import { generateTestKeypair, signLayer } from './testHelpers.js';

test('verifyLayerSignature accepts a correctly-signed layer', () => {
  const { publicKey, privateKey } = generateTestKeypair();
  const layer = signLayer('engine', { version: '1.0.0', sha256: 'a'.repeat(64), size: 10, url: 'https://x/y' }, privateKey);
  assert.equal(verifyLayerSignature('engine', layer, publicKey), true);
});

test('verifyLayerSignature rejects a signature from the wrong key', () => {
  const { privateKey } = generateTestKeypair();
  const { publicKey: wrongPublicKey } = generateTestKeypair();
  const layer = signLayer('engine', { version: '1.0.0', sha256: 'a'.repeat(64), size: 10, url: 'https://x/y' }, privateKey);
  assert.equal(verifyLayerSignature('engine', layer, wrongPublicKey), false);
});

test('verifyLayerSignature rejects a layer whose fields were tampered with after signing', () => {
  const { publicKey, privateKey } = generateTestKeypair();
  const layer = signLayer('engine', { version: '1.0.0', sha256: 'a'.repeat(64), size: 10, url: 'https://x/y' }, privateKey);
  const tampered = { ...layer, size: 999999 };
  assert.equal(verifyLayerSignature('engine', tampered, publicKey), false);
});

test('verifyLayerSignature rejects a signature replayed onto a different layer name', () => {
  const { publicKey, privateKey } = generateTestKeypair();
  const fields = { version: '1.0.0', sha256: 'a'.repeat(64), size: 10, url: 'https://x/y' };
  const engineLayer = signLayer('engine', fields, privateKey);
  // Same signature bytes, but claimed for a different layer - must not verify.
  assert.equal(verifyLayerSignature('interface', { ...fields, signature: engineLayer.signature }, publicKey), false);
});

test('sha256File matches a manually computed digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-sig-'));
  try {
    const filePath = join(dir, 'payload.bin');
    const content = Buffer.from('the quick brown fox');
    await writeFile(filePath, content);
    const expected = createHash('sha256').update(content).digest('hex');
    assert.equal(await sha256File(filePath), expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyDownloadedLayer accepts a genuine, untampered pack', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-sig-'));
  try {
    const { publicKey, privateKey } = generateTestKeypair();
    const filePath = join(dir, 'engine.pack');
    const content = Buffer.from('genuine engine pack contents');
    await writeFile(filePath, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const layer = signLayer('engine', { version: '1.0.0', sha256, size: content.length, url: 'file://' + filePath }, privateKey);

    const result = await verifyDownloadedLayer('engine', layer, filePath, publicKey);
    assert.equal(result.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyDownloadedLayer rejects a pack whose bytes were swapped after signing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-sig-'));
  try {
    const { publicKey, privateKey } = generateTestKeypair();
    const filePath = join(dir, 'engine.pack');
    const originalContent = Buffer.from('genuine engine pack contents');
    const sha256 = createHash('sha256').update(originalContent).digest('hex');
    const layer = signLayer('engine', { version: '1.0.0', sha256, size: originalContent.length, url: 'file://' + filePath }, privateKey);

    // Attacker swaps the file after the manifest was signed - the signature
    // still verifies (it's over the manifest, not the file), but the hash
    // of what's actually on disk no longer matches.
    await writeFile(filePath, Buffer.from('tampered malicious contents'));

    const result = await verifyDownloadedLayer('engine', layer, filePath, publicKey);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /sha256 mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyDownloadedLayer rejects a pack whose manifest entry was tampered with', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-sig-'));
  try {
    const { publicKey, privateKey } = generateTestKeypair();
    const filePath = join(dir, 'engine.pack');
    const content = Buffer.from('genuine engine pack contents');
    await writeFile(filePath, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const layer = signLayer('engine', { version: '1.0.0', sha256, size: content.length, url: 'file://' + filePath }, privateKey);

    // Attacker points the (signed) manifest entry's url at a different,
    // unsigned version string without re-signing.
    const tamperedLayer = { ...layer, version: '99.0.0' };

    const result = await verifyDownloadedLayer('engine', tamperedLayer, filePath, publicKey);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /signature verification failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
