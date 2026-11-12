import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickerView, rankRows, scoreGems, type GemScores } from '../src/shared/gemRanking.js';

const row = (name: string) => ({ id: 'G/' + name, name });
const ROWS = ['Zeal', 'Melee Physical', 'Brutality', 'Arc', 'Ruthless', 'Added Fire'].map(row);
const S: GemScores = {
  'G/Melee Physical': 40,
  'G/Brutality': 40,
  'G/Ruthless': 12.5,
  'G/Added Fire': -3,
  'G/Arc': null,
};
const names = (l: { name: string }[]) => l.map((r) => r.name);

test('ranked rows: best figure first, ties by name, then the gems without a figure by name', () => {
  const r = rankRows(ROWS, S);
  assert.deepEqual(names(r.rows), ['Brutality', 'Melee Physical', 'Ruthless', 'Added Fire', 'Arc', 'Zeal']);
  assert.equal(r.ranked, 4);
});

test('the list is held until the first pass for the group finishes', () => {
  const v = pickerView(ROWS, {
    sort: true,
    pass: undefined,
    version: 3,
    limit: 40,
  });
  assert.equal(v.held, true);
  assert.deepEqual(v.rows, []);
});

test('after adding a gem the last finished order stays, marked stale, until the new pass swaps in', () => {
  const old = { version: 3, scores: S };
  const during = pickerView(ROWS, {
    sort: true,
    pass: old,
    version: 4,
    limit: 40,
  });
  assert.equal(during.held, false);
  assert.equal(during.stale, true);
  assert.deepEqual(names(during.rows), ['Brutality', 'Melee Physical', 'Ruthless', 'Added Fire', 'Arc', 'Zeal']);
  const fresh = pickerView(ROWS, {
    sort: true,
    pass: { version: 4, scores: { ...S, 'G/Zeal': 90 } },
    version: 4,
    limit: 40,
  });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.rows[0]!.name, 'Zeal');
});

test('the row cap applies after ranking, so the top rows are the best of every gem', () => {
  const v = pickerView(ROWS, {
    sort: true,
    pass: { version: 1, scores: S },
    version: 1,
    limit: 2,
  });
  assert.deepEqual(names(v.rows), ['Brutality', 'Melee Physical']);
  assert.equal(v.ranked, 2);
});

test('with sorting off the search order is kept', () => {
  const v = pickerView(ROWS, {
    sort: false,
    pass: { version: 1, scores: S },
    version: 1,
    limit: 40,
  });
  assert.deepEqual(v.rows, ROWS);
  assert.equal(v.ranked, 0);
});

test('scoring covers every id in chunks, resumes a stopped pass, and scores a failed chunk null', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => 'g' + i);
  const asked: string[][] = [];
  const out: GemScores = {};
  let live = true;
  const ask = async (c: string[]) => {
    asked.push(c);
    if (asked.length === 1) live = false;
    if (c.includes('g4')) throw new Error('engine busy');
    return Object.fromEntries(c.map((id) => [id, Number(id.slice(1))]));
  };
  assert.equal(
    await scoreGems(
      ids,
      ask,
      out,
      () => live,
      () => {},
      3,
    ),
    false,
  );
  assert.deepEqual(Object.keys(out), ['g0', 'g1', 'g2']);
  live = true;
  const seen: number[] = [];
  assert.equal(
    await scoreGems(
      ids,
      ask,
      out,
      () => live,
      (n) => seen.push(n),
      3,
    ),
    true,
  );
  assert.deepEqual(asked.slice(1), [['g3', 'g4', 'g5'], ['g6', 'g7', 'g8'], ['g9']]);
  assert.equal(out.g4, null);
  assert.equal(out.g9, 9);
  assert.deepEqual(seen, [3, 6, 9, 10]);
});

// The Skills tab once collapsed its socket group list when New was pressed, and under 1180px the list was a drawer that
// covered the editor. The list now stays on screen: no code closes it, and the narrow layout is a strip above the editor.
test('New and choosing a group never hide the list of socket groups', () => {
  const root = join(import.meta.dirname, '..', '..');
  const tab = readFileSync(join(root, 'src/renderer/SkillsTab.tsx'), 'utf8');
  const css = readFileSync(join(root, 'src/renderer/design/responsive.css'), 'utf8');
  assert.ok(!/setOpen\(/.test(tab), 'SkillsTab closes the group list');
  assert.ok(!/sk-groups"\]\[data-open/.test(css), 'the narrow group list is still a drawer');
  assert.ok(!/sk-groups"\][^}]*height:\s*56px/.test(css), 'the narrow group list still collapses to its header');
});

// Adding to a group with an active skill: supports form one ranked block, actives that raise DPS get their own ranked
// section below it, and gems already in the group sit last, marked, instead of being offered among the best.
const gem = (name: string, support: boolean) => ({ id: 'G/' + name, name, support });
const MIX = [gem('Momentum', true), gem('Summon Ice Golem', false), gem('Impale', true), gem('Phase Run', false), gem('Arc', false), gem('Brutality', true), gem('Zeal', true)];
const MS: GemScores = { 'G/Momentum': 40, 'G/Summon Ice Golem': 38, 'G/Impale': 34, 'G/Phase Run': 28, 'G/Arc': null, 'G/Brutality': 20, 'G/Zeal': null };
const mixPass = { version: 1, scores: MS };

test('adding to a skill: supports ranked first, then actives that raise DPS in their own ranked section', () => {
  const v = pickerView(MIX, { sort: true, pass: mixPass, version: 1, limit: 40, sections: true });
  assert.deepEqual(names(v.rows), ['Momentum', 'Impale', 'Brutality', 'Summon Ice Golem', 'Phase Run', 'Arc', 'Zeal']);
  assert.equal(v.actives, 3);
  assert.equal(v.ranked, 5);
  assert.equal(v.inGroup, -1);
});

test('without sections the actives stay mixed in by figure, as before', () => {
  const v = pickerView(MIX, { sort: true, pass: mixPass, version: 1, limit: 40 });
  assert.deepEqual(names(v.rows).slice(0, 3), ['Momentum', 'Summon Ice Golem', 'Impale']);
  assert.equal(v.actives, -1);
});

test('an active with no gain goes under No DPS change, not into the section that says it raises DPS', () => {
  const v = pickerView(MIX, { sort: true, pass: { version: 1, scores: { ...MS, 'G/Phase Run': 0 } }, version: 1, limit: 40, sections: true });
  assert.deepEqual(names(v.rows).slice(3), ['Summon Ice Golem', 'Arc', 'Phase Run', 'Zeal']);
  assert.equal(v.ranked, 4);
});

test('gems already in the group go last, after the gems with no figure', () => {
  const inGroup = new Set(['G/Momentum', 'G/Arc']);
  const v = pickerView(MIX, { sort: true, pass: mixPass, version: 1, limit: 40, sections: true, inGroup });
  assert.deepEqual(names(v.rows), ['Impale', 'Brutality', 'Summon Ice Golem', 'Phase Run', 'Zeal', 'Momentum', 'Arc']);
  assert.equal(v.actives, 2);
  assert.equal(v.ranked, 4);
  assert.equal(v.inGroup, 5);
  const off = pickerView(MIX, { sort: false, pass: mixPass, version: 1, limit: 40, inGroup });
  assert.deepEqual(names(off.rows).slice(-2), ['Momentum', 'Arc']);
  assert.equal(off.inGroup, 5);
});

test('the S filter leaves only supports, so no actives section; the cap clips section indexes', () => {
  const v = pickerView(MIX.filter((g) => g.support), { sort: true, pass: mixPass, version: 1, limit: 40, sections: true });
  assert.equal(v.actives, -1);
  const a = pickerView(MIX.filter((g) => !g.support), { sort: true, pass: mixPass, version: 1, limit: 40, sections: true });
  assert.equal(a.actives, 0);
  assert.deepEqual(names(a.rows), ['Summon Ice Golem', 'Phase Run', 'Arc']);
  const c = pickerView(MIX, { sort: false, pass: mixPass, version: 1, limit: 2, inGroup: new Set(['G/Zeal']) });
  assert.deepEqual(names(c.rows), ['Momentum', 'Summon Ice Golem']);
  assert.equal(c.inGroup, -1);
});

test('with sections the cap applies to each section, so the actives section is reached past a long support block', () => {
  const v = pickerView(MIX, { sort: true, pass: mixPass, version: 1, limit: 2, sections: true, inGroup: new Set(['G/Zeal']) });
  assert.deepEqual(names(v.rows), ['Momentum', 'Impale', 'Summon Ice Golem', 'Phase Run', 'Arc', 'Zeal']);
  assert.equal(v.actives, 2);
  assert.equal(v.ranked, 4);
  assert.equal(v.inGroup, 5);
});

test('with sections a support that changes nothing (0%) goes under No DPS change; one that lowers DPS stays ranked, last', () => {
  const v = pickerView(MIX, { sort: true, pass: { version: 1, scores: { ...MS, 'G/Brutality': 0, 'G/Zeal': -2 } }, version: 1, limit: 40, sections: true });
  assert.deepEqual(names(v.rows), ['Momentum', 'Impale', 'Zeal', 'Summon Ice Golem', 'Phase Run', 'Arc', 'Brutality']);
  assert.equal(v.actives, 3);
  assert.equal(v.ranked, 5);
});

test('a typed exact gem name is the first row even when another match scores higher', () => {
  const rows = ['Vaal Haste', 'Haste', 'Hastened'].map(row);
  const pass = { version: 1, scores: { 'G/Vaal Haste': 30, 'G/Haste': 5, 'G/Hastened': 10 } as GemScores };
  const v = pickerView(rows, { sort: true, pass, version: 1, limit: 40, exact: 'haste' });
  assert.deepEqual(names(v.rows), ['Haste', 'Vaal Haste', 'Hastened']);
  assert.equal(v.ranked, 3);
});

test('an exact match with no figure is pinned on top, outside the DPS sections', () => {
  const rows = ['Vaal Haste', 'Haste'].map(row);
  const pass = { version: 1, scores: { 'G/Vaal Haste': 30, 'G/Haste': null } as GemScores };
  const v = pickerView(rows, { sort: true, pass, version: 1, limit: 40, exact: 'Haste' });
  assert.deepEqual(names(v.rows), ['Haste', 'Vaal Haste']);
  assert.equal(v.pinned, true);
  assert.equal(pickerView(rows, { sort: true, pass, version: 1, limit: 40, exact: 'Vaal Haste' }).pinned, false);
});
