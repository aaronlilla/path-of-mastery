/**
 * Snapshots, snapshot diffs and the session tracker.
 *
 * A snapshot is what the counted tabs (and the character's inventory) held at one moment, with the low-end unit
 * price of every stack at that moment. Sessions are never typed in: they come from the differences between
 * consecutive snapshots (spec, "Sessions").
 *
 *  - A session starts when two consecutive snapshots both gained value, or maps and fragments left the stash. It is
 *    back-dated to the start of the first of those two intervals.
 *  - It ends after 30 minutes with no change, or when the player ends it. A manual start only ends by hand.
 *  - Cost is what left the counted tabs and was consumed. A big currency change paired with an item that appeared or
 *    disappeared in the same interval is a trade and is left out of profit. Anything unclear is flagged "Check this".
 */
import type { Cat } from '../../shared/wealth.js';

export interface SnapItem {
  /** Display name. */
  n: string;
  c: Cat;
  q: number;
  /** Low-end unit price in chaos at the time, null when unpriced. */
  u: number | null;
  a: string;
  ac?: string;
}

export interface Snapshot {
  t: number;
  items: Record<string, SnapItem>;
}

export interface Delta {
  key: string;
  name: string;
  cat: Cat;
  /** Positive: arrived. Negative: left. */
  qty: number;
  /** Value of the change, chaos, always positive. Zero when unpriced. */
  value: number;
  art: string;
  artCat?: string;
  priced: boolean;
}

export interface DiffResult {
  gained: Delta[];
  spent: Delta[];
  /** Items left out of profit as one side of a trade. */
  trade: Delta[];
  /** Items that left with no explanation. */
  unclear: Delta[];
  gainValue: number;
  costValue: number;
  /** Maps used in this interval. */
  maps: number;
  /** Whether something happened that counts as play: value arrived, or maps and fragments left. */
  activity: boolean;
  flags: string[];
}

/** Things that are used up by playing: they are costs when they leave. */
const CONSUMED = new Set<Cat>(['map', 'frag', 'scar', 'cur', 'ess', 'card']);

export function diffSnapshots(prev: Snapshot, cur: Snapshot, divine: number): DiffResult {
  const gained: Delta[] = [];
  const spent: Delta[] = [];
  const keys = new Set([...Object.keys(prev.items), ...Object.keys(cur.items)]);
  for (const k of keys) {
    const a = prev.items[k];
    const b = cur.items[k];
    const dq = (b?.q ?? 0) - (a?.q ?? 0);
    if (dq === 0) continue;
    const ref = dq > 0 ? b : a;
    const unit = (dq > 0 ? b?.u : a?.u) ?? (dq > 0 ? a?.u : b?.u) ?? null;
    const it = (ref ?? a ?? b) as SnapItem;
    const d: Delta = { key: k, name: it.n, cat: it.c, qty: dq, value: unit === null ? 0 : Math.abs(dq) * unit, art: it.a, ...(it.ac ? { artCat: it.ac } : {}), priced: unit !== null };
    (dq > 0 ? gained : spent).push(d);
  }

  const sum = (xs: Delta[], f: (d: Delta) => boolean = () => true) => xs.filter(f).reduce((s, d) => s + d.value, 0);
  const nonCons = (d: Delta) => !CONSUMED.has(d.cat);
  const trade: Delta[] = [];
  const unclear: Delta[] = [];
  const flags: string[] = [];
  let gainList = gained;
  let spentList = spent;

  const minTrade = Math.max(1, divine * 0.25);
  const ratioOk = (a: number, b: number) => a >= minTrade && b >= minTrade && a / b >= 0.5 && a / b <= 2;

  // An item left and a similar value of currency arrived (a sale), or an item arrived and currency left (a purchase).
  const itemOut = sum(spentList, nonCons);
  const curIn = sum(gainList, (d) => d.cat === 'cur');
  const itemIn = sum(gainList, nonCons);
  const curOut = sum(spentList, (d) => d.cat === 'cur');
  if (itemOut > 0 && ratioOk(itemOut, curIn)) {
    trade.push(...spentList.filter(nonCons), ...gainList.filter((d) => d.cat === 'cur'));
    spentList = spentList.filter((d) => !nonCons(d));
    gainList = gainList.filter((d) => d.cat !== 'cur');
    flags.push('Trade: an item left and currency arrived. Left out of profit.');
  } else if (itemIn > 0 && ratioOk(itemIn, curOut)) {
    trade.push(...gainList.filter(nonCons), ...spentList.filter((d) => d.cat === 'cur'));
    gainList = gainList.filter((d) => !nonCons(d));
    spentList = spentList.filter((d) => d.cat !== 'cur');
    flags.push('Trade: an item arrived and currency left. Left out of profit.');
  }

  // Anything else that is not used up by playing and left: we can't tell where it went.
  const gone = spentList.filter(nonCons);
  if (gone.length) {
    unclear.push(...gone);
    spentList = spentList.filter((d) => !nonCons(d));
    flags.push(`Check this: ${gone.map((d) => d.name).slice(0, 3).join(', ')}${gone.length > 3 ? ` and ${gone.length - 3} more` : ''} left your counted tabs. It may have been sold, moved to a tab that isn't counted, or given away.`);
  }

  const maps = spentList.filter((d) => d.cat === 'map').reduce((s, d) => s - d.qty, 0);
  const mapsOrFrags = spentList.some((d) => (d.cat === 'map' || d.cat === 'frag') && d.qty < 0);
  const gainValue = sum(gainList);
  const costValue = sum(spentList);
  return { gained: gainList, spent: spentList, trade, unclear, gainValue, costValue, maps, activity: gainValue >= 1 || mapsOrFrags, flags };
}

// ---- tracker -------------------------------------------------------------------------------------------------------

export interface RunItem {
  key: string;
  name: string;
  cat: Cat;
  qty: number;
  value: number;
  art: string;
  artCat?: string;
  /** Marked by the player as a transfer: left out of profit. */
  transfer?: boolean;
}

export interface Run {
  id: string;
  name: string;
  custom: boolean;
  manual: boolean;
  start: number;
  lastActivity: number;
  end: number | null;
  gained: Record<string, RunItem>;
  spent: Record<string, RunItem>;
  bars: { t: number; v: number }[];
  flags: string[];
  snapshots: number;
  maps: number;
  strategyId?: string;
  published?: boolean;
}

export interface TrackerState {
  prev: Snapshot | null;
  cand: { start: number; diff: DiffResult } | null;
  run: Run | null;
  closed: Run[];
}

export const emptyTracker = (): TrackerState => ({ prev: null, cand: null, run: null, closed: [] });

export const IDLE_END_MS = 30 * 60 * 1000;

function addTo(map: Record<string, RunItem>, d: Delta): void {
  const k = d.key;
  const ex = map[k];
  if (ex) {
    ex.qty += Math.abs(d.qty);
    ex.value += d.value;
  } else map[k] = { key: k, name: d.name, cat: d.cat, qty: Math.abs(d.qty), value: d.value, art: d.art, ...(d.artCat ? { artCat: d.artCat } : {}) };
}

/** A name for what happened, from what was used up. */
export function recogniseName(spent: Record<string, RunItem>): string {
  const items = Object.values(spent).filter((i) => !i.transfer);
  const maps = items.filter((i) => i.cat === 'map').sort((a, b) => b.qty - a.qty);
  const frags = items.filter((i) => i.cat === 'frag' || i.cat === 'cur').map((i) => i.name);
  const extra = /Delirium|Simulacrum/i.test(frags.join(' ')) ? 'Delirium' : /Legion|Emblem/i.test(frags.join(' ')) ? 'Legion' : /Sirus|Writhing/i.test(frags.join(' ')) ? 'Sirus' : '';
  const m = maps[0]?.name.replace(/\s+Map$/i, '');
  const topFrag = items.filter((i) => i.cat === 'frag').sort((a, b) => b.value - a.value)[0]?.name;
  if (m && extra) return `${m} · ${extra}`;
  if (m) return m;
  if (extra) return extra;
  if (topFrag) return topFrag;
  return 'Session';
}

export interface RunTotals {
  revenue: number;
  cost: number;
  net: number;
}

export function totals(run: Run): RunTotals {
  const revenue = Object.values(run.gained).reduce((s, i) => s + (i.transfer ? 0 : i.value), 0);
  const cost = Object.values(run.spent).reduce((s, i) => s + (i.transfer ? 0 : i.value), 0);
  return { revenue, cost, net: revenue - cost };
}

export class SessionTracker {
  constructor(
    public state: TrackerState,
    private readonly divine: () => number,
  ) {}

  private newRun(start: number, manual: boolean, name: string): Run {
    return { id: `s${start}`, name, custom: manual && name !== 'Session', manual, start, lastActivity: start, end: null, gained: {}, spent: {}, bars: [], flags: [], snapshots: 0, maps: 0 };
  }

  private absorb(run: Run, d: DiffResult, t: number): void {
    for (const g of d.gained) addTo(run.gained, g);
    for (const s of d.spent) addTo(run.spent, s);
    run.maps += d.maps;
    run.snapshots += 1;
    run.bars.push({ t, v: d.gainValue - d.costValue });
    for (const f of d.flags) if (!run.flags.includes(f)) run.flags.push(f);
    if (d.activity) run.lastActivity = t;
    if (!run.custom) run.name = recogniseName(run.spent);
  }

  private close(end: number): void {
    const r = this.state.run;
    if (!r) return;
    r.end = end;
    this.state.closed.unshift(r);
    this.state.run = null;
  }

  /** Feed the next snapshot. Returns true when something about sessions changed. */
  onSnapshot(snap: Snapshot): boolean {
    const st = this.state;
    const prev = st.prev;
    st.prev = snap;
    if (!prev) return false;
    const d = diffSnapshots(prev, snap, this.divine());
    if (st.run) {
      const r = st.run;
      if (r.manual || d.activity) this.absorb(r, d, snap.t);
      else {
        r.bars.push({ t: snap.t, v: 0 });
        r.snapshots += 1;
      }
      if (!r.manual && snap.t - r.lastActivity >= IDLE_END_MS) this.close(r.lastActivity);
      return true;
    }
    if (!d.activity) {
      st.cand = null;
      return false;
    }
    if (!st.cand) {
      st.cand = { start: prev.t, diff: d };
      return false;
    }
    // Two intervals in a row with play in them: the session began at the start of the first.
    const run = this.newRun(st.cand.start, false, 'Session');
    this.absorb(run, st.cand.diff, prev.t);
    this.absorb(run, d, snap.t);
    st.run = run;
    st.cand = null;
    return true;
  }

  /** Time passing with no new snapshot: ends a quiet session. */
  tick(now: number): boolean {
    const r = this.state.run;
    if (r && !r.manual && now - r.lastActivity >= IDLE_END_MS) {
      this.close(r.lastActivity);
      return true;
    }
    return false;
  }

  startManual(now: number, name: string, strategyId?: string): void {
    if (this.state.run) {
      // A manual start while one is running tags the running one instead of starting a second.
      const r = this.state.run;
      r.manual = true;
      if (name && name !== 'Session') {
        r.name = name;
        r.custom = true;
      }
      if (strategyId) r.strategyId = strategyId;
      return;
    }
    const r = this.newRun(now, true, name || 'Session');
    if (strategyId) r.strategyId = strategyId;
    this.state.run = r;
    this.state.cand = null;
  }

  /** The player ends the running session. */
  end(now: number): boolean {
    const r = this.state.run;
    if (!r) return false;
    // The player pressed End: the session ran to now, the length they were watching. Only a session that goes quiet by itself ends at its last loot.
    this.close(Math.max(r.start, r.lastActivity, now));
    return true;
  }

  find(id: string): Run | null {
    if (this.state.run?.id === id) return this.state.run;
    return this.state.closed.find((r) => r.id === id) ?? null;
  }

  /** Puts a removed run back (the player pressed Undo). The running slot is only taken when it is free. */
  restore(run: Run): boolean {
    if (this.find(run.id)) return false;
    if (run.end === null) {
      if (this.state.run) return false;
      this.state.run = run;
    } else {
      this.state.closed = [...this.state.closed, run].sort((a, b) => b.start - a.start);
    }
    return true;
  }

  remove(id: string): boolean {
    if (this.state.run?.id === id) {
      this.state.run = null;
      return true;
    }
    const n = this.state.closed.length;
    this.state.closed = this.state.closed.filter((r) => r.id !== id);
    return this.state.closed.length !== n;
  }
}
