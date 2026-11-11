import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_KEY, rankAll, RankScheduler, type RankBatch } from '../src/renderer/items/rank.js';
import { BG_CHUNK, EngineConnection, STALE_RANK } from '../src/main/engineConnection.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('background ranking waits for the build to stay unchanged, and an edit stops the run and starts it again later', async () => {
  const started: string[] = [];
  const alives: Array<() => boolean> = [];
  const s = new RankScheduler<string>(async (key, alive) => {
    started.push(key);
    alives.push(alive);
    return false;
  }, 30);
  s.set('a');
  await wait(10);
  s.set('b'); // a burst of changes costs one run, for the last one
  await wait(60);
  assert.deepEqual(started, ['b']);
  assert.equal(alives[0]!(), true);
  s.set('c'); // the next change stops the run in progress at once
  assert.equal(alives[0]!(), false);
  await wait(60);
  assert.deepEqual(started, ['b', 'c']);
  s.set(null); // a closed build is not ranked
  assert.equal(alives[1]!(), false);
  await wait(60);
  assert.deepEqual(started, ['b', 'c']);
});

test('a run stopped by the app (stale) is tried again after another quiet spell', async () => {
  let n = 0;
  const s = new RankScheduler<string>(async () => ++n === 1, 20);
  s.set('a');
  await wait(80);
  assert.equal(n, 2);
  s.set(null);
});

test('a second ranking of the same build waits for the first one\'s candidates, and ranks what a stopped run left', async () => {
  const cands = [{ key: BASE_KEY, text: '', slots: [], base: true }, ...Array.from({ length: 70 }, (_, i) => ({ key: `k${i}`, text: 'x'.repeat(i + 1), slots: ['Ring 1'] }))];
  const asked = new Map<string, number>();
  const runner = (delay: number) => async (_s: string, b: RankBatch) => {
    await wait(delay);
    for (const c of b) asked.set(c.text, (asked.get(c.text) ?? 0) + 1);
    return b.map((c) => (c.base ? 100 : c.text.length));
  };
  const cache = new Map<string, number>();
  let bgAlive = true;
  const bg = rankAll('Life', false, cands, runner(5), cache, () => undefined, () => bgAlive);
  await wait(1);
  const seen: number[] = [];
  const fg = rankAll('Life', false, cands, runner(1), cache, (p) => seen.push(p), () => true);
  await wait(7);
  bgAlive = false; // the build changed under the background run after its first batch
  const [b, f] = await Promise.all([bg, fg]);
  assert.equal(b, null);
  assert.equal(f!.size, cands.length);
  assert.equal(f!.get('k9'), 10);
  // What the background run finished is not asked again; what it dropped is ranked by the second run.
  assert.ok(cands.slice(0, 32).every((c) => asked.get(c.text) === 1));
  assert.equal(seen[seen.length - 1], 1);
});

function fakeEngine() {
  let handler: (m: unknown) => void = () => undefined;
  const sent: Array<{ id: string; command: string; params: { candidates?: Array<{ slots: string[] }> } }> = [];
  const conn = new EngineConnection({ postMessage: (m) => sent.push((m as { request: (typeof sent)[number] }).request), onMessage: (h) => (handler = h), onExit: () => undefined, kill: () => undefined });
  const answer = (i: number, result: unknown) => handler({ kind: 'engine-response', response: { id: sent[i]!.id, command: sent[i]!.command, ok: true, result } });
  return { conn, sent, answer };
}

test('background ranking goes to the engine in small pieces, one slot each, behind any other call, and stops at an edit', async () => {
  const { conn, sent, answer } = fakeEngine();
  const click = conn.send('getStats', { buildId: 'b' });
  const cands = [{ text: 'ring', slots: ['Ring 1', 'Ring 2'] }, ...Array.from({ length: BG_CHUNK }, (_, i) => ({ text: `t${i}`, slots: ['Helmet'] }))];
  const bg = conn.send('itemRank', { buildId: 'b', stat: 'Life', candidates: cands, background: true } as never);
  await wait(60);
  assert.equal(sent.length, 1, 'nothing goes while another call waits');
  answer(0, { stats: [] });
  await click;
  await wait(80);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.params.candidates!.map((c) => c.slots), [['Ring 1'], ['Ring 2'], ...Array.from({ length: BG_CHUNK - 2 }, () => ['Helmet'])]);
  answer(1, { values: [5, 9, 1, 1, 1, 1, 1, 1] });
  await wait(80);
  answer(2, { values: [2, 2] });
  const r = (await bg) as unknown as { values: number[]; epoch: number };
  assert.deepEqual(r.values.slice(0, 3), [9, 1, 1]);
  // An edit to the build fails the rest of a run that began before it.
  void conn.send('edit', { buildId: 'b', edit: { kind: 'setXml', xml: '' } } as never);
  answer(3, {});
  await assert.rejects(conn.send('itemRank', { buildId: 'b', stat: 'Life', candidates: cands, background: true, epoch: r.epoch } as never), new RegExp(STALE_RANK));
});

test('a call the engine never answered fails when the engine process exits, and background work goes on after it', async () => {
  let exit: (code: number | null) => void = () => undefined;
  let handler: (m: unknown) => void = () => undefined;
  const sent: Array<{ id: string; command: string }> = [];
  const conn = new EngineConnection({ postMessage: (m) => sent.push((m as { request: (typeof sent)[number] }).request), onMessage: (h) => (handler = h), onExit: (h) => (exit = h), kill: () => undefined });
  const lost = conn.send('getStats', { buildId: 'b' });
  exit(1);
  await assert.rejects(lost, /engine stopped/);
  // The foreground count went back to zero, so a background piece is let through.
  void conn.send('itemsInfo', { buildId: 'b', texts: ['x'], background: true } as never);
  await wait(80);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.command, 'itemsInfo');
  handler({ kind: 'engine-response', response: { id: sent[1]!.id, command: 'itemsInfo', ok: true, result: { items: [] } } });
});
