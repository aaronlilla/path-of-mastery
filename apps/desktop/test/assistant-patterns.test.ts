import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SAMPLE, patternsAnswer, type PatternsPack } from '../src/main/assistant/buildPatterns.js';

const spread = { p10: 1, p50: 2, p90: 3, max: 4 };
const big = { builds: 20, ascendancies: [{ name: 'Elementalist', count: 12, share: 0.6 }], supports: [], keystones: [], notables: [], uniques: [], auras: [], heralds: [], guards: [], dps: spread, ehp: spread, life: spread, energyShield: spread };
const pack: PatternsPack = { note: 'n', league: 'TestLeague', collected: ['2026-10-30'], builds: 40, overall: big, bySkill: { 'Big Skill': big, 'Rare Skill': { builds: 3 } }, byTag: { Spell: big } };

test('a big enough group shows its pattern with sample size, league, date and the default-Config caveat', () => {
  const r = patternsAnswer(pack, { skill: 'big skill' }) as any;
  assert.equal(r.results[0].sampleSize, 20);
  assert.equal(r.results[0].ascendancies[0].name, 'Elementalist');
  assert.equal(r.league, 'TestLeague');
  assert.deepEqual(r.collected, ['2026-10-30']);
  assert.ok(r.caveats.some((c: string) => /default Config/.test(c) && /understated/.test(c)));
});

test('a group under the minimum says the sample is too small and shows no pattern', () => {
  const r = patternsAnswer(pack, { skill: 'Rare Skill' }) as any;
  assert.equal(r.results[0].tooSmall, true);
  assert.equal(r.results[0].sampleSize, 3);
  assert.ok(!('ascendancies' in r.results[0]) && !('dps' in r.results[0]));
  assert.match(r.results[0].note, new RegExp(`fewer than ${MIN_SAMPLE}`));
  assert.ok(r.skillsWithEnoughBuilds.some((s: { name: string }) => s.name === 'Big Skill'));
});

test('an unknown skill is reported as not in the sample', () => {
  assert.match((patternsAnswer(pack, { skill: 'Nope' }) as any).notInSample, /Nope/);
});
