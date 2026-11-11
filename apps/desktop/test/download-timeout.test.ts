// The central KB and next-league preview downloads are cut off by a timeout instead of hanging on a stalled network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadCentralSnapshot, fetchCentralManifest, type CentralKbManifest } from '../src/main/kb/central.js';
import { downloadPreview, fetchPreviewManifest, type PreviewManifest } from '../src/main/preview/overlay.js';

// answers never; rejects when the caller's signal aborts
const hang = (_u: string, init?: { signal?: AbortSignal }) =>
  new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)));

test('central KB manifest and snapshot downloads time out', async () => {
  await assert.rejects(fetchCentralManifest({ fetch: hang, timeoutMs: 50 }));
  const dir = mkdtempSync(join(tmpdir(), 'kbto-'));
  await assert.rejects(downloadCentralSnapshot({ url: 'https://example.test/kb.br', sha256: 'a'.repeat(64) } as CentralKbManifest, join(dir, 'kb.sqlite'), { fetch: hang, timeoutMs: 50 }));
});

test('preview manifest and pack downloads time out', async () => {
  await assert.rejects(fetchPreviewManifest({ fetch: hang, timeoutMs: 50 }));
  const dir = mkdtempSync(join(tmpdir(), 'pvto-'));
  await assert.rejects(downloadPreview({ url: 'https://example.test/p.br' } as PreviewManifest, dir, join(dir, 'out'), { fetch: hang, timeoutMs: 50 }));
});
