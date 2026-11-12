// itemFit bench crafts keep lab enchants, header lines stay under Rarity, magic items
// take one suffix, crafted mods hold an affix slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchCraftRows, benchSuffixes, betterItem, openSuffixes, setHeader } from '../src/main/assistant/itemFit.js';

const mod = (text: string, group = text) => ({ group, tier: 1, level: 1, source: 'normal', stats: [{ text }] });
const bench = (text: string) => ({ group: 'bench', tier: 1, level: 1, source: 'bench', stats: [{ text }] });
const pool = {
  prefixLimit: 3,
  suffixLimit: 3,
  prefixes: [mod('+# to maximum Life')],
  suffixes: [mod('+#% to Cold Resistance'), mod('+#% to Fire Resistance'), bench('+# to Dexterity')],
};

function fakeCtx(info: Record<string, unknown>, seen: string[] = []) {
  return {
    engine: {
      async send(cmd: string, p: any) {
        if (cmd === 'itemInfo') { seen.push(p.itemText); return { item: { valid: true, baseName: 'Iron Hat', itemLevel: 84, ...info } }; }
        if (cmd === 'modPool') return { pool };
        throw new Error(`unexpected ${cmd}`);
      },
    },
  } as never;
}

const HELM = 'Rarity: RARE\nDoom Crown\nIron Hat\nImplicits: 1\n{crafted}40% increased Cyclone Damage\n+93 to maximum Life\n+40% to Cold Resistance';

test('benchSuffixes keeps a {crafted} lab enchant inside the Implicits block and strips only the bench craft', async () => {
  assert.deepEqual(benchCraftRows(HELM), []);
  const withCraft = `${HELM}\n{crafted}+25 to Dexterity`;
  assert.deepEqual(benchCraftRows(withCraft), [7]);
  const seen: string[] = [];
  const out = await benchSuffixes(fakeCtx({ rarity: 'RARE', mods: [{ bucket: 'explicit', text: '+40% to Cold Resistance' }] }, seen), 'Helmet', withCraft, /Dexterity/);
  assert.equal(seen[0], HELM, 'the enchant stays, the Implicits count is untouched');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.edit.itemText, `${HELM}\n{crafted}+# to Dexterity`);
  assert.equal(out[0]!.replaced, '+25 to Dexterity');
});

test('a magic item with its one suffix takes no bench craft', async () => {
  const mods = [{ bucket: 'explicit', text: '+40% to Cold Resistance' }];
  assert.equal(openSuffixes(pool, mods), 2);
  assert.equal(openSuffixes(pool, mods, 'MAGIC'), 0);
  assert.equal(openSuffixes(pool, [], 'MAGIC'), 1);
  const out = await benchSuffixes(fakeCtx({ rarity: 'MAGIC', mods }), 'Helmet', 'Rarity: MAGIC\nSturdy Iron Hat of the Penguin\nImplicits: 0\n+40% to Cold Resistance', /Dexterity/);
  assert.deepEqual(out, []);
});

test('betterItem counts a crafted mod as holding an affix slot', async () => {
  const mods = [
    { bucket: 'explicit', text: '+90 to maximum Life' }, { bucket: 'explicit', text: '+90 to maximum Life' }, { bucket: 'explicit', text: '+90 to maximum Life' },
    { bucket: 'explicit', text: '+40% to Cold Resistance' }, { bucket: 'explicit', text: '+40% to Fire Resistance' },
    { bucket: 'explicit', text: '+25 to Dexterity', crafted: true },
  ];
  const ctx = { engine: { async send(cmd: string) { if (cmd === 'modPool') return { pool }; return { statDiff: { changed: [{ statId: 'X', after: 100 }] } }; } } } as never;
  const kept = { text: 'Rarity: RARE\nA\nB', lines: [], lost: [], created: true, info: { baseName: 'Iron Hat', itemLevel: 84, mods }, oldName: null } as never;
  assert.equal(await betterItem(ctx, 'b', 'Helmet', kept, 'X', 0), null, '3 prefixes and 3 suffixes (one crafted) leave nothing open');
});

test('Quality and Sockets go under Rarity/name/base, not above Rarity, when the text has no Implicits line', () => {
  const t = 'Rarity: RARE\nDoom Shell\nVaal Regalia\n+100 to maximum Life';
  assert.equal(setHeader(t, 'Quality', '20'), 'Rarity: RARE\nDoom Shell\nVaal Regalia\nQuality: 20\n+100 to maximum Life');
  assert.equal(setHeader(t.replace('+100', 'Implicits: 0\n+100'), 'Sockets', 'R-G-B'), 'Rarity: RARE\nDoom Shell\nVaal Regalia\nSockets: R-G-B\nImplicits: 0\n+100 to maximum Life');
});
