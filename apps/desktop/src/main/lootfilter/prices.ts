import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PriceEntry, PriceResult, PriceTable } from '../../shared/lootfilter/ipcTypes.js';
import { ninjaBase, withNinjaFallback } from '../wealth/ninjaUrl.js';

/**
 * The one price interface the loot filter uses. Until Wealth's shared price service lands,
 * this talks to poe.ninja directly, behind this interface, so swapping it is one constructor.
 */
export interface PriceService {
  getPrices(opts?: { league?: string; force?: boolean }): Promise<PriceResult>;
  currentLeague(): Promise<string>;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// the backend first in an official build, poe.ninja directly when it fails or when there is none (wealth/ninjaUrl.ts)
const EXCHANGE = ['Currency', 'Fragment', 'Scarab', 'DivinationCard', 'Artifact', 'Oil', 'Fossil', 'Resonator', 'Essence', 'DeliriumOrb', 'Runegraft', 'Omen', 'Tattoo', 'AllflameEmber'];
const STASH = ['UniqueMap', 'Map', 'UniqueJewel', 'UniqueFlask', 'UniqueWeapon', 'UniqueArmour', 'UniqueAccessory', 'SkillGem', 'ClusterJewel', 'Vial', 'Wombgift', 'Invitation', 'BlightedMap'];

interface ExchangeResponse {
  core?: { rates?: Record<string, number> };
  lines?: { id: string; primaryValue: number }[];
  items?: { id: string; name: string }[];
}
export interface StashLine {
  name: string;
  baseType?: string;
  chaosValue?: number;
  links?: number;
  gemLevel?: number;
  variant?: string;
  detailsId?: string;
  listingCount?: number;
  icon?: string;
}

/** Fewest listings a line needs before its price means anything. */
export const MIN_LISTINGS = 5;

type Pick = { n: number; v: number; base?: string; plain: boolean };

/** True for a line that cannot stand for the item players usually meet: Foulborn copies and relics. */
function special(l: StashLine): boolean {
  return /^Foulborn /i.test(l.name) || /relic/i.test(`${l.name} ${l.icon ?? ''}`);
}

/**
 * One price per name from poe.ninja lines that carry variants: a unique's rolls, a gem's level, quality and
 * corruption, a cluster jewel's passive count, a map's tier, a base's influence and item level. The rule is
 * the same for every category:
 * - linked copies and lines with fewer than 5 listings are left out (uniques that only have such lines still
 *   get their own price, never a base price; every other category gives them none);
 * - for one name, the variant with the most listings is the item as players usually meet it; on a tie the
 *   cheaper one wins, so a pair of one-listing lines cannot set an absurd price.
 */
export function foldVariantLines(lines: StashLine[]): { best: Map<string, Pick>; thin: Map<string, Pick> } {
  const best = new Map<string, Pick>();
  const thin = new Map<string, Pick>();
  for (const l of lines) {
    const v = l.chaosValue;
    if (typeof v !== 'number' || (l.links ?? 0) > 0) continue;
    const n = l.listingCount ?? 0;
    const into = n >= MIN_LISTINGS ? best : thin;
    const cur = into.get(l.name);
    if (!cur || n > cur.n || (n === cur.n && v < cur.v)) into.set(l.name, { n, v, base: l.baseType, plain: !special(l) });
  }
  return { best, thin };
}

/**
 * The price of each name in a category with variants (gems, cluster jewels, maps, bases). A name whose lines
 * all have fewer than 5 listings gets no price: a gem listed once at 18,000c is a stray, not a market.
 */
export function foldVariantPrices(lines: StashLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, e] of foldVariantLines(lines).best) out.set(name, e.v);
  return out;
}

/**
 * Unique prices by name and by base from poe.ninja's unique lines. A unique can have many lines (rolled
 * variants, Foulborn copies, relics). Rules, applied to every unique alike:
 * - the variant rules of foldVariantLines;
 * - the price of a base is the dearest name on it, and Foulborn and relic versions never set it.
 */
export function foldUniqueLines(lines: StashLine[]): { byName: Map<string, number>; byBase: Map<string, number>; baseName: Map<string, string> } {
  const { best, thin } = foldVariantLines(lines);
  const byName = new Map<string, number>();
  const byBase = new Map<string, number>();
  const baseName = new Map<string, string>();
  for (const [name, e] of best) {
    byName.set(name, e.v);
    if (e.plain && e.base && e.v > (byBase.get(e.base) ?? 0)) {
      byBase.set(e.base, e.v);
      baseName.set(e.base, name);
    }
  }
  // A name seen only on thin lines still gets its own price, never a base price.
  for (const [name, e] of thin) if (!byName.has(name)) byName.set(name, e.v);
  return { byName, byBase, baseName };
}

interface StashResponse {
  lines?: StashLine[];
}

const defaultFetch: Fetcher = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'PathOfMastery/0.1 (+loot filter prices)' }, signal: AbortSignal.timeout(20000) });
  return { ok: r.ok, status: r.status, json: () => r.json() as Promise<unknown> };
};

export class PoeNinjaPrices implements PriceService {
  private memo: PriceTable | null = null;
  private leagueMemo: { name: string; at: number } | null = null;

  constructor(
    private readonly cacheDir: string,
    fetcher: Fetcher = defaultFetch,
    private readonly refreshMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    this.fetcher = withNinjaFallback(fetcher, now);
  }
  private readonly fetcher: Fetcher;

  async currentLeague(): Promise<string> {
    if (this.leagueMemo && this.now() - this.leagueMemo.at < 6 * 3600 * 1000) return this.leagueMemo.name;
    const r = await this.fetcher(`${ninjaBase()}/data/index-state`);
    if (!r.ok) throw new Error(`poe.ninja answered ${r.status} when asked for the current league.`);
    const j = (await r.json()) as { economyLeagues?: { name: string }[] };
    const names = (j.economyLeagues ?? []).map((l) => l.name);
    const pick = names.find((n) => !/^(Standard|Hardcore|SSF|Solo|Ruthless)/i.test(n) && !/Hardcore|SSF|Ruthless/i.test(n)) ?? names[0];
    if (!pick) throw new Error('poe.ninja listed no leagues.');
    this.leagueMemo = { name: pick, at: this.now() };
    return pick;
  }

  private cacheFile(league: string): string {
    return join(this.cacheDir, `prices-${league.replace(/[^A-Za-z0-9]+/g, '_')}.json`);
  }

  private async readCache(league: string): Promise<PriceTable | null> {
    try {
      const t = JSON.parse(await readFile(this.cacheFile(league), 'utf8')) as PriceTable;
      return t && t.league === league && t.byName ? t : null;
    } catch {
      return null;
    }
  }

  async getPrices(opts: { league?: string; force?: boolean } = {}): Promise<PriceResult> {
    let league = opts.league ?? '';
    try {
      if (!league) league = await this.currentLeague();
    } catch (e) {
      const cached = this.memo ?? null;
      return { table: cached, error: e instanceof Error ? e.message : String(e), stale: !!cached };
    }
    const cached = (this.memo && this.memo.league === league ? this.memo : null) ?? (await this.readCache(league));
    if (cached && !opts.force && this.now() - cached.fetchedAt < this.refreshMs) {
      this.memo = cached;
      return { table: cached };
    }
    try {
      const table = await this.fetchAll(league);
      this.memo = table;
      await mkdir(this.cacheDir, { recursive: true });
      const f = this.cacheFile(league);
      await writeFile(f + '.tmp', JSON.stringify(table), 'utf8');
      await rename(f + '.tmp', f);
      return { table };
    } catch (e) {
      if (cached) {
        this.memo = cached;
        return { table: cached, error: e instanceof Error ? e.message : String(e), stale: true };
      }
      return { table: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async fetchAll(league: string): Promise<PriceTable> {
    const byName: Record<string, PriceEntry> = {};
    const uniqueByBase: Record<string, number> = {};
    const uniqueByBaseName: Record<string, string> = {};
    const failed: string[] = [];
    let divine = 0;
    let firstError = '';
    const enc = encodeURIComponent(league);
    const jobs: (() => Promise<void>)[] = [];
    for (const type of EXCHANGE) {
      jobs.push(() =>
        (async () => {
          const r = await this.fetcher(`${ninjaBase()}/economy/exchange/current/overview?league=${enc}&type=${type}`);
          if (!r.ok) {
            failed.push(type);
            return;
          }
          const j = (await r.json()) as ExchangeResponse;
          const names = new Map((j.items ?? []).map((i) => [i.id, i.name]));
          const rate = j.core?.rates?.divine;
          if (type === 'Currency' && rate && rate > 0) divine = 1 / rate;
          for (const l of j.lines ?? []) {
            const name = names.get(l.id);
            if (name && typeof l.primaryValue === 'number') byName[name] = { chaos: l.primaryValue, category: type };
          }
        })().catch((e: unknown) => {
          firstError = firstError || (e instanceof Error ? e.message : String(e));
          failed.push(type);
        }),
      );
    }
    for (const type of STASH) {
      jobs.push(() =>
        (async () => {
          const r = await this.fetcher(`${ninjaBase()}/economy/stash/current/item/overview?league=${enc}&type=${type}`);
          if (!r.ok) {
            failed.push(type);
            return;
          }
          const j = (await r.json()) as StashResponse;
          const isUnique = type.startsWith('Unique');
          if (isUnique) {
            const folded = foldUniqueLines(j.lines ?? []);
            for (const [name, v] of folded.byName) {
              const cur = byName[name];
              if (!cur || v > cur.chaos) byName[name] = { chaos: v, category: type };
            }
            for (const [base, v] of folded.byBase) {
              if (v > (uniqueByBase[base] ?? 0)) {
                uniqueByBase[base] = v;
                const n = folded.baseName.get(base);
                if (n) uniqueByBaseName[base] = n;
              }
            }
            return;
          }
          // Gems, cluster jewels, maps: the variant players usually meet, not the dearest one.
          for (const [name, v] of foldVariantPrices(j.lines ?? [])) {
            const cur = byName[name];
            if (!cur || v > cur.chaos) byName[name] = { chaos: v, category: type };
          }
        })().catch((e: unknown) => {
          firstError = firstError || (e instanceof Error ? e.message : String(e));
          failed.push(type);
        }),
      );
    }
    // A few at a time, so the site is not hit with 27 requests at once.
    let next = 0;
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        while (next < jobs.length) await jobs[next++]!();
      }),
    );
    if (Object.keys(byName).length === 0) throw new Error(`poe.ninja returned no prices for any category${firstError ? `: ${firstError}` : '.'}`);
    return { league, fetchedAt: this.now(), source: 'poe.ninja', divine: divine || 0, byName, uniqueByBase, uniqueByBaseName, failed: failed.sort() };
  }
}

export function ensureCacheDir(file: string): Promise<string | undefined> {
  return mkdir(dirname(file), { recursive: true });
}
