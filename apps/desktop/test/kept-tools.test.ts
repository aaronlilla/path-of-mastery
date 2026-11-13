import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptAnswer, tagOverlap } from '../src/main/assistant/keptTools.js';
import { keptAll, keptFor, keptEvidence } from '../src/main/assistant/skeletons.js';
import { loadPatterns, patternsAnswer } from '../src/main/assistant/buildPatterns.js';
import { evidenceFor } from '../src/shared/assistant/solveQuestions.js';

// PLAN.md slice 5c: the agent's keptBuilds answer and the wizard's evidence for every skill the shipped files cover.

const BOUNCING = 'Poisonous Concoction of Bouncing';
const tags = (g: string) => ({ [BOUNCING]: ['Attack', 'Projectile', 'Chaos', 'Duration', 'Physical'], 'Poisonous Concoction': ['Attack', 'Projectile', 'Chaos', 'Duration', 'Physical'], 'Toxic Rain': ['Attack', 'Projectile', 'Chaos', 'Duration', 'Bow'], 'Fireball': ['Spell', 'Projectile', 'Fire'] })[g] ?? null;
const start = (a: { skill: string; wealth?: string; level?: number }) => keptFor({ skill: a.skill, ...(a.wealth ? { wealth: a.wealth } : {}), ...(a.level ? { level: a.level } : {}) } as never)?.id ?? null;
const pack = () => loadPatterns();

test('the kept build comes back with what it reaches against the ask, where the Run starts and how far real characters get', () => {
  const a = keptAnswer({ skill: BOUNCING, wealth: 'mid-league', level: 95, dps: 3e6, ehp: 8e4 }, pack(), keptAll(), tags, start);
  assert.equal(a.runStartsFrom, 'pconc-bouncing-pathfinder-mid-league');
  assert.deepEqual(a.keptBuilds.map((b) => b.tier), ['league-start', 'mid-league']);
  const mid = a.keptBuilds[1]!;
  assert.match(mid.line, /4\.38M DPS and 22k EHP on our engine \(DPS 146% of the ask, EHP 27% of the ask\)/);
  assert.match(mid.realCharacters!, /0 of 98 week-one characters reach 80k EHP/);
  assert.equal(a.nearestOtherSkill, undefined);
});

test('the plain gem has no kept build of its own: the other version is named, the Run starts blank', () => {
  const a = keptAnswer({ skill: 'Poisonous Concoction', wealth: 'mid-league', dps: 3e6 }, pack(), keptAll(), tags, start);
  assert.equal(a.keptBuilds.length, 0);
  assert.equal(a.runStartsFrom, null);
  assert.deepEqual(a.otherGemVersions!.map((b) => b.gem), [BOUNCING, BOUNCING]);
  assert.equal(a.nearestOtherSkill, undefined);
});

test('a skill with no kept build gets the nearest kept build of the same kind, marked as another skill; an unlike skill gets none', () => {
  const like = keptAnswer({ skill: 'Toxic Rain' }, pack(), keptAll(), tags, start);
  assert.equal(like.nearestOtherSkill![0]!.otherSkill, true);
  assert.equal(like.runStartsFrom, null);
  const unlike = keptAnswer({ skill: 'Fireball' }, pack(), keptAll(), tags, start);
  assert.equal(unlike.nearestOtherSkill, undefined);
  assert.match(unlike.none!, /research it/);
  assert.equal(tagOverlap(['a', 'b'], ['b', 'c']), 1 / 3);
});

test('the wizard evidence now covers the skills of the census; a skill the pack already answers keeps the pack', () => {
  const p = pack();
  // census only: counts and ascendancy shares of poe.ninja's search totals
  const ed = evidenceFor(p, 'Essence Drain')!;
  assert.equal(ed.ascendancies![0]!.name, 'Occultist');
  assert.ok(ed.ascendancies![0]!.share > 0.9);
  assert.equal(evidenceFor(p, 'Summon Raging Spirit')!.ascendancies![0]!.name, 'Necromancer');
  // pack and census on different scales: the pack's group stands, nothing from the census is mixed in
  assert.equal((p.bySkill['Righteous Fire'] as { countsOnly?: boolean }).countsOnly, undefined);
  assert.equal(evidenceFor(p, 'Righteous Fire')!.ascendancies![0]!.name, 'Chieftain');
  assert.ok(evidenceFor(p, 'Righteous Fire')!.sits);
  // the gem version of the typed skill is one tap only when another version has more players
  const pconc = evidenceFor(p, 'Poisonous Concoction')!;
  assert.deepEqual(pconc.versions!.map((v) => v.name).sort(), ['Poisonous Concoction', BOUNCING]);
  assert.ok(keptEvidence()[BOUNCING]!.builds > keptEvidence()['Poisonous Concoction']!.builds);
});

test('buildPatterns never shows a counts-only group as a pattern', () => {
  const r = patternsAnswer(pack(), { skill: 'Essence Drain' }) as { results: Array<{ sampleSize: number; supports?: unknown; note?: string }> };
  assert.ok(r.results[0]!.sampleSize > 900);
  assert.equal(r.results[0]!.supports, undefined);
  assert.match(r.results[0]!.note!, /Counts only/);
});
