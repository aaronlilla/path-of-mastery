import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewLine } from '../src/main/assistant/tools.js';
import { rankStat } from '../src/main/assistant/buildTools.js';
import { deltaTone, formatStat } from '../src/shared/assistant/statLabels.js';
import { search, type SearchDoc } from '../src/renderer/search/searchIndex.js';
import { answerFor, readNumber } from '../src/renderer/search/answers.js';
import { defenceReport } from '../src/main/assistant/defence.js';
import { findingNote } from '../src/main/assistant/results.js';
import { ACCURACY_OVER_LIFE } from '../src/main/assistant/thresholds.js';
import { figuresOf } from '../src/shared/buildXml.js';
import { GOAL_IN_WORDS, routeMessage, type RouterDeps } from '../src/main/assistant/router.js';

// What the app tells the player matches what the code does.

test('previewLine names Precise Technique only when its flag flips, not for any +20% damage', () => {
  const none = previewLine([{ statId: 'CombinedDPS', before: 1000, after: 1250 }]);
  assert.doesNotMatch(none, /Precise/);
  const flip = previewLine([{ statId: 'CombinedDPS', before: 1000, after: 1250 }, { statId: 'PreciseTechnique', before: false, after: true }]);
  assert.match(flip, /Precise Technique/);
});

test('compareOptions ranks by the first asked stat the build has, not Full DPS = 0', () => {
  assert.equal(rankStat(['FullDPS', 'CombinedDPS', 'TotalEHP'], { FullDPS: 0, CombinedDPS: 900, TotalEHP: 5 }), 'CombinedDPS');
  assert.equal(rankStat(['FullDPS', 'CombinedDPS'], { FullDPS: 0, CombinedDPS: 0 }), 'FullDPS');
});

test('block, dodge, evade and phys reduction read as percent; movement speed as +30%; missing resist falling is good', () => {
  assert.equal(formatStat('AttackDodgeChance', 40), '40%');
  assert.equal(formatStat('EvadeChance', 55), '55%');
  assert.equal(formatStat('PhysicalDamageReduction', 12), '12%');
  assert.equal(formatStat('EffectiveMovementSpeedMod', 1.3), '+30%');
  assert.equal(deltaTone('MissingFireResist', 25, 0), 'pos');
  assert.equal(deltaTone('MissingFireResist', 0, 25), 'neg');
});

const stat = (title: string, meta: string): SearchDoc => ({ kind: 'Stat', title, meta, run: () => undefined });
const card = (q: string, docs: SearchDoc[]) => {
  const l = search(q, docs).locked;
  return l ? answerFor(l.id, l.title, l.where, q, docs) : null;
};

test('search: pools card shows Total Life, weak points name fire at 20%, an over-max res is Capped', () => {
  const docs = [stat('Total Life', '4,639'), stat('Fire Resistance', '20%'), stat('Cold Resistance', '75%'), stat('Lightning Resistance', '80% (+12%)')];
  const pools = card('how much life do I have', docs)!;
  assert.ok(pools.rows.some((r) => r.label === 'Life'), 'Life row present');
  const weak = card('weak points', docs)!;
  assert.deepEqual(weak.rows.map((r) => r.label), ['Fire']);
  assert.equal(readNumber('res', '60% (+4%)').status, 'Capped');
});

test('defence: a low life plus ES warning shows the summed pool', () => {
  const r = defenceReport({ Life: 3000, EnergyShield: 500 });
  const p = r.topProblems.find((x) => x.id === 'Life')!;
  assert.match(p.shown, /3,?500/);
});

test('unreserved life is not worded as mana', () => {
  assert.equal(findingNote({ line: 'Unreserved life is negative' }), 'unreserved life is negative');
  assert.equal(findingNote({ id: 'manaUnreserved' }), 'unreserved mana is negative');
});

test('Precise Technique margin uses the lower of both hands', () => {
  const raw = [{ id: 'Life', value: 4000 }, { id: 'MainHand', value: { Accuracy: 5000 } }, { id: 'OffHand', value: { Accuracy: 3000 } }];
  assert.equal(ACCURACY_OVER_LIFE.short(raw as never), 4001 - 3000);
});

test('a minion build card shows the minion damage, not 0', () => {
  assert.equal(figuresOf({ FullDPS: 0, CombinedDPS: 0, MinionCombinedDPS: 750 }).dps, 750);
  assert.equal(figuresOf({ FullDPS: 0, CombinedDPS: 5, MinionCombinedDPS: 750 }).dps, 5);
});

const deps = (stats: Array<{ id: string; label: string; shown: string }>): RouterDeps => ({
  decide: async () => ({ route: { choice: 'stat', confidence: 0.95 } }),
  openSolve: () => undefined,
  lookup: async (_t, args) => ({ stats: (args as { search?: string }).search ? stats.filter((s) => s.label.toLowerCase().includes(String((args as { search?: string }).search))) : stats.slice(0, 1) }),
});

test('router: "life regen" does not answer with Life, "movement speed" not with attack rate, an exact label still answers', async () => {
  const s = [{ id: 'Life', label: 'Life', shown: '5,120' }, { id: 'Speed', label: 'Attack rate', shown: '4.1' }];
  assert.equal(await routeMessage('what is my life regen', deps(s)), null);
  assert.equal(await routeMessage('what is my movement speed', deps(s)), null);
  assert.equal((await routeMessage('what is my life?', deps(s)))?.text, 'Life: 5,120');
});

test('router: "1 million dps" is a goal; a minion word no longer blocks a tab jump', async () => {
  assert.match('make me a build with 1 million dps', GOAL_IN_WORDS);
  const r = await routeMessage('show my minion skills tab', { ...deps([]), decide: async () => ({ route: { choice: 'go-skills', confidence: 0.95 } }) });
  assert.equal(r?.nav, 'skills');
});
