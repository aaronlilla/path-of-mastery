import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseId } from '@pom/mastery-contracts';
import { createPlan } from '../src/shared/atlas/plan.js';
import { createGraph, known } from '../src/shared/atlas/graph.js';
import { mechanicRows } from '../src/shared/atlas/suggestions/mechanics.js';
import { evaluateRules, stableOrder, structuralWarnings, visibleRows, suggestionKey } from '../src/shared/atlas/suggestions/rules.js';
import { SuppressionLedger, type LedgerState } from '../src/shared/atlas/suggestions/ledger.js';
import { AiScheduler, AI_MIN_INTERVAL_MS, type Timers } from '../src/shared/atlas/suggestions/aiScheduler.js';
import { buildAiSummary, compileAiReply, parseAiReply } from '../src/shared/atlas/suggestions/ai.js';
import { AtlasAiAdvisor } from '../src/main/atlas/aiAdvisor.js';
import { MECHANIC_NAMES, optimizerDataset } from '../src/renderer/atlas/optimizer/fixtureData.js';

const data = optimizerDataset(), graph = createGraph(data.graph, known(data.costModel, 'synthetic-fixture'));
const mechanics = mechanicRows(graph, data.taxonomy, MECHANIC_NAMES), first = parseId('step', 'step:first');
const step = (ids: string[] = []) => { const p = createPlan(data.ref, data.ref.stamp, first, 8); const s = p.stepsById[first]!; s.allocatedIds = ids; return s; };
const ctx = (ids: string[], budget = 8) => ({ step: step(ids), graph, budget, mechanics, priority: [] as string[], sustainAvailable: true, sustainChosen: false, dataQualified: false, dataLabel: 'Live compatibility unverified' });

function clock() {
  let now = 0; const jobs: { at: number; fn: () => void; id: number }[] = []; let id = 0;
  const timers: Timers = { now: () => now, set: (fn, ms) => { jobs.push({ at: now + ms, fn, id: ++id }); return id; }, clear: h => { const i = jobs.findIndex(j => j.id === h); if (i >= 0) jobs.splice(i, 1); } };
  const advance = async (ms: number) => { const end = now + ms; for (;;) { jobs.sort((a, b) => a.at - b.at); const j = jobs[0]; if (!j || j.at > end) break; jobs.shift(); now = j.at; j.fn(); await Promise.resolve(); await Promise.resolve(); } now = end; };
  return { timers, advance, tick: (ms: number) => { now += ms; }, now: () => now };
}

test('rules: cheapest reach per mechanic, cluster finish only when small and sourced, literal empty reminders', () => {
  const out = evaluateRules(ctx([])).suggestions;
  const reach = out.filter(s => s.rule === 'reach-notable');
  assert.ok(reach.length > 0 && reach.every(s => /^Reach .+: \+\d+ points?$/.test(s.text)));
  assert.ok(reach.every(s => s.cost! <= 8 && s.afterIds!.includes(s.target!.nodeIds[0]!)));
  assert.deepEqual(out.filter(s => s.kind === 'info').map(s => s.text), ['No sustain targets set.', 'No maps selected.', 'No scarabs selected.']);
  const finish = evaluateRules(ctx(['a1', 'a2', 'alpha1'])).suggestions.find(s => s.rule === 'finish-cluster');
  assert.equal(finish?.text, 'Finish Synthetic Alpha: +1 point');
  assert.equal(evaluateRules(ctx(['a1', 'a2', 'alpha1'], 5)).suggestions.some(s => s.rule === 'reach-notable' && s.cost! > 0), true);
  assert.equal(evaluateRules({ ...ctx([]), budget: 0 }).suggestions.some(s => s.kind === 'path'), false);
});

test('rail shows at most three rows, rule rows before AI, and keeps order stable', () => {
  const rows = ['x1', 'x2', 'x3', 'x4'].map((id, i) => ({ id, key: id, rule: 'r', origin: (i === 0 ? 'AI' : 'Rule') as 'AI' | 'Rule', kind: 'path' as const, text: id, detail: '' }));
  const { shown, more } = visibleRows(rows);
  assert.deepEqual(shown.map(r => r.id), ['x2', 'x3', 'x4']); assert.deepEqual(more.map(r => r.id), ['x1']);
  assert.deepEqual(stableOrder(['x3', 'x2'], rows).map(r => r.id), ['x3', 'x2', 'x1', 'x4']);
});

test('suppression: two qualified ignores (>=5 s visible, then an unrelated edit) suppress; shorter or hover-only do not', () => {
  const c = clock(); let saved: LedgerState | null = null;
  const ledger = new SuppressionLedger('plan', { load: () => saved, save: (_id, s) => { saved = s; } }, c.now);
  const key = suggestionKey('reach-notable', 'n1', 'add');
  ledger.shown([key]); c.tick(4_999); ledger.unrelatedEdit();
  assert.equal(ledger.ignoresOf(key), 0, 'under 5 seconds');
  c.tick(1); ledger.unrelatedEdit();
  assert.equal(ledger.ignoresOf(key), 1, 'exactly 5 seconds counts');
  assert.equal(ledger.suppressed(key), false);
  c.tick(5_000); ledger.workspaceClosed();
  assert.equal(ledger.ignoresOf(key), 2); assert.equal(ledger.suppressed(key), true);
  assert.equal(new SuppressionLedger('plan', { load: () => saved, save: () => {} }, c.now).suppressed(key), true, 'persisted per plan');
  ledger.reset(); assert.equal(ledger.suppressed(key), false);
  const other = suggestionKey('reach-notable', 'n2', 'add');
  ledger.shown([other]); c.tick(9_000); ledger.shown([]); ledger.shown([other]); c.tick(1); ledger.unrelatedEdit();
  assert.equal(ledger.ignoresOf(other), 0, 'leaving the screen resets the clock; hover is not tracked at all');
  ledger.dismiss(other); assert.equal(ledger.suppressed(other), true, 'Dismiss is immediate');
  ledger.shown([key]); c.tick(6_000); ledger.unrelatedEdit(key);
  assert.equal(ledger.ignoresOf(key), 0, 'acting on a row is not an ignore');
});

test('structural warnings are not part of the ledger and survive total suppression', () => {
  const bad = step(['a1', 'missing-node']); bad.repair = { missingIds: ['missing-node'], disconnectedIds: [] };
  const over = step(['a1', 'a2', 'alpha1', 'alpha2']);
  assert.deepEqual(structuralWarnings(bad, graph).map(w => w.id), ['missing']);
  assert.deepEqual(structuralWarnings(over, graph, 2).map(w => w.text), ['2 points over your budget.']);
  assert.equal(structuralWarnings(step(), undefined)[0]!.tone, 'error');
  const ledger = new SuppressionLedger('p', null, () => 0);
  for (const s of evaluateRules(ctx([])).suggestions) ledger.dismiss(s.key);
  assert.equal(structuralWarnings(over, graph, 2).length, 1);
});

test('AI scheduler: silent until opted in, once per 10 s, never during a drag, latest summary only', async () => {
  const c = clock(), sent: number[] = [];
  const s = new AiScheduler<number>(async n => { sent.push(n); }, c.timers);
  s.notify(1); await c.advance(60_000); assert.deepEqual(sent, [], 'no request before opt-in');
  s.setEnabled(true); s.notify(1, true); await c.advance(0); assert.deepEqual(sent, [1]);
  s.notify(2); s.notify(3); s.notify(4); await c.advance(5_000); assert.deepEqual(sent, [1], 'inside the 10 s window');
  await c.advance(AI_MIN_INTERVAL_MS); assert.deepEqual(sent, [1, 4], 'one request, latest summary');
  s.setDragging(true); s.notify(5); await c.advance(60_000); assert.deepEqual(sent, [1, 4], 'nothing during drag');
  s.setDragging(false); await c.advance(2_000); assert.deepEqual(sent, [1, 4, 5]);
  s.setEnabled(false); s.notify(6); await c.advance(60_000); assert.deepEqual(sent, [1, 4, 5], 'off stops everything');
  for (let i = 1; i < sent.length; i++) assert.ok(true);
});

test('AI replies compile to local typed paths; unknown mechanics, extra facts and over-budget picks are dropped', () => {
  const st = step(['a1']), summary = buildAiSummary({ dataset: data.ref, step: st, graph, budget: 8, mechanics, priority: ['alpha'], avoided: [] });
  assert.equal(JSON.stringify(summary).includes('notes'), false);
  assert.ok(summary.options.length > 0 && summary.options.every(o => o.extraPoints > 0));
  const pick = summary.options[0]!;
  const reply = parseAiReply({ items: [{ targetId: pick.targetId, reason: 'Fits well. Adds 99 points.' }, { targetId: 'invented', reason: 'x' }, { targetId: 'delta', reason: 'y', cost: 1 }] })!;
  const rows = compileAiReply(reply, { step: st, graph, budget: 8, mechanics, summary, dataLabel: 'tree data' });
  assert.ok(rows.every(r => r.origin === 'AI' && r.target!.targetId !== 'invented'));
  assert.equal(rows[0]!.cost, pick.extraPoints, 'cost comes from the graph, not the reply');
  assert.equal(compileAiReply(reply, { step: st, graph, budget: 1, mechanics, summary, dataLabel: '' }).length, 0, 'budget check is local');
  assert.equal(parseAiReply({ items: [{ targetId: 7 }] }), null); assert.equal(parseAiReply('text'), null);
});

test('AI goes only through the AI gate: verify first, then model with an ai scope; malformed replies are refused', async () => {
  const calls: string[] = [];
  const gate = { state: { status: 'off' }, verify: async (_a: unknown, _t: unknown, scopes: string[]) => { calls.push(`verify:${scopes}`); },
    model: async (_a: unknown, scope: string) => { calls.push(`model:${scope}`); return scope === 'ai:suggest' ? { items: [{ targetId: 'alpha', reason: 'ok' }] } : { text: 'Explained.' }; } } as never;
  const target = { objectId: 'o', revisionId: 'r' } as never, advisor = new AtlasAiAdvisor(gate, () => target);
  const summary = buildAiSummary({ dataset: data.ref, step: step(), graph, budget: 8, mechanics, priority: [], avoided: [] });
  await advisor.verify(); assert.deepEqual((await advisor.suggest(summary)).items.map(i => i.targetId), ['alpha']); assert.equal(await advisor.explain(summary), 'Explained.');
  assert.deepEqual(calls, ['verify:ai:suggest', 'model:ai:suggest', 'model:ai:explain']);
  const bad = new AtlasAiAdvisor({ model: async () => ({ nope: 1 }) } as never, () => target);
  await assert.rejects(bad.suggest(summary));
});
