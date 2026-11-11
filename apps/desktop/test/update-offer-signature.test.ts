// Regression: an update manifest signed with another key is rejected, not offered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { layerSigningPayload } from '@pom/protocol';
import { UpdateManager } from '../src/main/updater/updateManager.js';

const layer = (name: 'app' | 'engine' | 'interface', priv: ReturnType<typeof generateKeyPairSync>['privateKey']) => {
  const l = { version: '9.9.9', sha256: 'a'.repeat(64), size: 3, url: `http://x/${name}`, signature: '' };
  l.signature = sign(null, Buffer.from(layerSigningPayload(name, l), 'utf8'), priv).toString('base64');
  return l;
};
const manager = (signer: ReturnType<typeof generateKeyPairSync>, trusted: ReturnType<typeof generateKeyPairSync>, installed = '1') =>
  new UpdateManager({
    manifestBaseUrl: 'http://x/m',
    channel: 'stable',
    publicKey: trusted.publicKey,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ channel: 'stable', generatedAt: 'now', layers: { app: layer('app', signer.privateKey), engine: layer('engine', signer.privateKey), interface: layer('interface', signer.privateKey) } }) }),
    engineSwap: { getCurrentVersion: () => installed, getStagedVersion: () => null },
    interfaceSwap: { getCurrentVersion: () => installed },
    appShellUpdater: { getCurrentVersion: () => installed },
    getOpenBuildState: () => ({}) as never,
    emit: () => {},
  } as never);

test('a manifest signed with the trusted key is offered', async () => {
  const k = generateKeyPairSync('ed25519');
  assert.equal((await manager(k, k).checkAvailable()).layers.length, 3);
});

test('a manifest signed with another key is rejected and nothing is offered', async () => {
  await assert.rejects(manager(generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')).checkAvailable(), /not signed with the trusted key/);
});

test('a manifest with nothing newer is "no update", even when its signature is not trusted', async () => {
  const m = manager(generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519'), '9.9.9');
  assert.equal((await m.checkAvailable()).layers.length, 0);
});
