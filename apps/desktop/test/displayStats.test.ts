import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_NUMBER_FORMAT, buildSidebar, formatNumSep, formatStat, matchFlags, normaliseOutput, sFormat } from '../src/renderer/displayStats.js';
import { displayStats, minionDisplayStats, extraSaveStats } from '../src/renderer/displayStatsData.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, '../../test/fixtures/stats-slayer-like.json'), 'utf8')) as Record<string, unknown>;
const F = DEFAULT_NUMBER_FORMAT;

test('the port has every row of the original', () => {
  // 87 rows carry a show condition (the "88" in the ticket counts the doc comment) in BuildDisplayStats.lua (displayStats and minionDisplayStats together).
  const withCond = [...displayStats, ...minionDisplayStats].filter((s) => s.condFunc).length;
  assert.equal(withCond, 87);
  assert.equal(extraSaveStats.length, 8);
  assert.equal(displayStats.filter((s) => s.stat).length, 158);
});

test('sFormat matches C printf for the formats the list uses', () => {
  assert.equal(sFormat('d', 3.9), '3');
  assert.equal(sFormat('d', -3.9), '-3');
  assert.equal(sFormat('.1f', 1720531.04), '1720531.0');
  assert.equal(sFormat('.0f', 0.5), '0');
  assert.equal(sFormat('.0f', 1.5), '2');
  assert.equal(sFormat('.0f', 2.5), '2');
  assert.equal(sFormat('d%%', 20), '20%');
  assert.equal(sFormat('+d%%', 12), '+12%');
  assert.equal(sFormat('.2fs', 0.456), '0.46s');
  assert.equal(sFormat('+.1f', -2.25), '-2.2');
  assert.equal(sFormat('.1f', Infinity), 'inf');
});

test('formatStat trims zeros, adds separators, compacts and marks negatives', () => {
  const sd = { fmt: '.1f', compactValue: true };
  assert.equal(formatStat(sd, 1720531, undefined, F).text, '1,720,531');
  assert.equal(formatStat({ fmt: '.2f' }, 12.5, undefined, F).text, '12.5');
  assert.equal(formatStat({ fmt: 'd%%' }, -20, undefined, F).negative, true);
  assert.equal(formatStat(sd, 1720531, undefined, { ...F, compact: true }).text, '1.7M');
  assert.equal(formatStat(sd, 3_120_000, undefined, { ...F, compact: true }).text, '3.1M');
  assert.equal(formatStat({ fmt: 'd%%' }, 75, 12, F).text, '75% (+12%)');
  assert.equal(formatStat({ fmt: '+d%%', mod: true }, 1.35, undefined, F).text, '+35%');
  assert.equal(formatNumSep('1234567.5', { ...F, thousandsSeparator: ' ', decimalSeparator: ',' }), '1 234 567,5');
});

test('matchFlags is the original’s', () => {
  const flags = new Set(['attack', 'hit']);
  assert.equal(matchFlags('attack', undefined, flags), true);
  assert.equal(matchFlags('spell', undefined, flags), false);
  assert.equal(matchFlags(undefined, 'hit', flags), false);
});

test('a real build: rows, order, show conditions and Full DPS', () => {
  const out = normaliseOutput(fixture);
  const m = buildSidebar(out, new Set(['attack', 'hit', 'notAverage', 'melee']), F);
  const labels = m.rows.map((r) => r.label);
  assert.ok(labels.includes('Total Life'));
  assert.ok(labels.includes('Fire Resistance'), 'resistances always show (condFunc returns true)');
  const life = m.rows.find((r) => r.label === 'Total Life')!;
  assert.equal(life.value, out.Life);
  assert.equal(life.group, 'pools');
  assert.equal(m.rows.find((r) => r.label === 'Strength')!.group, 'attr');
  assert.equal(m.rows.find((r) => r.label === 'Fire Resistance')!.group, 'res');
  // ChaosInoculation: upstream shows "Chaos Resistance" with the (Immune) suffix.
  const chaos = m.rows.find((r) => r.label === 'Chaos Resistance')!;
  assert.equal(chaos.suffix, 'Immune');
  // Order follows upstream's list: Strength before Life.
  assert.ok(labels.indexOf('Strength') < labels.indexOf('Total Life'));
});

test('Full DPS 0 is hidden and a non-zero Full DPS is shown, like the original', () => {
  const base = normaliseOutput({ ...fixture, FullDPS: 0, SkillDPS: {} });
  assert.ok(!buildSidebar(base, new Set(), F).rows.some((r) => r.label === 'Full DPS'));
  const on = normaliseOutput({ ...fixture, FullDPS: 3123221 });
  const row = buildSidebar(on, new Set(), F).rows.find((r) => r.label === 'Full DPS')!;
  assert.equal(row.text, '3,123,221');
  assert.equal(row.group, 'off');
});

test('flags decide which rows show', () => {
  const out = normaliseOutput({ ...fixture, Speed: 1.78, TriggerTime: undefined });
  const attack = buildSidebar(out, new Set(['attack']), F).rows.map((r) => r.label);
  const spell = buildSidebar(out, new Set(['spell']), F).rows.map((r) => r.label);
  assert.ok(attack.includes('Attack Rate') && !attack.includes('Cast Rate'));
  assert.ok(spell.includes('Cast Rate') && !spell.includes('Attack Rate'));
});

test('warnings: unreserved life, cap, requirements', () => {
  const out = normaliseOutput({ ...fixture, LifeUnreserved: 0, Str: 10, ReqStr: 50, BleedDPS: 40_000_000 });
  const m = buildSidebar(out, new Set(), F);
  assert.ok(m.warnings.includes('Your unreserved Life is below 1'));
  assert.ok(m.warnings.includes('Bleed DPS exceeds in game limit'));
  assert.ok(m.warnings.some((w) => w.startsWith('You do not meet the Strength requirement of ')));
  assert.equal(m.rows.find((r) => r.label === 'Unreserved Life')!.negative, true);
});

test('compareLines prints the original’s node tooltip lines', async () => {
  const { compareLines } = await import('../src/renderer/displayStats.js');
  const base = normaliseOutput({ ...fixture, Life: 4639, TotalEHP: 19055 });
  const after = normaliseOutput({ ...fixture, Life: 4867, TotalEHP: 19990 });
  const lines = compareLines(base, after, new Set(), F);
  const life = lines.find((l) => l.label === 'Total Life')!;
  assert.equal(life.value, '+228');
  assert.equal(life.percent, ' (+4.9%)');
  assert.equal(life.good, true);
  assert.equal(lines.find((l) => l.label === 'Effective Hit Pool')!.value, '+935');
  const worse = compareLines(after, base, new Set(), F).find((l) => l.label === 'Total Life')!;
  assert.equal(worse.value, '-228');
  assert.equal(worse.good, false);
});

test('an infinite max hit shows inf with the Immune suffix', () => {
  const out = normaliseOutput({ ...fixture, ChaosMaximumHitTaken: 'Inf' });
  const row = buildSidebar(out, new Set(), F).rows.find((r) => r.label === 'Chaos Max Hit')!;
  assert.equal(row.suffix, 'Immune');
  assert.equal(row.text, 'inf');
});

test('sFormat rounds like C printf: by the exact binary value, ties to even only when it is an exact tie', () => {
  // -1 / 20 is -0.05 in binary, a hair above the tie, so printf("%+.1f") gives -0.1 (upstream's per-point value)
  assert.equal(sFormat('+.1f', -1 / 20), '-0.1');
  assert.equal(sFormat('+.1f', 0.05), '+0.1');
  // exact ties go to the even digit
  assert.equal(sFormat('.1f', 0.25), '0.2');
  assert.equal(sFormat('.1f', 0.75), '0.8');
  assert.equal(sFormat('.2f', 0.125), '0.12');
});
