import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoliteHttp } from '../src/main/kb/http.js';
import { KB_UA } from '../src/main/kb/http.js';
import { parseResistPenalties, parseVendorRecipes, parseXpSafeZone, plainWiki, wikiSource } from '../src/main/kb/sources/wiki.js';
import type { SourceCtx } from '../src/main/kb/sources/types.js';

const XP = `{{math|formula=x}}
{| class="wikitable"
|-
! Level Range !! Safe Zone
|-
| 1-15 || 3
|-
| 16-31 || 4
|-
| 32-47 || 5
|-
| 48-63 || 6
|-
| 64-79 || 7
|-
| 80-95 || 8
|-
|96+
|9
|}
After.`;

test('wiki parsers: xp safe zone, resist penalties, vendor recipes, plain text', () => {
  const xp = parseXpSafeZone(XP);
  assert.equal(xp.length, 7);
  assert.deepEqual(xp[0], { fromLevel: 1, toLevel: 15, below: 3, above: 3 });
  assert.deepEqual(xp[6], { fromLevel: 96, toLevel: 100, below: 9, above: 9 });
  const pen = parseResistPenalties('* Completion of [[Part One]]: -30% to all resistances\n* Completion of [[Part Two]]: -30% to all resistances (-60% total)');
  assert.deepEqual(pen.map((p) => [p.fromAct, p.penalty]), [[6, -30], [11, -30]]);
  const rec = parseVendorRecipes('==Equipment==\n*An {{il|Iron Ring}} with item level 55 plus {{il|Leap Slam}} yields a {{il|Ruby Ring}}.\n*x\n==Other==\n* Three [[Orb of Alchemy|alchemy]] orbs sold give a [[Chaos Orb]].');
  assert.equal(rec.length, 2);
  assert.deepEqual(rec[0], { category: 'Equipment', text: 'An Iron Ring with item level 55 plus Leap Slam yields a Ruby Ring.', items: ['Iron Ring', 'Leap Slam', 'Ruby Ring'] });
  assert.equal(rec[1]!.text, 'Three alchemy orbs sold give a Chaos Orb.');
  assert.equal(plainWiki("+(30-50) to [[Life|maximum Life]]&lt;br&gt;'''bold'''"), '+(30-50) to maximum Life\nbold');
  assert.equal(KB_UA, 'PathOfMasteryKB/0.1 (+https://github.com/aaronlilla/path-of-mastery)');
});

test('wiki source builds the Journey tables from API answers and sends the bot UA', async () => {
  const seen: Array<{ url: string; ua: string | undefined }> = [];
  const page = (text: string) => ({ query: { pages: { 1: { title: 't', revisions: [{ timestamp: '2026-10-01T00:00:00Z', slots: { main: { '*': text } } }] } } } });
  const recipes = '==Equipment==\n' + Array.from({ length: 12 }, (_, i) => `*Recipe number ${i} {{il|Item ${i}}} gives a thing`).join('\n');
  const uniques = Array.from({ length: 25 }, (_, i) => ({ title: { name: `Unique ${i}`, class: 'Ring', 'base item': 'Iron Ring', 'drop level': String(i + 1), 'required level': '1', 'drop areas': null, 'drop text': null, 'implicit stat text': null, 'explicit stat text': '+10 to [[Life]]&lt;br&gt;+5 to [[Mana]]' } }));
  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, ua: init?.headers?.['User-Agent'] });
    const u = new URL(url);
    let body: unknown;
    if (u.searchParams.get('action') === 'cargoquery') body = { cargoquery: uniques };
    else {
      const t = u.searchParams.get('titles');
      body = page(t === 'Vendor recipe system' ? recipes : t === 'Resistance' ? '* Completion of [[Part One]]: -30% to all resistances\n* Completion of [[Part Two]]: -30% to all resistances' : XP);
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const http = new PoliteHttp({ fetch, gapMs: { 'www.poewiki.net': 0 } });
  const ctx: SourceCtx = { http, cacheDir: '', livePatch: '3.29.3.3', app: { levelingDir: '', lootfilterDir: '', engineDataDir: '' }, log: () => undefined };
  const out = await wikiSource.pull(ctx);
  assert.deepEqual(Object.keys(out.tables!).sort(), ['leveling-uniques', 'resist-penalties', 'vendor-recipes', 'xp-penalty']);
  const lu = out.tables!['leveling-uniques']!.data as Array<{ name: string; explicits: string[] }>;
  assert.equal(lu.length, 25);
  assert.deepEqual(lu[0]!.explicits, ['+10 to Life', '+5 to Mana']);
  const xp = out.tables!['xp-penalty']!.data as { safeRange: Array<{ fromLevel: number; below: number }> };
  assert.equal(xp.safeRange.length, 100);
  assert.equal(xp.safeRange[99]!.below, 9);
  assert.equal(out.entities.doc!.length, 3 + 14); // the three rule pages plus the mechanic pages
  assert.ok(out.entities.doc!.some((d) => d.id === 'wiki:Item socket'));
  assert.ok(seen.every((s) => s.ua === KB_UA && s.url.startsWith('https://www.poewiki.net/w/api.php')));
  assert.equal(out.note, undefined);
});
