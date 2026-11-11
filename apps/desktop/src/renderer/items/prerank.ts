import type { CatalogBase, CommandParams, ItemCatalog, ItemInfo } from '@pom/protocol';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { activeSetOf, readItems } from '../../shared/itemsXml.js';
import { artFor } from '../gameArt';
import type { OpenBuild } from '../types';
import { cmd, loadCatalog, loadPowerStats } from './engine';
import { BASE_KEY, defaultItemSort, rankAll, RankScheduler, type RankCandidate } from './rank';
import { itemFitsSlot, slotCheckOf, slotsOf, type SlotDef } from './slots';

/**
 * Ranked values and item details per build, kept outside the Items tab. They lived in the panel before, so every visit to
 * the Items tab re-ran the whole sort (about 1,100 engine calculations, several seconds of progress bar) for an unchanged
 * build. Values are dropped when the build's XML changes, when the engine calculates the build again without a change
 * to its text (`calcRev`, after the timeless tables are installed), and when the engine closes the build.
 */
const RANKS = new Map<string, { xml: string; values: Map<string, number> }>();
const INFOS = new Map<string, Map<string, ItemInfo>>();
/** Each build's calculation count, as the engine last announced it (see `useCalcRev`). */
const REVS = new Map<string, number>();
const CLOSED = new Set<string>();
const revListeners = new Set<() => void>();
window.pom?.onEngineEvent((e) => {
  // Engine events not in the protocol's types (main/engineConnection.ts `BuildEngineEvent`).
  const ev = e as unknown as { type: string; buildId?: string; calcRev?: number };
  if (!ev.buildId || (ev.type !== 'calcRev' && ev.type !== 'sessionClosed')) return;
  RANKS.delete(ev.buildId);
  INFOS.delete(ev.buildId);
  if (ev.type === 'calcRev') REVS.set(ev.buildId, ev.calcRev ?? 0);
  else {
    REVS.delete(ev.buildId);
    CLOSED.add(ev.buildId);
  }
  revListeners.forEach((f) => f());
});

function subscribeRevs(f: () => void): () => void {
  revListeners.add(f);
  return () => revListeners.delete(f);
}

/** The build's calculation count: it moves when the engine calculated the build again with the same text. */
export function useCalcRev(buildId: string | null): number {
  return useSyncExternalStore(
    subscribeRevs,
    () => (buildId ? (REVS.get(buildId) ?? 0) : 0),
  );
}

export function rankCache(buildId: string, xml: string): Map<string, number> {
  // A run still going for a build the engine closed fills a map nobody keeps.
  if (CLOSED.has(buildId)) return new Map();
  let c = RANKS.get(buildId);
  if (!c || c.xml !== xml) {
    c = { xml, values: new Map() };
    RANKS.set(buildId, c);
  }
  return c.values;
}
// For the scripted checks (the values the background ranking left, compared with the Items tab's own engine call).
(window as unknown as { __pomRanks?: unknown }).__pomRanks = { RANKS, INFOS };
export function infoCache(buildId: string): Map<string, ItemInfo> {
  if (CLOSED.has(buildId)) return new Map();
  let c = INFOS.get(buildId);
  if (!c) INFOS.set(buildId, (c = new Map()));
  return c;
}

export type DbTab = 'unique' | 'rare' | 'shared';

/** The item list's filters; the defaults are what the Items tab opens with. */
export interface DbFilters {
  tab: DbTab;
  slot: string;
  type: string;
  league: string;
  obt: string;
  req: string;
  q: string;
  mode: 'any' | 'names' | 'mods';
}
export const DB_DEFAULTS: DbFilters = { tab: 'unique', slot: 'Any slot', type: 'Any type', league: 'Any league', obt: 'Obtainable', req: 'Any requirements', q: '', mode: 'any' };

export interface DbRow {
  key: string;
  name: string;
  text: string;
  colour: string;
  art?: string;
  base: string;
  label: string;
  level?: number;
}

/** `ItemClass:GetPrimarySlot` for a base. */
function primaryOf(b: CatalogBase | undefined, group?: string): string {
  const t = b?.type ?? '';
  if (b?.weapon) return 'Weapon 1';
  if (t === 'Shield' || t === 'Quiver') return 'Weapon 2';
  if (t === 'Ring') return 'Ring 1';
  if (t === 'Tincture' || group === 'flask' || b?.flask) return 'Flask 1';
  if (t === 'Graft') return 'Graft 1';
  return t;
}

export function basesByName(cat: ItemCatalog | null): Map<string, CatalogBase> {
  const m = new Map<string, CatalogBase>();
  for (const list of Object.values(cat?.bases ?? {})) for (const b of list) m.set(b.name, b);
  return m;
}

/** The build's level, for the "Current level" filter. */
export const buildLevel = (xml: string): number => Number(/<Build\b[^>]*\blevel="(\d+)"/.exec(xml)?.[1] ?? 0);

/** The unique or rare-template list (`ItemDBControl`) with its filters applied, in name order. */
export function dbRows(cat: ItemCatalog | null, baseOf: Map<string, CatalogBase>, f: DbFilters, level: number, stats: Record<string, unknown>): DbRow[] {
  if (!cat) return [];
  const { tab, slot, type, league, obt, req, q, mode } = f;
  const stat = (k: string): number => (typeof stats[k] === 'number' ? (stats[k] as number) : 0);
  const slotOk = (primary: string) => slot === 'Any slot' || primary === slot || primary.replace(/ \d$/, '') === slot;
  const typeOk = (b: CatalogBase | undefined) => {
    if (type === 'Any type') return true;
    if (!b) return false;
    if (type === 'Armour') return Boolean(b.armour);
    if (type === 'Jewellery') return b.type === 'Amulet' || b.type === 'Ring' || b.type === 'Belt';
    if (type === 'One Handed Melee' || type === 'Two Handed Melee') return Boolean(b.melee) && (type === 'One Handed Melee' ? b.oneHand === true : b.oneHand === false);
    return b.type === type;
  };
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out: DbRow[] = [];
  if (tab === 'unique') {
    // Uniques that share a name and base are one entry (upstream keeps the last).
    const byName = new Map<string, (typeof cat.uniques)[number]>();
    for (const u of cat.uniques) byName.set(`${u.name}, ${u.base}`, u);
    for (const u of byName.values()) {
      const b = baseOf.get(u.base);
      if (!slotOk(primaryOf(b, u.group)) || !typeOk(b)) continue;
      if (league !== 'Any league') {
        if (league === 'No league' ? u.league : !u.league || !u.league.includes(league)) continue;
      }
      const src = u.source ?? '';
      const obtainable = !(src === 'No longer obtainable' || u.league === 'Race Events');
      if (obt !== 'Any source') {
        if (obt === 'Obtainable' && !obtainable) continue;
        if (obt === 'Unobtainable' && obtainable) continue;
        if (obt === 'Vendor Recipe' && src !== 'Vendor Recipe') continue;
        if (obt === 'Upgraded' && !src.includes('Upgraded from')) continue;
        if (obt === 'Boss Item' && !src.includes('Drops from unique')) continue;
        if (obt === 'Corruption' && !src.includes('Vaal Orb')) continue;
        if (obt === 'Core Drop Pool' && u.source) continue;
      }
      if (req !== 'Any requirements') {
        if ((req === 'Current level' || req === 'Current useable') && level && u.level > level) continue;
        if (req === 'Current attributes' || req === 'Current useable') {
          if ((u.reqStr ?? b?.str ?? 0) > stat('Str') || (u.reqDex ?? b?.dex ?? 0) > stat('Dex') || (u.reqInt ?? b?.int ?? 0) > stat('Int')) continue;
        }
      }
      if (words.length) {
        const body = u.text.toLowerCase();
        const ok = mode === 'names' ? words.every((w) => u.name.toLowerCase().includes(w)) : mode === 'mods' ? words.every((w) => body.split('\n').slice(2).join('\n').includes(w)) : words.every((w) => body.includes(w));
        if (!ok) continue;
      }
      out.push({ key: `${u.group}:${u.name}:${u.base}`, name: u.name, text: u.text, colour: 'var(--rarity-unique)', art: artFor(u.name, 'uniques') ?? artFor(u.base, 'bases'), base: u.base, label: u.name });
    }
  } else {
    for (const r of cat.rares) {
      const b = baseOf.get(r.base);
      if (!slotOk(primaryOf(b)) || !typeOk(b)) continue;
      if (words.length) {
        const body = (r.label + ' ' + r.base + ' ' + r.text).toLowerCase();
        if (!words.every((w) => body.includes(w))) continue;
      }
      out.push({ key: `${r.label}:${r.base}:${out.length}`, name: r.label, text: r.text, colour: 'var(--rarity-rare)', art: artFor(r.base, 'bases'), base: r.base, label: r.label });
    }
  }
  if (tab === 'unique') out.sort((a, b) => a.name.replace(/^The /, '').localeCompare(b.name.replace(/^The /, '')));
  return out;
}

/** The candidates for a list, and each row's candidate key (its slots are part of it). */
export function rankCandidates(list: DbRow[], infos: Map<string, ItemInfo>, validSlots: (info: ItemInfo) => SlotDef[]) {
  const keyOf = new Map<string, string>();
  const cands: RankCandidate[] = [{ key: BASE_KEY, text: '', slots: [], base: true }];
  for (const r of list) {
    const info = infos.get(r.text);
    const slots = info?.valid ? validSlots(info).map((s) => s.name) : [];
    const key = `${r.key}|${slots.join(',')}`;
    keyOf.set(r.key, key);
    cands.push({ key, text: info?.text ?? r.text, slots, flask: info?.type === 'Flask' || info?.type === 'Tincture' });
  }
  return { keyOf, cands };
}

const READING = new WeakMap<Map<string, ItemInfo>, Promise<void>>();

/**
 * Fills in the item details of rows not read yet, `size` at a time. A read already going for the same build (the
 * background one, when the Items tab opens during it) is waited for first, so the details are not asked for twice.
 */
export async function readInfos(rows: DbRow[], infos: Map<string, ItemInfo>, read: (texts: string[]) => Promise<Array<ItemInfo | null | undefined>>, alive: () => boolean, size = 60): Promise<void> {
  await READING.get(infos);
  const missing = rows.filter((r) => !infos.has(r.text));
  if (!missing.length || !alive()) return;
  const job = (async () => {
    for (let i = 0; i < missing.length && alive(); i += size) {
      const chunk = missing.slice(i, i + size);
      const got = await read(chunk.map((r) => r.text));
      chunk.forEach((r, j) => got[j] && infos.set(r.text, got[j]!));
    }
  })();
  const settled = job.catch(() => undefined);
  READING.set(infos, settled);
  try {
    await job;
  } finally {
    if (READING.get(infos) === settled) READING.delete(infos);
  }
}

// ---- ranking ahead of the Items tab ------------------------------------------------------------------------------------

/**
 * How long the build has to stay unchanged before it is ranked in the background. Long enough that a run of tree clicks never
 * overlaps the ranking: its work (in the page and in the engine) delayed a click by 2 ms at the median and 9 ms at p95.
 */
const QUIET_MS = 2500;

interface Target {
  buildId: string;
  xml: string;
  rev: number;
}

const idle = () => new Promise<void>((res) => (window.requestIdleCallback ? window.requestIdleCallback(() => res(), { timeout: 300 }) : setTimeout(res, 0)));

/**
 * Ranks the list the Items tab opens on (the uniques by its default stat, every filter at its default) into the same
 * caches the tab reads, exactly as the tab would: the same candidates, keys and engine call. The engine call is marked
 * background, so the main process sends it in small pieces behind any other engine call (see EngineConnection). The tab
 * opened meanwhile waits for this run's candidates instead of asking again (`rankAll`).
 */
async function prerank({ buildId, xml }: Target, alive: () => boolean): Promise<boolean> {
  try {
    await idle();
    if (!alive()) return false;
    const [cat, powerStats] = await Promise.all([loadCatalog(), loadPowerStats()]);
    const model = readItems(xml);
    const [r, t, s, f] = await Promise.all([
      cmd('itemsInfo', { buildId, texts: model.items.map((i) => i.text) }),
      cmd('treeState', { buildId }),
      cmd('getStats', { buildId }),
      cmd('buildFlags', { buildId, names: ['AdditionalRingSlot'] }).catch(() => ({ flags: {} as Record<string, boolean> })),
    ]);
    if (!alive()) return false;
    const stats = Object.fromEntries(s.stats.map((x) => [x.id, x.value]));
    const sort = defaultItemSort(true, stats, powerStats);
    const def = powerStats.find((p) => p.stat === sort);
    if (!def) return false;
    const infos = new Map<number, ItemInfo>();
    model.items.forEach((it, i) => {
      const info = r.items[i];
      if (info) infos.set(it.id, info);
    });
    const src = { set: activeSetOf(model), infos, tree: t.tree, ring3: Boolean(f.flags.AdditionalRingSlot) };
    const slots = slotsOf(src);
    const validSlots = (info: ItemInfo) => slots.filter((d) => itemFitsSlot(info, d.name, slotCheckOf(src, d)));
    const list = dbRows(cat, basesByName(cat), DB_DEFAULTS, buildLevel(xml), stats);
    const rowInfos = infoCache(buildId);
    // In small background pieces too: reading 60 items keeps the engine busy for tens of milliseconds.
    await readInfos(list, rowInfos, async (texts) => (await cmd('itemsInfo', { buildId, texts, background: true } as CommandParams<'itemsInfo'>)).items, alive, 24);
    if (!alive()) return false;
    const { cands } = rankCandidates(list, rowInfos, validSlots);
    let epoch: number | undefined;
    const run = async (stat: string, batch: CommandParams<'itemRank'>['candidates']) => {
      const res = await cmd('itemRank', { buildId, stat, candidates: batch, background: true, epoch } as CommandParams<'itemRank'>);
      epoch = (res as { epoch?: number }).epoch;
      return res.values;
    };
    // Bigger requests than the tab's: the main process cuts them into its own small pieces anyway.
    await rankAll(def.stat, def.negate, cands, run, rankCache(buildId, xml), () => undefined, alive, 64);
    return false;
  } catch (e) {
    // The build was edited before its text here changed: try again once it settles.
    return /^stale/.test((e as Error).message);
  }
}

/** Keeps the open build ranked for the Items tab while it is looked at elsewhere; stops when it changes or closes. */
export function usePrerank(build: OpenBuild): void {
  const buildId = build.engine.state === 'ready' ? build.engine.summary.buildId : null;
  const xml = build.xml;
  const rev = useCalcRev(buildId);
  const sched = useMemo(() => new RankScheduler<Target>(prerank, QUIET_MS), []);
  useEffect(() => {
    // The values ranked for the text before are dropped at once, so nothing ranked while an edit was on its way is kept.
    if (buildId) rankCache(buildId, xml);
    sched.set(buildId ? { buildId, xml, rev } : null);
  }, [sched, buildId, xml, rev]);
  useEffect(() => () => sched.set(null), [sched]);
}
