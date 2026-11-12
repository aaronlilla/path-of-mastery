import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KB_PROMPT_RULE, KB_TOOLS } from '../src/main/assistant/kbTools.js';
import { BUILD_TOOLS } from '../src/main/assistant/buildTools.js';
import { lootSystemPrompt, systemPrompt } from '../src/main/assistant/prompts.js';
import type { ToolContext } from '../src/main/assistant/tools.js';
import { buildKb } from '../src/main/kb/build.js';
import { KbStore } from '../src/main/kb/knowledgeBase.js';
import { fakeSources, noNet } from './kbHelpers.js';

type R = Record<string, any>;
const tool = (n: string) => KB_TOOLS.find((t) => t.name === n)!;

async function withKb(fn: (ctx: ToolContext, store: KbStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pom-kbt-'));
  const out = join(dir, 'kb.sqlite');
  await buildKb({ out, cacheDir: join(dir, 'c'), app: { levelingDir: dir, lootfilterDir: dir, engineDataDir: dir }, http: noNet, livePatch: '3.29.3.3', sources: fakeSources({}), force: true });
  const store = new KbStore(out);
  store.reload();
  const ctx = { kb: { ready: async () => store }, origin: 'panel' } as unknown as ToolContext;
  try {
    await fn(ctx, store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('KB tools are registered with the build tools, with chips, unique names, and the prompt rule', () => {
  const names = BUILD_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of ['searchGame', 'lookupGame', 'patchChanges', 'getMechanic', 'kbStatus']) assert.ok(names.includes(n), n);
  const sys = systemPrompt({ tools: names });
  assert.ok(sys.includes(KB_PROMPT_RULE));
  assert.match(sys, /Never state them from memory/);
  assert.ok(lootSystemPrompt({ tools: ['getLootFilter', ...KB_TOOLS.map((t) => t.name)] }).includes(KB_PROMPT_RULE));
  assert.ok(!systemPrompt({ tools: ['getStats'] }).includes(KB_PROMPT_RULE));
});

test('patchChanges answers "what changed in 3.29.3" from the official notes, with the patch and URL', () =>
  withKb(async (ctx) => {
    const r = (await tool('patchChanges').run({ version: '3.29.3' }, ctx)) as R;
    assert.equal(r.dataPatch, '3.29.3.3');
    assert.equal(r.behind, false);
    assert.equal(r.version, '3.29.3');
    assert.equal(r.sections.length, 1);
    // lines, so a figure inside the notes is quoted as its whole line ("+10% quality" could not be shown)
    assert.match(r.sections[0].lines.join('\n'), /Conflagration/);
    assert.equal(r.sections[0].url, 'https://www.pathofexile.com/forum/view-thread/3996516');
    assert.equal(r.sections[0].sourceType, 'official');
  }));

test('getMechanic answers "what is the Allflame league mechanic" with the league section first', () =>
  withKb(async (ctx) => {
    const r = (await tool('getMechanic').run({ name: 'Allflame' }, ctx)) as R;
    assert.match(r.sections[0].title, /Challenge League/);
    assert.match(r.sections[0].lines.join('\n'), /The Sovereign/);
    assert.equal(r.mechanics[0].league, 'Allflame');
    assert.equal(r.mechanics[0].sourceType, 'datamined');
  }));

test('getMechanic with scaling rules but no article does not tell the model it has no data', () =>
  withKb(async (ctx) => {
    const r = (await tool('getMechanic').run({ name: 'poison' }, ctx)) as R & { rules?: unknown[]; note?: string };
    assert.ok(r.rules?.length, 'poison has scaling rules');
    if (!r.mechanics.length && !r.sections.length) assert.doesNotMatch(r.note ?? '', /do not have data/);
  }));

test('lookupGame and searchGame cite every row; behind warning shows when the live patch moves', () =>
  withKb(async (ctx, store) => {
    const g = (await tool('lookupGame').run({ kind: 'gem', name: 'Poisonous Concoction' }, ctx)) as R;
    assert.equal(g.found, true);
    assert.equal(g.rows[0].req_level, 12);
    assert.equal(g.rows[0].cite.sourceType, 'datamined');
    assert.equal(g.rows[0].cite.patch, '3.29.3.3');
    // keyed by gem level, so levels[20] is level 20 (otherwise the model cited a position and printed a dash)
    assert.deepEqual(Object.keys(g.rows[0].levels), ['1', '20']);
    assert.equal(g.rows[0].levels['20'].level, 20);
    // one offers list: two in different orders made Claude print Siosa's level for Clarissa
    assert.equal(g.rows[0].offers.length, 1);
    assert.equal(g.rows[0].data.offers, undefined);
    // the quest by name, never its id (an id once printed as "a3q8")
    assert.equal(g.rows[0].offers[0].quest, 'Breaking Some Eggs');
    const miss = (await tool('lookupGame').run({ kind: 'gem', name: 'Poisonous' }, ctx)) as R;
    assert.equal(miss.found, false);
    assert.equal(miss.candidates[0].name, 'Poisonous Concoction');
    const s = (await tool('searchGame').run({ query: 'ducat' }, ctx)) as R;
    assert.equal(s.results[0].kind, 'league');
    assert.ok(s.results[0].url);

    store.setLive({ livePatch: '3.29.4.0', checkedAt: Date.now() });
    const st = (await tool('kbStatus').run({}, ctx)) as R;
    assert.equal(st.behind, true);
    assert.match(st.warning, /behind the live game/);
    assert.equal(st.sources.length, 3);
  }));

test('without a KB the tools say so instead of answering', async () => {
  await assert.rejects(tool('searchGame').run({ query: 'x' }, { origin: 'panel' } as unknown as ToolContext), /not available/);
});
