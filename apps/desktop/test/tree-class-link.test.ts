import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classConnectPath, isClassConnected, type ClassGraph } from '../src/shared/classConnect.js';
import { resolvePoeUrl, shrinkWithPoeUrl } from '../src/shared/poeUrl.js';

// 100 = Witch start, 200 = Duelist start. Witch side: 100-1-2-3, Duelist side: 200-10-11-3 (they meet at node 3).
// 20 is an ascendancy node next to the Duelist start, 21 a hidden proxy.
const L: Record<number, number[]> = { 100: [1], 1: [100, 2], 2: [1, 3], 3: [2, 11], 11: [3, 10], 10: [11, 200], 200: [10, 20, 21], 20: [200], 21: [200] };
const K: Record<number, { t: number; a?: string; px?: boolean }> = { 100: { t: 5 }, 200: { t: 5 }, 1: { t: 0 }, 2: { t: 0 }, 3: { t: 0 }, 10: { t: 0 }, 11: { t: 0 }, 20: { t: 0, a: 'Slayer' }, 21: { t: 0, px: true } };
const g: ClassGraph = { links: (id) => L[id] ?? [], kind: (id) => K[id] };

test('the shortest route from the new class start to the tree is the one to allocate', () => {
  assert.deepEqual(classConnectPath(g, 200, new Set([100, 1, 2, 3])), [10, 11]);
});

test('nothing to add when the tree already touches the new class start', () => {
  assert.deepEqual(classConnectPath(g, 200, new Set([100, 1, 2, 3, 11, 10])), []);
});

test('ascendancy and hidden nodes are never part of the route', () => {
  assert.equal(classConnectPath(g, 200, new Set([100, 20])), null);
});

test('class counts as connected only when an allocated neighbour of its start leads back to the current start', () => {
  assert.equal(isClassConnected(g, 200, new Set([100, 1, 2, 3, 11, 10]), 100), true);
  assert.equal(isClassConnected(g, 200, new Set([100, 1, 2, 3]), 100), false);
  assert.equal(isClassConnected(g, 200, new Set([100, 10]), 100), false);
});

test('a PoEURL short link is resolved from its redirect, not followed', async () => {
  let seen: { url: string; redirect?: string } | null = null;
  const fake = (async (url: string, init?: { redirect?: string }) => {
    seen = { url, redirect: init?.redirect };
    return new Response(null, { status: 302, headers: { location: 'https://www.pathofexile.com/passive-skill-tree/3.15.0/AAAABgMAAAAA' } });
  }) as unknown as typeof fetch;
  assert.equal(await resolvePoeUrl('http://poeurl.com/dABz', fake), 'https://www.pathofexile.com/passive-skill-tree/3.15.0/AAAABgMAAAAA');
  assert.equal(seen!.redirect, 'manual');
  await assert.rejects(() => resolvePoeUrl('https://example.com/x', fake), /Failed to resolve PoEURL link/);
  const loop = (async () => new Response(null, { status: 302, headers: { location: 'http://poeurl.com/again' } })) as unknown as typeof fetch;
  await assert.rejects(() => resolvePoeUrl('http://poeurl.com/dABz', loop), /Failed to resolve PoEURL link/);
});

test('Import Tree turns a pasted link into a tree set, whichever site it came from', async () => {
  const { specFromLink } = await import('../src/shared/treeLinkImport.js');
  const { readSpecSummaries } = await import('../src/shared/treeSets.js');
  const known = ['3_15', '3_29', '3_29_ruthless'];
  const deps = {
    known,
    resolve: async () => 'https://www.pathofexile.com/passive-skill-tree/3.15.0/AAAABgMAAgADAAUAAA==',
    fetchBuild: async () => '<PathOfBuilding><Tree activeSpec="2"><Spec title="a" classId="1" nodes="1" treeVersion="3_29"/><Spec title="b" classId="4" ascendClassId="1" nodes="7,8,9" treeVersion="3_29"><Sockets><Socket nodeId="7" itemId="3"/></Sockets></Spec></Tree></PathOfBuilding>',
  };
  const asXml = (spec: string) => `<Tree activeSpec="1">${spec}</Tree>`;
  const ggg = await specFromLink('https://www.pathofexile.com/passive-skill-tree/ruthless/AAAABgMAAgADAAUAAA==', 'Mine', deps);
  assert.ok(ggg.ok);
  if (ggg.ok) {
    assert.equal(ggg.version, '3_29_ruthless');
    assert.deepEqual(readSpecSummaries(asXml(ggg.spec)).specs[0]!.nodes, [3, 5]);
  }
  const short = await specFromLink('http://poeurl.com/dABz', 'Short', deps);
  assert.ok(short.ok && short.version === '3_15');
  const site = await specFromLink('https://pobb.in/abcdef', 'From a build', deps);
  assert.ok(site.ok);
  if (site.ok) {
    const s = readSpecSummaries(asXml(site.spec)).specs[0]!;
    assert.deepEqual([s.title, s.classId, s.nodes], ['From a build', 4, [7, 8, 9]]);
    assert.ok(!site.spec.includes('itemId="3"'), 'the other build’s jewels do not come along');
  }
  const planner = await specFromLink('https://poeplanner.com/abc', 'x', deps);
  assert.ok(!planner.ok);
  const bad = await specFromLink('hi', 'x', deps);
  assert.deepEqual(bad, { ok: false, error: 'Invalid tree link (unrecognised format)' });
  const failed = await specFromLink('http://poeurl.com/zzz', 'x', { ...deps, resolve: async () => { throw new Error('Failed to resolve PoEURL link'); } });
  assert.deepEqual(failed, { ok: false, error: 'Failed to resolve PoEURL link' });
});

test('the shrink answer becomes a poeurl.com link, anything else is a failure', async () => {
  const ok = (async () => new Response('dABz')) as unknown as typeof fetch;
  assert.equal(await shrinkWithPoeUrl('https://x/y', ok), 'http://poeurl.com/dABz');
  const bad = (async () => new Response('<html>error</html>')) as unknown as typeof fetch;
  await assert.rejects(() => shrinkWithPoeUrl('https://x/y', bad), /Failed to get PoEURL link/);
});
