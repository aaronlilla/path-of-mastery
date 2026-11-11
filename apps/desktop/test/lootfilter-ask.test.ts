import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOOT_TOOLS, LfProposalStore } from '../src/main/assistant/lootTools.js';
import { NeverSinkStore } from '../src/main/lootfilter/neversink.js';
import { LootFilterStore } from '../src/main/lootfilter/store.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { validateFilter } from '../src/shared/lootfilter/syntax.js';
import type { LfProposal } from '../src/shared/lootfilter/ipcTypes.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const tool = (n: string) => LOOT_TOOLS.find((t) => t.name === n)!;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pom-ask-'));
  const store = new LootFilterStore(join(dir, 'filters.json'));
  const st = await store.load();
  st.filters[0]!.rules.push({ id: 'r1', source: 'guided', enabled: true, priority: 1, visibility: 'hide', targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Chaos Orb'] }] }], guided: { sel: [{ t: 'item', name: 'Chaos Orb' }], exc: [], act: 'hide' } });
  await store.save(st);
  const proposals = new LfProposalStore();
  const seen: LfProposal[] = [];
  proposals.onCreated((p) => seen.push(p));
  const ctx = { origin: 'panel', loot: { store, ns: new NeverSinkStore(join(NEVERSINK_DIR, '..'), join(dir, 'dl')), prices: async () => null, proposals } } as never;
  return { dir, ctx, seen, store };
}

test('the assistant reads the filter and NeverSink lists, and nothing is invented', async () => {
  const { dir, ctx } = await setup();
  try {
    const f = (await tool('getLootFilter').run({}, ctx)) as { rules: { id: string; name: string }[]; strictness: { name: string }; neverSinkVersion: string };
    assert.equal(f.neverSinkVersion, '8.20.1d');
    assert.equal(f.strictness.name, 'Semi-Strict');
    assert.equal(f.rules[0]!.name, 'Hide: Chaos Orb.');
    const items = (await tool('findLootItems').run({ query: 'divine orb' }, ctx)) as { items: { name: string }[] };
    assert.ok(items.items.some((i) => i.name === 'Divine Orb'));
    const tiers = (await tool('listLootTiers').run({ section: 'currency' }, ctx)) as { tiers: { type: string; tier: string }[] };
    assert.ok(tiers.tiers.some((t) => t.type === 'currency' && t.tier === 't4chaos'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a proposal is a card, not a change: nothing is written, and the rules it carries make a valid filter', async () => {
  const { dir, ctx, seen, store } = await setup();
  try {
    const r = (await tool('proposeLootRules').run(
      { title: 'Quieter scrolls', changes: [{ action: 'hide', items: ['scroll of wisdom', 'Portal Scroll'] }, { action: 'loud', items: ['Divine Orb'], exceptItems: [] }] },
      ctx,
    )) as { proposalId: string; changes: { sentence: string; itemTypes: number }[] };
    assert.equal(seen.length, 1);
    assert.equal(r.changes[0]!.sentence, 'Hide: Scroll of Wisdom and Portal Scroll.');
    assert.equal(r.changes[0]!.itemTypes, 2);
    assert.equal((await store.load()).filters[0]!.rules.length, 1, 'the player rules are untouched');
    const rules = seen[0]!.changes.map((c, i) => ({ ...c.rule!, id: 'p' + i, priority: 10 + i }));
    const g = generateFilter({ baseText: readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8'), baseVersion: '8.20.1d', strictness: 2, style: 0, rules });
    assert.equal(validateFilter(g.text).errors, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('names that are not in NeverSink make the whole proposal fail with a way forward', async () => {
  const { dir, ctx, seen } = await setup();
  try {
    await assert.rejects(tool('proposeLootRules').run({ title: 'x', changes: [{ action: 'hide', items: ['Divine Orb', 'Totally Fake Orb'] }] }, ctx), /Totally Fake Orb.*findLootItems/);
    await assert.rejects(tool('proposeLootRules').run({ title: 'x', changes: [{ action: 'hide', tiers: [{ type: 'currency', tier: 'nope' }] }] }, ctx), /nope/);
    await assert.rejects(tool('proposeLootRules').run({ title: 'x', changes: [{ action: 'match', items: ['Divine Orb'] }] }, ctx), /matchTier/);
    assert.equal(seen.length, 0, 'no card was shown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
