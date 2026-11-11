import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineRequest } from '@pom/protocol';
import { EngineHostRuntime, type HostIo } from '../src/engine-host/main.js';

const FAKE_ENGINE = `
let opened = 0;
module.exports = {
  version: 'fake',
  closed: [],
  recalculate() { return '{}'; },
  loadBuild() { return JSON.stringify({ buildId: 'b' + (++opened), stats: { Life: 1 } }); },
  closeBuild(id) { module.exports.closed.push(id); },
};
`;

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'pom-evict-'));
  const modPath = join(dir, 'fake_engine.cjs');
  await writeFile(modPath, FAKE_ENGINE);
  const sent: Array<Record<string, unknown>> = [];
  let handler: (m: unknown) => void = () => {};
  const io: HostIo = { send: (m) => sent.push(m as Record<string, unknown>), onMessage: (h) => (handler = h) };
  new EngineHostRuntime(io, { nativeModulePath: modPath });
  const { createRequire } = await import('node:module');
  const fake = createRequire(import.meta.url)(modPath) as { closed: string[] };
  let n = 0;
  const request = (command: string, params: Record<string, unknown>) => {
    const id = `r${++n}`;
    handler({ kind: 'engine-request', request: { id, command, params } as unknown as EngineRequest });
    const res = sent.find((m) => m.kind === 'engine-response' && (m.response as { id: string }).id === id);
    return (res as { response: { ok: boolean; result: { buildId: string }; error?: { code: string; message: string } } }).response;
  };
  const load = (keep?: 'open' | 'shown') => request('loadBuild', { buildXml: '<Build/>', ...(keep ? { keep } : {}) });
  return { fake, request, load, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("the player's open build is never evicted; drafts and scratch copies go first, oldest first", async () => {
  const h = await harness();
  try {
    assert.equal(h.load('open').result.buildId, 'b1'); // the player's build, opened first (the oldest)
    for (let i = 0; i < 5; i++) h.load(); // b2..b6: drafts and scratch copies, the cap is full
    h.load(); // b7 pushes one out: the oldest draft, not the player's build
    assert.deepEqual(h.fake.closed, ['b2']);
    h.request('getStats', { buildId: 'b3' }); // a used draft moves to the back of the line
    h.load(); // b8
    assert.deepEqual(h.fake.closed, ['b2', 'b4']);
    assert.equal(h.request('getStats', { buildId: 'b1' }).ok, true);
  } finally {
    await h.cleanup();
  }
});

test('a build a window shows is kept too; a newer open build frees the previous one', async () => {
  const h = await harness();
  try {
    h.load('open'); // b1
    h.load('shown'); // b2: a Compare entry
    h.load('open'); // b3: the player opened another build, b1 may go now
    for (let i = 0; i < 4; i++) h.load(); // b4..b7
    assert.deepEqual(h.fake.closed, ['b1']);
    for (let i = 0; i < 4; i++) h.load(); // b8..b11
    assert.ok(!h.fake.closed.includes('b2') && !h.fake.closed.includes('b3'));
  } finally {
    await h.cleanup();
  }
});

test('with nothing left to evict, the new open is refused and the kept builds stay open', async () => {
  const h = await harness();
  try {
    h.load('open'); // b1
    for (let i = 0; i < 5; i++) h.load('shown'); // b2..b6
    const res = h.load(); // b7
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'TOO_MANY_BUILDS');
    assert.match(res.error!.message, /close/i);
    assert.deepEqual(h.fake.closed, ['b7']);
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']) assert.equal(h.request('getStats', { buildId: id }).ok, true);
    h.request('closeBuild', { buildId: 'b2' }); // closing a shown build makes room again
    assert.equal(h.load().ok, true);
  } finally {
    await h.cleanup();
  }
});
