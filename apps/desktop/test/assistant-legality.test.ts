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

function ctx(info: Record<string, unknown>, mods: unknown[], poolFor?: (influences: string[]) => unknown, beast: string[] = [], baseImplicits: string[] = []) {
  return {
    engine: {
      async send(cmd: string, p: { influences?: string[] }) {
        if (cmd === 'itemInfo') return { item: { valid: true, baseName: 'Warlock Gloves', name: 'Doom Grip', rarity: 'RARE', itemLevel: 84, canInfluence: true, influences: [], defences: { EnergyShieldBase: 83, ArmourBase: 0, EvasionBase: 0 }, ...info, mods } };
        if (cmd === 'modPool') return { pool: poolFor ? poolFor(p.influences ?? []) : { ...POOL, suffixes: POOL.suffixes.filter((m) => m.source !== 'influence' || (p.influences ?? []).includes('shaper')) } };
        if (cmd === 'itemCraft') return { text: `Rarity: NORMAL\nWarlock Gloves\nImplicits: ${baseImplicits.length}\n${baseImplicits.join('\n')}\n` };
        if (cmd === 'itemPool' && beast.length) return { pool: { sources: [{ id: 'BEASTCRAFT', mods: beast.map((t) => ({ lines: [t], type: 'Suffix' })) }] } };
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

const VEILED_HYBRID = hyb(['+(25-28) to Dexterity and Intelligence', '(12-15)% increased Attack Speed'], 'LocalAttackSpeedDexInt', 'veiled');
const veiledPool = () => ({ ...POOL, suffixes: [...POOL.suffixes, VEILED_HYBRID] });

test('a veiled hybrid printed as two plain lines is one suffix, not two (Fate Rain bow, pconc boots)', async () => {
  const lines = [line('+25% to Cold Resistance'), line('+25% to Fire Resistance'), line('+27 to Dexterity and Intelligence'), line('15% increased Attack Speed')];
  assert.deepEqual(await kinds(ctx({}, lines, veiledPool)), []);
  // a fourth suffix beside the hybrid is still over the limit
  assert.deepEqual(await kinds(ctx({}, [...lines, line('+25% to Chaos Resistance')], veiledPool)), ['affixLimit']);
});

test('"+1 Suffix Modifier allowed" on the base moves the limits (Cogwork Ring)', async () => {
  const four = ['Cold', 'Fire', 'Chaos'].map((r) => line(`+25% to ${r} Resistance`)).concat(line('+25 to Strength'));
  const implicits = [line('-1 Prefix Modifier allowed', { bucket: 'implicit' }), line('+1 Suffix Modifier allowed', { bucket: 'implicit' })];
  assert.deepEqual(await kinds(ctx({}, four)), ['affixLimit']);
  const own = ['-1 Prefix Modifier allowed', '+1 Suffix Modifier allowed'];
  assert.deepEqual(await kinds(ctx({}, [...implicits, ...four], undefined, [], own)), []);
  // the same base holds only two prefixes now
  const prefixes = [line('+90 to maximum Life'), line('+35 to maximum Mana'), line('+25 to Armour')];
  assert.deepEqual(await kinds(ctx({}, [...implicits, ...prefixes], undefined, [], own)), ['affixLimit']);
});

test('an "allowed" line the base does not carry moves nothing (forged or custom line on a Steel Ring)', async () => {
  const four = ['Cold', 'Fire', 'Chaos'].map((r) => line(`+25% to ${r} Resistance`)).concat(line('+25 to Strength'));
  assert.deepEqual(await kinds(ctx({}, [line('+1 Suffix Modifier allowed', { bucket: 'implicit' }), ...four])), ['affixLimit']);
  assert.deepEqual(await kinds(ctx({}, [line('+1 Suffix Modifier allowed', { bucket: 'implicit', custom: true }), ...four])), ['affixLimit']);
});

// a veiled life + energy shield hybrid, and a pool without the unveiled one, so only the veiled rule decides
const VEILED_LIFE_ES = hyb(['+(20-30) to maximum Life', '(50-60)% increased Energy Shield'], 'LocalEnergyShieldAndLife', 'veiled');
const veiledPrefixPool = () => ({ ...POOL, prefixes: [...POOL.prefixes.filter((m) => m.stats.length === 1), VEILED_LIFE_ES] });

test('plain lines outside a veiled hybrid range are separate modifiers, not its two lines', async () => {
  const more = [line('+35 to maximum Mana'), line('+25 to Armour')];
  // +25 life and 55% energy shield are the veiled roll: one prefix, three in all
  assert.deepEqual(await kinds(ctx({}, [line('+25 to maximum Life'), line('55% increased Energy Shield'), ...more], veiledPrefixPool)), []);
  // +90 life and 35% energy shield are out of range: two prefixes, four in all
  assert.deepEqual(await kinds(ctx({}, [line('+90 to maximum Life'), line('35% increased Energy Shield'), ...more], veiledPrefixPool)), ['affixLimit']);
});

test('a plain line and a crafted line do not make one veiled hybrid; the craft still counts', async () => {
  const mods = [line('+25 to maximum Life'), line('58% increased Energy Shield', { crafted: true }), line('+25 to Strength', { crafted: true })];
  assert.deepEqual(await kinds(ctx({}, mods, veiledPrefixPool)), ['craftLimit']);
});

test('a beastcraft line is a suffix the base can carry, and takes a suffix slot', async () => {
  const cat = 'Grants Level 20 Aspect of the Cat Skill';
  assert.deepEqual(await kinds(ctx({}, [line(cat)], undefined, [cat])), []);
  // without the beastcraft list the line is a mod the base never rolls
  assert.deepEqual(await kinds(ctx({}, [line(cat)])), ['notOnBase']);
  const three = ['Cold', 'Fire', 'Chaos'].map((r) => line(`+25% to ${r} Resistance`));
  assert.deepEqual(await kinds(ctx({}, [line(cat), ...three], undefined, [cat])), ['affixLimit']);
});
