// Staged engine re-verification at the next start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStagedEngine, writeStagedEngine } from '../src/main/updater/stagedEngine.js';
import { generateTestKeypair, signLayer } from './testHelpers.js';

test('a staged engine is verified again at the next start: a swapped pack is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'staged-'));
  try {
    const { publicKey, privateKey } = generateTestKeypair();
    const pack = join(dir, 'engine-v2.pack'), bytes = Buffer.from('native engine bytes');
    await writeFile(pack, bytes);
    const layer = signLayer('engine', { version: 'v2', url: 'https://x.test/e.pack', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } as never, privateKey);
    await writeStagedEngine(dir, { version: 'v2', packPath: pack, layer });
    assert.equal((await readStagedEngine(dir, publicKey))?.version, 'v2');
    await writeFile(pack, Buffer.from('something else'));
    assert.equal(await readStagedEngine(dir, publicKey), null, 'hash no longer matches the signed entry');
    await writeFile(pack, bytes);
    await writeStagedEngine(dir, { version: 'v2', packPath: pack });
    assert.equal(await readStagedEngine(dir, publicKey), null, 'a marker without its signed entry is not trusted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
