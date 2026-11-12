// A gem, cluster jewel, map or base with many variants is priced like a unique: the variant most people list,
// never a thin line (1 listing) that happens to be the dearest. Fixture lines are shaped like poe.ninja's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PoeNinjaPrices, foldVariantPrices, type StashLine } from '../src/main/lootfilter/prices.js';

const L = (name: string, chaosValue: number, listingCount: number, extra: Partial<StashLine> = {}): StashLine => ({ name, chaosValue, listingCount, ...extra });

const GEMS: StashLine[] = [
  L('Invert the Rules Support', 401_676, 1, { variant: '21/23c', gemLevel: 21 }),
  L('Invert the Rules Support', 2_941, 72, { variant: '4/20c' }),
  L('Invert the Rules Support', 13, 120, { variant: '1/0' }),
  L('Invert the Rules Support', 90, 8, { variant: '3/20' }),
  L('Rare Thing Support', 5_000, 2, { variant: '5/0' }),
  L('Rare Thing Support', 7_000, 1, { variant: '5/20' }),
];

test('a plain gem takes the price of its most listed variant, not the dearest', () => {
  const m = foldVariantPrices(GEMS);
  assert.equal(m.get('Invert the Rules Support'), 13);
});

test('a gem with only thin lines (under 5 listings) gets no price at all', () => {
  assert.equal(foldVariantPrices(GEMS).has('Rare Thing Support'), false);
});

test('on a tie the cheaper line wins', () => {
  assert.equal(foldVariantPrices([L('Pair', 900, 6), L('Pair', 100, 6)]).get('Pair'), 100);
});

test('cluster jewels, maps and bases fold the same way', () => {
  const cluster = foldVariantPrices([L('12% increased Totem Damage', 3_676, 1, { variant: '4 passives' }), L('12% increased Totem Damage', 40, 60, { variant: '3 passives' })]);
  assert.equal(cluster.get('12% increased Totem Damage'), 40);
  const maps = foldVariantPrices([L('Strand Map', 2, 300, { variant: 'T16' }), L('Strand Map', 500, 3, { variant: 'T17' })]);
  assert.equal(maps.get('Strand Map'), 2, 'the tier most people list, not a 3-listing line');
  const bases = foldVariantPrices([L('Legion Sword', 1_606_704, 1, { variant: 'Elder/Hunter' }), L('Legion Sword', 6, 50, { variant: '86' })]);
  assert.equal(bases.get('Legion Sword'), 6);
});

test('the price table built from a fetch uses the common gem variant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-vp-'));
  try {
    const fetcher = async (url: string) => {
      const ok = (j: unknown) => ({ ok: true, status: 200, json: async () => j });
      if (url.includes('index-state')) return ok({ economyLeagues: [{ name: 'Allflame' }] });
      if (url.includes('type=SkillGem')) return ok({ lines: GEMS });
      if (url.includes('economy/exchange')) return ok({ core: { rates: { divine: 0.01 } }, lines: [], items: [] });
      return ok({ lines: [] });
    };
    const p = new PoeNinjaPrices(dir, fetcher as never);
    const r = await p.getPrices();
    assert.ok(r.table);
    assert.equal(r.table.byName['Invert the Rules Support']!.chaos, 13);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
