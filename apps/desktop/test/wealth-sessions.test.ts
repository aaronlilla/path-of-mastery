import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, emptyTracker, SessionTracker, totals, IDLE_END_MS, type Snapshot, type SnapItem } from '../src/main/wealth/sessions.js';
import type { Cat } from '../src/shared/wealth.js';

const DIV = 400;
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

const it = (n: string, c: Cat, q: number, u: number | null): SnapItem => ({ n, c, q, u, a: n });
const snap = (min: number, items: Record<string, SnapItem>): Snapshot => ({ t: T0 + min * MIN, items });
const base = () => ({
  chaos: it('Chaos Orb', 'cur', 1000, 1),
  div: it('Divine Orb', 'cur', 5, DIV),
  map: it('Strand Map', 'map', 20, null),
  orb: it('Delirium Orb', 'cur', 10, 15),
  beast: it('Divine Scarab of Beasts', 'scar', 4, 700),
  mage: it('Mageblood', 'uniq', 1, 80000),
});
const tracker = () => new SessionTracker(emptyTracker(), () => DIV);

test('a diff splits arrivals and departures and prices them at the snapshot unit price', () => {
  const a = snap(0, base());
  const b = snap(3, { ...base(), chaos: it('Chaos Orb', 'cur', 1200, 1), map: it('Strand Map', 'map', 18, null), beast: it('Divine Scarab of Beasts', 'scar', 3, 700) });
  const d = diffSnapshots(a, b, DIV);
  assert.equal(d.gainValue, 200);
  assert.equal(d.costValue, 700, 'one scarab used; two unpriced maps cost nothing we can price');
  assert.equal(d.maps, 2);
  assert.equal(d.activity, true);
  assert.equal(d.spent.find((x) => x.name === 'Strand Map')?.priced, false);
});

test('no change is not activity', () => {
  const d = diffSnapshots(snap(0, base()), snap(3, base()), DIV);
  assert.equal(d.activity, false);
  assert.equal(d.gainValue, 0);
});

test('a sale (an item leaves, similar currency arrives) is a trade and is left out of profit', () => {
  const a = snap(0, base());
  const b = snap(3, { ...base(), mage: it('Mageblood', 'uniq', 0, 80000), div: it('Divine Orb', 'cur', 5 + 200, DIV) });
  const d = diffSnapshots(a, b, DIV);
  assert.equal(d.gainValue, 0);
  assert.equal(d.costValue, 0);
  assert.ok(d.flags.some((f) => f.startsWith('Trade')));
  assert.equal(d.trade.length, 2);
  assert.equal(d.activity, false);
});

test('a purchase (an item arrives, similar currency leaves) is a trade too', () => {
  const a = snap(0, base());
  const b = snap(3, { ...base(), div: it('Divine Orb', 'cur', 5 - 3, DIV), ring: it('Doom Loop', 'uniq', 1, 1100) });
  const d = diffSnapshots(a, b, DIV);
  assert.equal(d.gainValue, 0);
  assert.equal(d.costValue, 0);
  assert.ok(d.flags.some((f) => f.startsWith('Trade')));
});

test('a unique that drops while you spend a little currency is loot, not a trade', () => {
  const a = snap(0, base());
  const b = snap(3, { ...base(), chaos: it('Chaos Orb', 'cur', 900, 1), ring: it('Doom Loop', 'uniq', 1, 1100) });
  const d = diffSnapshots(a, b, DIV);
  assert.equal(d.trade.length, 0);
  assert.equal(d.gainValue, 1100);
  assert.equal(d.costValue, 100);
});

test('an item that vanishes with no matching currency is flagged "Check this" and not counted as a cost', () => {
  const a = snap(0, base());
  const b = snap(3, { ...base(), mage: it('Mageblood', 'uniq', 0, 80000) });
  const d = diffSnapshots(a, b, DIV);
  assert.equal(d.costValue, 0);
  assert.equal(d.unclear.length, 1);
  assert.ok(d.flags.some((f) => f.startsWith('Check this')));
});

function mapRun(t: SessionTracker, from: number, n: number, step = 3): number {
  // Each snapshot: 2 maps used, 1 scarab used, 150 chaos and a divine arrive.
  let m = from;
  const cur = t.state.prev ? { ...t.state.prev.items } : base();
  for (let i = 0; i < n; i++) {
    m += step;
    const c = cur.chaos as SnapItem;
    const dv = cur.div as SnapItem;
    const mp = cur.map as SnapItem;
    const sc = cur.beast as SnapItem;
    cur.chaos = { ...c, q: c.q + 150 };
    cur.div = { ...dv, q: dv.q + 1 };
    cur.map = { ...mp, q: mp.q - 2 };
    cur.beast = { ...sc, q: sc.q - 1 };
    t.onSnapshot(snap(m, JSON.parse(JSON.stringify(cur))));
  }
  return m;
}

test('one active interval does not start a session; two in a row do, back-dated to the first one', () => {
  const t = tracker();
  t.onSnapshot(snap(0, base()));
  t.onSnapshot(snap(3, base())); // quiet
  assert.equal(t.state.run, null);
  mapRun(t, 3, 1);
  assert.equal(t.state.run, null, 'one interval of play is not a session yet');
  assert.ok(t.state.cand);
  mapRun(t, 6, 1);
  assert.ok(t.state.run, 'the second interval in a row starts it');
  assert.equal((t.state.run as { start: number } | null)?.start, T0 + 3 * MIN, 'back-dated to the snapshot before the first active interval');
});

test('a single burst followed by quiet never becomes a session', () => {
  const t = tracker();
  t.onSnapshot(snap(0, base()));
  mapRun(t, 0, 1);
  t.onSnapshot(snap(6, t.state.prev?.items as Record<string, SnapItem>));
  mapRun(t, 6, 1);
  assert.equal(t.state.run, null, 'the quiet interval reset the candidate, so one more active interval is again only a candidate');
});

test('revenue, cost, net and per-hour come from the snapshots', () => {
  const t = tracker();
  t.onSnapshot(snap(0, base()));
  const end = mapRun(t, 0, 20); // 20 intervals x 3 min = 60 min
  assert.equal(end, 60);
  const r = t.state.run;
  assert.ok(r);
  const tot = totals(r);
  assert.equal(tot.revenue, 20 * (150 + DIV));
  assert.equal(tot.cost, 20 * 700);
  assert.equal(tot.net, tot.revenue - tot.cost);
  assert.equal(r.maps, 40);
  assert.equal(r.snapshots, 20);
  assert.equal(r.name, 'Strand', 'named from the maps that left');
});

test('a quiet 30 minutes ends the session at the last moment anything happened', () => {
  const t = tracker();
  t.onSnapshot(snap(0, base()));
  const last = mapRun(t, 0, 4);
  assert.ok(t.state.run);
  let m = last;
  for (let i = 0; i < 12; i++) {
    m += 3;
    t.onSnapshot(snap(m, t.state.prev?.items as Record<string, SnapItem>));
  }
  assert.equal(t.state.run, null);
  assert.equal(t.state.closed.length, 1);
  assert.equal(t.state.closed[0]?.end, T0 + last * MIN);
});

test('time passing with no snapshot at all also ends a quiet session', () => {
  const t = tracker();
  t.onSnapshot(snap(0, base()));
  const last = mapRun(t, 0, 4);
  assert.equal(t.tick(T0 + (last + 29) * MIN), false);
  assert.equal(t.tick(T0 + last * MIN + IDLE_END_MS), true);
  assert.equal(t.state.run, null);
});

test('a manual session ends only when the player ends it', () => {
  const t = tracker();
  t.onSnapshot(snap(0, base()));
  t.startManual(T0, 'Crafting Ring 2');
  let m = 0;
  for (let i = 0; i < 20; i++) {
    m += 3;
    t.onSnapshot(snap(m, t.state.prev?.items as Record<string, SnapItem>));
  }
  assert.ok(t.state.run, '60 quiet minutes later it is still running');
  assert.equal(t.state.run?.name, 'Crafting Ring 2');
  assert.equal(t.tick(T0 + 5 * 60 * MIN), false);
  assert.equal(t.end(T0 + 60 * MIN), true);
  assert.equal(t.state.closed[0]?.end, T0 + 60 * MIN);
});

test('marking an item as a transfer takes it out of profit', () => {
  const t = tracker();
  t.onSnapshot(snap(0, base()));
  mapRun(t, 0, 4);
  const r = t.state.run;
  assert.ok(r);
  const before = totals(r).net;
  const div = r.gained['Divine Orb'] ?? Object.values(r.gained).find((i) => i.name === 'Divine Orb');
  assert.ok(div);
  div.transfer = true;
  assert.equal(totals(r).net, before - div.value);
});

test('a tiny item-for-currency swap is not treated as a trade', () => {
  const a = snap(0, { ...base(), junk: it('Vendor Junk', 'rare', 1, 3) });
  const b = snap(3, { ...base(), chaos: it('Chaos Orb', 'cur', 1004, 1) });
  const d = diffSnapshots(a, b, DIV);
  assert.equal(d.trade.length, 0);
  assert.equal(d.unclear.length, 1);
});
