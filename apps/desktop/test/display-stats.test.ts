import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactNumber, formatStat, skillFlags, statDelta, statLines, toOut } from '../src/shared/displayStats.js';

test('formatStat follows the original format strings', () => {
  assert.equal(formatStat(4639.4, 'd'), '4,639');
  assert.equal(formatStat(1.78, '.2f'), '1.78');
  assert.equal(formatStat(88.256, '.2f%%'), '88.26%');
  assert.equal(formatStat(-52, 'd%%'), '−52%');
  assert.equal(formatStat(1.4, '+d%%', 100, 100), '+40%');
  assert.equal(formatStat(1.5, '+.1f'), '+1.5');
  assert.equal(formatStat(0.627, '.3fs'), '0.627s');
  assert.equal(formatStat(Infinity, 'd'), '∞');
  assert.equal(formatStat(3011785.1, '.1f', 1, 0, true), '3.01M');
  assert.equal(compactNumber(612044), '612k');
});

test('toOut reads Inf strings as infinities', () => {
  const o = toOut({ A: 'Inf', B: '-Inf', C: 5, D: 'x' });
  assert.deepEqual([o.A, o.B, o.C, o.D], [Infinity, -Infinity, 5, 'x']);
});

test('skillFlags tells attacks from spells by the stats only they have', () => {
  assert.ok(skillFlags({ MainHand: { Accuracy: 1 }, Speed: 2 }).has('attack'));
  assert.ok(!skillFlags({ MainHand: { Accuracy: 1 }, Speed: 2 }).has('spell'));
  assert.ok(skillFlags({ CastRate: 3, Speed: 3 }).has('spell'));
  assert.ok(skillFlags({ Speed: 0 }).has('showAverage'));
  assert.ok(skillFlags({ Speed: 2 }).has('notAverage'));
});

const A = { Life: 4639, TotalEHP: 19055, FireResist: 80, ChaosResist: -52, EffectiveMovementSpeedMod: 1.37, CastRate: 9, Speed: 9, TotalDPS: 3000000, CombinedDPS: 3000000, ManaHasCost: true, ManaCost: 30 };
const B = { Life: 3812, TotalEHP: 14902, FireResist: 76, ChaosResist: 41, EffectiveMovementSpeedMod: 1.61, MainHand: { Accuracy: 900 }, Speed: 3, TotalDPS: 600000, CombinedDPS: 600000, ManaCost: 0, ManaHasCost: false };

test('statLines shows rows either build has, with labels, groups and the original order', () => {
  const lines = statLines(toOut(A), toOut(B));
  const by = (stat: string, label?: string) => lines.find((l) => l.stat === stat && (!label || l.label === label));
  assert.deepEqual(by('Life')?.group, 'd');
  assert.deepEqual([by('FireResist')?.a, by('FireResist')?.b], [80, 76]);
  assert.equal(by('ChaosResist')?.label, 'Chaos Resistance');
  // A casts, B attacks: both rate rows show, once each for the build whose skill fits.
  assert.ok(by('Speed', 'Cast Rate'));
  assert.ok(by('Speed', 'Attack Rate'));
  // Combined DPS equals Hit DPS here, so upstream hides it.
  assert.equal(by('CombinedDPS'), undefined);
  assert.ok(by('ManaCost'), 'a cost row shows when either build has the cost');
  assert.ok(!lines.some((l) => l.stat === 'Str'), 'zero in both builds is not shown');
  const idx = (stat: string) => lines.findIndex((l) => l.stat === stat);
  assert.ok(idx('TotalDPS') < idx('Life'));
});

test('statDelta gives A minus B with a percentage, and colours by which build is better', () => {
  const lines = statLines(toOut(A), toOut(B));
  const life = lines.find((l) => l.stat === 'Life')!;
  assert.deepEqual(statDelta(life), { text: '+827 (+21.7%)', better: 1, magnitude: 827 / 3812 });
  const cost = lines.find((l) => l.stat === 'ManaCost')!;
  assert.equal(statDelta(cost).better, -1, 'a higher cost is worse');
  const res = lines.find((l) => l.stat === 'FireResist')!;
  assert.equal(statDelta(res).text, '+4%');
  const same = { ...life, a: 5, b: 5 };
  assert.deepEqual(statDelta(same), { text: '—', better: 0, magnitude: 0 });
  const move = lines.find((l) => l.stat === 'EffectiveMovementSpeedMod')!;
  assert.equal(statDelta(move).text, '−24%');
  assert.equal(formatStat(move.a, move.fmt, move.scale, move.offset), '+37%');
});

test('statLines lists Average Damage once when an attack also carries the inferred explode-flag row', () => {
  const atk = { MainHand: { Accuracy: 900 }, Speed: 3, AverageDamage: 5000, HitChance: 90, TotalDPS: 15000 };
  const low = { MainHand: { Accuracy: 800 }, Speed: 2, AverageDamage: 4000, HitChance: 85, TotalDPS: 8000 };
  const rows = statLines(toOut(atk), toOut(low)).filter((l) => l.stat === 'AverageDamage');
  assert.equal(rows.length, 1);
});
