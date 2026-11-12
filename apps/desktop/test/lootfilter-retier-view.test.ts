import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import type { PriceTable } from '../src/shared/lootfilter/ipcTypes.js';
import { computeRetier } from '../src/renderer/lootfilter/advanced/retier/compute.js';
import { formatPrice } from '../src/renderer/lootfilter/format.js';
import { neverSink } from './buildFilterHelpers.js';

// The Retier view once read as "shows an error" because a check matched the words "error" and "NaN" inside
// item names ("Domination Scarab of Terrors", "Orb of Dominance"). This pins what the view really draws: finite numbers only.
const catalog = buildCatalog(parseBlocks(neverSink()).blocks);

function prices(): PriceTable {
  const byName: PriceTable['byName'] = {};
  for (const ty of catalog.types) {
    if (ty.type.startsWith('uniques')) continue;
    const usable = ty.tiers.filter((t) => t.kind !== 'Hide' && !t.conditional);
    usable.forEach((t, ti) => {
      t.items.forEach((n, i) => {
        // Every third item is priced like a tier far from its own, so rows exist; the rest sit inside their tier.
        const rank = i % 3 === 0 ? usable.length - 1 - ti : ti;
        byName[n] = { chaos: Math.max(0.05, 400 / Math.pow(4, rank)) * (1 + (i % 5) / 10), category: 'x' };
      });
    });
  }
  return { league: 'Test', fetchedAt: Date.now(), source: 'poe.ninja', divine: 200, byName, uniqueByBase: {}, failed: [] } as unknown as PriceTable;
}

test('the retier view draws finite prices and percentages for every row, never NaN or Infinity', () => {
  const r = computeRetier(catalog, prices(), []);
  assert.equal(r.ready, true);
  assert.ok(r.rows.length > 20, 'the fixture must produce rows');
  const words = /\b(error|failed|could not|NaN|undefined|Infinity)\b/i;
  for (const row of r.rows) {
    for (const n of [row.price, row.fromMedian, row.toMedian, row.pct]) assert.ok(Number.isFinite(n), `${row.item.name}: ${n}`);
    const text = [formatPrice(row.fromMedian, 200), formatPrice(row.price, 200), `${row.pct}%`, `${row.fromName} to ${row.toName}`].join(' ');
    assert.ok(!words.test(text), `${row.item.name}: ${text}`);
  }
  for (const t of r.types) for (const b of t.bands) assert.ok(Number.isFinite(b.median) && Number.isFinite(b.low) && b.name.length > 0, `${t.label} ${b.name}`);
  assert.equal(r.total, r.rows.filter((x) => !x.done).length);
});

test('no prices or no catalog gives an empty, ready:false result and a price rule marks its rows done', () => {
  assert.equal(computeRetier(null, prices(), []).ready, false);
  assert.equal(computeRetier(catalog, null, []).ready, false);
  const base = computeRetier(catalog, prices(), []);
  const first = base.rows[0]!;
  const rule = { source: 'price', enabled: true, targets: [{ conditions: [{ key: 'BaseType', values: [first.item.name] }] }] };
  const again = computeRetier(catalog, prices(), [rule]);
  assert.equal(again.rows.find((x) => x.item.name === first.item.name)!.done, true);
  assert.equal(again.total, base.total - 1);
});

test('item names that contain the words error or nan are ordinary rows', () => {
  const r = computeRetier(catalog, prices(), []);
  const names = catalog.items.map((i) => i.name).filter((n) => /terror|dominance/i.test(n));
  assert.ok(names.length > 0, 'the base filter has such items');
  assert.ok(r.rows.every((x) => Number.isFinite(x.pct)));
});
