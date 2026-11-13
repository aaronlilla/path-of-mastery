// itemLegality: crafted-mod limits, bench crafts the base cannot take, the affix limits and influence, on a fake mod pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemLegality } from '../src/main/assistant/legality.js';

const mod = (text: string, group: string, source = 'normal', extra: Record<string, unknown> = {}) => ({ group, source, tier: 1, level: 1, stats: [{ text }], ...extra });
const hyb = (texts: string[], group: string, source = 'bench') => ({ group, source, tier: 1, level: 1, stats: texts.map((text) => ({ text })) });
const line = (text: string, o: Record<string, unknown> = {}) => ({ bucket: 'explicit', text, crafted: false, custom: false, mutated: false, prefix: false, suffix: false, ...o });

const POOL = {
  prefixLimit: 3,
  suffixLimit: 3,
  prefixes: [
    mod('+(80-99) to maximum Life', 'IncreasedLife'),
    mod('+(80-99) to maximum Life', 'IncreasedLife', 'bench'),
    mod('(50-60)% increased Armour and Evasion', 'LocalArmourAndEvasion', 'bench'),
    mod('(50-60)% increased Energy Shield', 'LocalEnergyShieldPercent'),
    mod('(50-60)% increased Energy Shield', 'LocalEnergyShieldPercent', 'bench'),
    mod('+(30-40) to maximum Mana', 'IncreasedMana'),
    mod('+(20-30) to Armour', 'IncreasedArmour'),
    hyb(['(30-40)% increased Energy Shield', '+(20-30) to maximum Life'], 'LocalEnergyShieldAndLife', 'normal'),
  ],
  suffixes: [
    mod('+(20-30)% to Cold Resistance', 'ColdResistance'),
    mod('+(20-30)% to Fire Resistance', 'FireResistance'),
    mod('+(20-30)% to Chaos Resistance', 'ChaosResistance'),
    mod('+(20-30) to Strength', 'Strength', 'bench'),
    mod('Can have up to 3 Crafted Modifiers', 'ItemGenerationCanHaveMultipleCraftedMods', 'bench'),
    mod('Socketed Gems are supported by Level 20 Blind', 'BlindSupported', 'influence', { influence: 'shaper' }),
  ],
};

function ctx(info: Record<string, unknown>, mods: unknown[], poolFor?: (influences: string[]) => unknown) {
  return {
    engine: {
      async send(cmd: string, p: { influences?: string[] }) {
        if (cmd === 'itemInfo') return { item: { valid: true, baseName: 'Warlock Gloves', name: 'Doom Grip', rarity: 'RARE', itemLevel: 84, canInfluence: true, influences: [], defences: { EnergyShieldBase: 83, ArmourBase: 0, EvasionBase: 0 }, ...info, mods } };
        if (cmd === 'modPool') return { pool: poolFor ? poolFor(p.influences ?? []) : { ...POOL, suffixes: POOL.suffixes.filter((m) => m.source !== 'influence' || (p.influences ?? []).includes('shaper')) } };
        throw new Error(`unexpected ${cmd}`);
      },
    },
  } as never;
}

const kinds = async (c: never) => (await itemLegality(c, 'Gloves', 'x')).map((i) => i.kind);

test('a crafted Armour and Evasion line on an energy shield base is refused (run A gloves)', async () => {
  const out = await itemLegality(ctx({}, [line('+90 to maximum Life'), line('58% increased Armour and Evasion', { crafted: true })]), 'Gloves', 'x');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'notOnBase');
  assert.match(out[0]!.text, /no Armour or Evasion/);
});

test('the same craft is fine on a base that has the defence', async () => {
  assert.deepEqual(await kinds(ctx({ defences: { ArmourBase: 100, EvasionBase: 100, EnergyShieldBase: 0 } }, [line('58% increased Armour and Evasion', { crafted: true })])), []);
});

test('two bench crafts need the multimod; three are the limit with it', async () => {
  const two = [line('+25 to Strength', { crafted: true }), line('58% increased Energy Shield', { crafted: true })];
  assert.deepEqual(await kinds(ctx({}, two)), ['craftLimit']);
  const multi = [line('Can have up to 3 Crafted Modifiers', { crafted: true }), ...two];
  assert.deepEqual(await kinds(ctx({}, multi)), []);
  assert.deepEqual(await kinds(ctx({}, [...multi, line('+90 to maximum Life', { crafted: true })])), ['craftLimit']);
});

test('a hybrid prints two lines for one modifier and does not count as the same group as a rolled line', async () => {
  const mods = [line('+90 to maximum Life'), line('35% increased Energy Shield'), line('+25 to maximum Life')];
  // the hybrid takes the ES line and one life line; the other life line is the plain life roll
  assert.deepEqual(await kinds(ctx({}, mods)), []);
  // two plain life lines are one group twice
  assert.deepEqual(await kinds(ctx({}, [line('+90 to maximum Life'), line('+85 to maximum Life')])), ['sameGroup']);
});

test('an influence mod without the influence names the influence it needs', async () => {
  const out = await itemLegality(ctx({}, [line('Socketed Gems are supported by Level 20 Blind')]), 'Gloves', 'x');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'influence');
  assert.match(out[0]!.text, /shaper/);
  assert.deepEqual(await kinds(ctx({ influences: ['shaper'] }, [line('Socketed Gems are supported by Level 20 Blind')])), []);
});

test('more than three prefixes, a base that cannot be influenced and a mod the base never rolls', async () => {
  const four = [line('+90 to maximum Life'), line('+35 to maximum Mana'), line('+25 to Armour'), line('55% increased Armour and Evasion')];
  assert.deepEqual(await kinds(ctx({}, four)), ['affixLimit']);
  assert.deepEqual(await kinds(ctx({ canInfluence: false, influences: ['shaper'] }, [])), ['influence']);
  assert.deepEqual(await kinds(ctx({}, [line('+20% to Lightning Resistance')])), ['notOnBase']);
});

test('uniques and an engine that cannot read the item get no verdict', async () => {
  assert.deepEqual(await kinds(ctx({ rarity: 'UNIQUE' }, [line('+20% to Lightning Resistance')])), []);
  assert.deepEqual(await itemLegality({ engine: { send: async () => { throw new Error('no'); } } } as never, 'Gloves', 'x'), []);
});
