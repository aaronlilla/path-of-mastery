// priceBill on a fake engine and a fake trade site: an item that cannot exist is refused and never searched; a legal rare is
// searched on the mods whose removal costs the build, priced from live listings; without a session the pack range stands in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minFor, oneFilterPerStat, priceBill, searchText } from '../src/main/assistant/slotBill.js';

const xmlOf = (items: Record<string, string>) =>
  `<PathOfBuilding><Items activeItemSet="1">${Object.values(items).map((t, i) => `<Item id="${i + 1}">${t}</Item>`).join('')}<ItemSet id="1">${Object.keys(items).map((s, i) => `<Slot name="${s}" itemId="${i + 1}"/>`).join('')}</ItemSet></Items></PathOfBuilding>`;

const GLOVES = 'Rarity: RARE\nDoom Grip\nWarlock Gloves\nItem Level: 84\nImplicits: 0\n+115 to maximum Life\n58% increased Armour and Evasion';
const RING = 'Rarity: RARE\nDoom Coil\nTwo-Stone Ring\nItem Level: 84\nImplicits: 0\n+100 to maximum Life\n+30% to Cold Resistance';

const life = (text: string, o: Record<string, unknown> = {}) => ({ bucket: 'explicit', text, crafted: false, custom: false, mutated: false, prefix: false, suffix: false, ...o });
const POOL = {
  prefixLimit: 3,
  suffixLimit: 3,
  prefixes: [{ group: 'LocalArmourAndEvasion', source: 'bench', tier: 1, level: 1, stats: [{ text: '(50-60)% increased Armour and Evasion' }] }, { group: 'IncreasedLife', source: 'normal', tier: 1, level: 1, stats: [{ text: '+(90-99) to maximum Life' }] }, { group: 'IncreasedLife', source: 'bench', tier: 1, level: 1, stats: [{ text: '+(40-50) to maximum Life', values: [{ min: 40, max: 50 }] }] }],
  suffixes: [{ group: 'FireResistance', source: 'normal', tier: 1, level: 1, stats: [{ text: '+(25-35)% to Fire Resistance' }] }, { group: 'ColdResistance', source: 'normal', tier: 1, level: 1, stats: [{ text: '+(25-35)% to Cold Resistance' }] }, { group: 'ColdResistance', source: 'essence', essence: 'Deafening Essence of Frost', tier: 1, level: 1, stats: [{ text: '+(25-35)% to Cold Resistance' }] }],
};

function ctx(trade?: unknown, calls: string[] = []) {
  return {
    calls,
    engine: {
      async send(cmd: string, p: { itemText?: string; edits?: unknown[] }) {
        if (cmd === 'itemInfo') {
          const gloves = p.itemText!.includes('Warlock');
          return { item: { valid: true, baseName: gloves ? 'Warlock Gloves' : 'Two-Stone Ring', name: gloves ? 'Doom Grip' : 'Doom Coil', rarity: 'RARE', itemLevel: 84, canInfluence: true, influences: [], defences: gloves ? { EnergyShieldBase: 83, ArmourBase: 0, EvasionBase: 0 } : null, mods: gloves ? [{ ...life('+115 to maximum Life'), rawLine: 5 }, { ...life('58% increased Armour and Evasion', { crafted: true }), rawLine: 6 }] : p.itemText!.split('\n').slice(5).map((t, i) => ({ ...life(t), rawLine: 5 + i })) } };
        }
        if (cmd === 'modPool') return { pool: POOL };
        if (cmd === 'loadBuild') return { buildId: 'b1' };
        if (cmd === 'closeBuild') return {};
        if (cmd === 'getStats') return { stats: [{ id: 'FullDPS', value: 1000 }, { id: 'TotalEHP', value: 50000 }] };
        // taking any rolled line off costs 20% of effective HP
        if (cmd === 'previewEdits') return { results: (p.edits as unknown[]).map(() => ({ statDiff: { changed: [{ statId: 'TotalEHP', before: 50000, after: 40000 }] } })) };
        throw new Error(`unexpected ${cmd}`);
      },
    },
    trade,
    prices: { lookup: async () => ({ source: 'poe.ninja', fetchedAt: 1, chaosPerDivine: 200, lines: [[{ name: 'Deafening Essence of Frost', chaos: 12, type: 'Essence' }]] }) },
  } as never;
}

const listings = (...divine: number[]) => divine.map((d) => ({ name: 'x', base: 'x', rarity: 'Rare', ilvl: 84, mods: [], asked: `${d} divine`, chaos: d * 200, divine: d, ageMinutes: 30, online: true }));

test('minFor: 90% of the roll, small numbers exact, none without a plain number', () => {
  assert.equal(minFor('+115 to maximum Life'), 103);
  assert.equal(minFor('+1 to Level of all Skill Gems'), 1);
  assert.equal(minFor('Regenerate 4.8 Mana per second'), undefined);
  assert.equal(minFor('Socketed Gems are supported by Level 20 Blind'), undefined);
});

test('an item that cannot exist is refused and never searched', async () => {
  const searched: unknown[] = [];
  const trade = { search: async (q: unknown) => (searched.push(q), { ok: true, total: 1, at: 1, cached: false, chaosPerDivine: 200, listings: listings(1), unmatchedMods: [], link: 'l' }) };
  const bill = await priceBill(ctx(trade), xmlOf({ Gloves: GLOVES }));
  assert.equal(bill.slots[0]!.legal, false);
  assert.equal(bill.slots[0]!.price.status, 'refused');
  assert.match(bill.slots[0]!.issues[0]!, /no Armour or Evasion/);
  assert.equal(searched.length, 0);
  assert.equal(bill.divines, null);
});

test('a legal rare is searched on the mod the build needs, priced from live listings, with an essence recipe', async () => {
  let q: { category?: string; type?: string; mods: Array<{ text: string; min?: number }> } | undefined;
  const trade = { search: async (x: typeof q) => ((q = x), { ok: true, total: 14, at: 5, cached: false, chaosPerDivine: 200, listings: listings(3, 4, 5), unmatchedMods: [], link: 'https://trade/x' }) };
  const bill = await priceBill(ctx(trade), xmlOf({ 'Ring 1': RING }));
  const s = bill.slots[0]!;
  assert.equal(s.legal, true);
  assert.deepEqual(q, { category: 'accessory.ring', mods: [{ text: '+100 to maximum Life', min: 90 }, { text: '+30% to Cold Resistance', min: 27 }], limit: 8 });
  assert.deepEqual(s.mustHave.map((m) => m.text), ['+100 to maximum Life', '+30% to Cold Resistance']);
  assert.equal(s.price.status, 'live');
  assert.equal((s.price as { divines: number }).divines, 4);
  assert.deepEqual(bill.divines, 4);
  assert.equal(s.recipes.filter((r) => r.kind === 'bench').length, 0, 'the bench reaches +50 life at most: below the 90 asked');
  assert.deepEqual(s.recipes.map((r) => [r.kind, r.chaos, r.cheaper]), [['essence', 12, true]]);
});

test('without a session the pack range stands in, with its date; without a pack the slot says it has no price', async () => {
  const none = { search: async () => ({ ok: false, kind: 'no-cookie', message: 'no cookie' }) };
  const noPack = await priceBill(ctx(none), xmlOf({ 'Ring 1': RING }));
  assert.equal(noPack.slots[0]!.price.status, 'no-session');
  assert.equal(noPack.divines, null);
  const withPack = await priceBill(ctx(none), xmlOf({ 'Ring 1': RING }), { pack: () => ({ lowDivines: 2, highDivines: 6, date: '2026-11-01' }) });
  assert.deepEqual(withPack.slots[0]!.price, { status: 'range', lowDivines: 2, highDivines: 6, date: '2026-11-01' });
  assert.equal(withPack.divines, 4);
  assert.equal((await priceBill(ctx(undefined), xmlOf({ 'Ring 1': RING }))).slots[0]!.price.status, 'no-session');
});

test('nothing lists all the mods: the one the build misses least is left out, and the bill says so', async () => {
  const asked: number[] = [];
  const trade = { search: async (q: { mods: unknown[] }) => (asked.push(q.mods.length), { ok: true, total: q.mods.length > 2 ? 0 : 9, at: 1, cached: false, chaosPerDivine: 200, listings: q.mods.length > 2 ? [] : listings(2, 2.5), unmatchedMods: [], link: 'l' }) };
  const ring3 = `${RING}
+30% to Fire Resistance`;
  const s = (await priceBill(ctx(trade), xmlOf({ 'Ring 1': ring3 }))).slots[0]!;
  assert.deepEqual(asked, [3, 2]);
  assert.equal(s.price.status, 'live');
  assert.deepEqual((s.price as { dropped: string[] }).dropped, ['+30% to Fire Resistance']);
});

test('searchText: the (Local) stat for a local defence line on armour, the plain one for a ring', () => {
  assert.equal(searchText('+89 to maximum Energy Shield', true, false), '+89 to maximum Energy Shield (Local)');
  assert.equal(searchText('+89 to maximum Energy Shield', false, false), '+89 to maximum Energy Shield');
  assert.equal(searchText('90% increased Evasion and Energy Shield', true, false), '90% increased Evasion and Energy Shield (Local)');
  assert.equal(searchText('+130 to maximum Life', true, false), '+130 to maximum Life');
});

test('two lines of one stat are one filter at the larger minimum', () => {
  assert.deepEqual(oneFilterPerStat([{ text: '90% increased Evasion and Energy Shield', min: 81 }, { text: '+71 to maximum Energy Shield', min: 63 }, { text: '38% increased Evasion and Energy Shield', min: 34 }]), [{ text: '90% increased Evasion and Energy Shield', min: 81 }, { text: '+71 to maximum Energy Shield', min: 63 }]);
});
