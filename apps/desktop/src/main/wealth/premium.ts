/**
 * Upgrade watch behind the Wealth service: state on disk (watch rules, last scans), and the calls
 * the renderer and the assistant make. Nothing here writes to the stash, lists, buys or whispers.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { TradeStats } from '../../renderer/items/tradeQuery.js';
import type { ItemInfo } from '@pom/protocol';
import { fmtChaos, type StashRow, type StrategyView, type SessionView } from '../../shared/wealth.js';
import { defaultRule, sellerPrice, upgradeAlertText, type TradeListing, type UpgradePrefs, type BuildSlotInfo, type SlotScan, type TradeFailure, type TradeSearchOutcome, type UpgradeScanInput, type UpgradeView, type WatchedBuild, type WatchRule } from '../../shared/wealthTrade.js';
import { readEquipped } from '../assistant/buildReaders.js';
import { UpgradePoller } from './upgradePoller.js';
import type { PriceBook } from './priceBook.js';
import type { TradeSearcher } from './trade.js';
import { openScratch, scanSlot, slotsOf, SLOT_ORDER, type UpgradeEngine } from './upgrades.js';

interface Saved {
  rules: Record<string, Record<string, WatchRule>>;
  scans: Record<string, Record<string, SlotScan>>;
  scannedAt: Record<string, number>;
  /** What the background checks need to scan a build again without the screen open. */
  builds: Record<string, { name: string; xml: string; rank: 'dps' | 'ehp' }>;
  prefs: UpgradePrefs;
}

export interface PremiumDeps {
  dir: string;
  book: PriceBook;
  searcher: TradeSearcher;
  now: () => number;
  league: () => string;
  stats: () => Promise<TradeStats>;
  rows: () => StashRow[];
  sessions: () => SessionView[];
  strategies: () => Promise<StrategyView[]>;
  networth: () => number;
  /** Item to search comparable listings for, written as trade-site terms. */
  publish: () => void;
  /** Passes what is worn in a searched slot on (the sample trade site uses it). */
  noteWorn?: (item: ItemInfo) => void;
  /** Tells the bell an upgrade match turned up. */
  /** Desktop notification (Electron), raised only for background finds when the player has it on. */
  osNotify?: (e: { title: string; body: string; listing?: TradeListing }) => void;
  /** False when the machine is idle, locked or asleep. */
  active?: () => boolean;
  /** True with a working session cookie. */
  ready?: () => boolean;
  /** Tells the bell an upgrade match turned up. */
  notify?: (e: { title: string; body: string; go: { sub: string; patch?: Record<string, unknown>; build?: string } }) => void;
}

const MAX_SCAN_KEEP = 12;

export class Premium {
  private saved: Saved = { rules: {}, scans: {}, scannedAt: {}, builds: {}, prefs: { poll: true, os: true } };
  private manual = 0;
  private polling = false;
  readonly poller: UpgradePoller;
  private loaded: Promise<void>;
  private engine: UpgradeEngine | null = null;

  constructor(private readonly d: PremiumDeps) {
    this.poller = new UpgradePoller({
      now: d.now,
      enabled: () => this.saved.prefs.poll,
      active: () => d.active?.() ?? true,
      ready: () => d.ready?.() ?? true,
      busy: () => this.manual > 0,
      builds: () => Object.keys(this.saved.builds).filter((k) => this.hasLiveSlot(k)).map((key) => ({ key, scannedAt: this.saved.scannedAt[key] ?? null })),
      resumesAt: () => d.searcher.status().resumesAt,
      scan: async (key) => {
        const b = this.saved.builds[key]!;
        this.polling = true;
        try {
          const r = await this.scan({ buildKey: key, buildXml: b.xml, name: b.name, rank: b.rank });
          return r.ok ? { ok: true } : { ok: false, kind: r.kind, message: r.message };
        } finally {
          this.polling = false;
        }
      },
    });
    this.loaded = readFile(join(d.dir, 'upgrades.json'), 'utf8').then(
      (t) => void (this.saved = { ...this.saved, ...(JSON.parse(t) as Partial<Saved>) }),
      () => undefined,
    );
  }

  attachEngine(e: UpgradeEngine): void {
    this.engine = e;
  }

  private saving: Promise<void> = Promise.resolve();

  /** Saves run one at a time: the poller and a player action can save at once, and on Windows two renames onto
   *  upgrades.json at the same moment fail (EPERM). Each save writes the state as it is when its turn comes. */
  private persist(): Promise<void> {
    const run = this.saving.then(async () => {
      await mkdir(this.d.dir, { recursive: true });
      const p = join(this.d.dir, 'upgrades.json');
      const tmp = `${p}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.saved), 'utf8');
      await rename(tmp, p);
    });
    this.saving = run.catch(() => undefined);
    return run;
  }

  private hasLiveSlot(key: string): boolean {
    const b = this.saved.builds[key];
    return !!b && slotsOf(b.xml).some((s) => !this.saved.rules[key]?.[s.slot]?.off);
  }

  /** One turn of the background checks (the service calls it every 20 s). */
  async pollTick(): Promise<void> {
    await this.loaded;
    await this.poller.tick();
  }

  async setPrefs(patch: Partial<UpgradePrefs>): Promise<void> {
    await this.loaded;
    this.saved.prefs = { ...this.saved.prefs, ...(typeof patch.poll === 'boolean' ? { poll: patch.poll } : {}), ...(typeof patch.os === 'boolean' ? { os: patch.os } : {}) };
    await this.persist();
    this.d.publish();
  }

  // ---- Upgrade watch -----------------------------------------------------------------------------------------

  async upgradeView(buildKey: string, xml: string): Promise<UpgradeView> {
    await this.loaded;
    const slots: BuildSlotInfo[] = slotsOf(xml).sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
    const rules: Record<string, WatchRule> = {};
    for (const s of slots) rules[s.slot] = { ...defaultRule(), ...(this.saved.rules[buildKey]?.[s.slot] ?? {}) };
    return { slots, rules, scans: this.saved.scans[buildKey] ?? {}, scannedAt: this.saved.scannedAt[buildKey] ?? null, prefs: this.saved.prefs, poll: this.poller.status() };
  }

  /** Every build that has been checked, with its watched slots and how many open matches each has. */
  async watched(): Promise<WatchedBuild[]> {
    await this.loaded;
    return Object.entries(this.saved.scans).map(([key, scans]) => ({
      key,
      slots: Object.values(scans)
        .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))
        .map((sc) => {
          const rule = { ...defaultRule(), ...(this.saved.rules[key]?.[sc.slot] ?? {}) };
          return { slot: sc.slot, rule, matches: sc.candidates.filter((c) => !c.held && !c.sold && (c.main?.pct ?? -1) * 100 >= rule.minGainPct).length };
        }),
    }));
  }

  async setRule(buildKey: string, slot: string, patch: Partial<WatchRule>): Promise<void> {
    await this.loaded;
    const cur = { ...defaultRule(), ...(this.saved.rules[buildKey]?.[slot] ?? {}) };
    const next: WatchRule = { ...cur, ...patch };
    next.minGainPct = Math.max(0, Math.min(200, Number(next.minGainPct) || 0));
    next.budgetDiv = next.budgetDiv === null || !(Number(next.budgetDiv) > 0) ? null : Number(next.budgetDiv);
    (this.saved.rules[buildKey] ??= {})[slot] = next;
    await this.persist();
  }

  /** "Not this base": the base is left out of later scans, and the match leaves the list. */
  async dismiss(buildKey: string, slot: string, key: string, why: 'base' | 'price'): Promise<void> {
    await this.loaded;
    const scan = this.saved.scans[buildKey]?.[slot];
    const c = scan?.candidates.find((x) => x.key === key);
    if (!scan || !c) return;
    const cur = { ...defaultRule(), ...(this.saved.rules[buildKey]?.[slot] ?? {}) };
    if (why === 'base') cur.badBases = [...new Set([...cur.badBases, c.listing.item.baseType ?? c.listing.item.typeLine])];
    else if (c.priceChaos !== null) cur.budgetDiv = Math.max(0.1, Math.floor((c.priceChaos / (this.d.book.divine || 370)) * 0.9 * 10) / 10);
    (this.saved.rules[buildKey] ??= {})[slot] = cur;
    scan.candidates = scan.candidates.filter((x) => x.key !== key);
    await this.persist();
  }

  /** Scans the slots of a build against live listings. Slots are scanned one after another (the limiter spaces them). */
  async scan(input: UpgradeScanInput): Promise<{ ok: true; view: UpgradeView } | TradeFailure | { ok: false; kind: 'engine'; message: string }> {
    await this.loaded;
    if (!this.engine) return { ok: false, kind: 'engine', message: 'The calculation engine is not available, so gains cannot be calculated.' };
    // Remember the build so the background checks can scan it again with the screen closed.
    this.saved.builds[input.buildKey] = { name: input.name, xml: input.buildXml, rank: input.rank ?? 'dps' };
    const background = this.polling;
    if (!background) this.manual++;
    try {
      return await this.scanSlots(input, background);
    } finally {
      if (!background) this.manual--;
    }
  }

  private async scanSlots(input: UpgradeScanInput, background: boolean): ReturnType<Premium['scan']> {
    const engine = this.engine!;
    const stats = await this.d.stats();
    const equipped = readEquipped(input.buildXml);
    const wanted = new Set(input.slots ?? slotsOf(input.buildXml).map((s) => s.slot));
    const scratch = await openScratch(engine, input.buildXml);
    let failure: TradeFailure | null = null;
    try {
      for (const e of equipped) {
        if (!wanted.has(e.slot)) continue;
        const rule = { ...defaultRule(), ...(this.saved.rules[input.buildKey]?.[e.slot] ?? {}) };
        if (rule.off) continue;
        const scan = await scanSlot(
          { engine, searcher: this.d.searcher, book: this.d.book, now: this.d.now, stats, league: this.d.league, ...(this.d.noteWorn ? { noteWorn: this.d.noteWorn } : {}) },
          scratch,
          e,
          { rule, rank: input.rank ?? 'dps', limit: Math.min(10, input.limit ?? 10), divine: this.d.book.divine || 370 },
        );
        const prev = this.saved.scans[input.buildKey]?.[e.slot];
        if (scan.error && prev) {
          // A failed scan keeps the last good one on screen with the error beside it.
          (this.saved.scans[input.buildKey] ??= {})[e.slot] = { ...prev, error: scan.error };
        } else {
          // Listings that were there last time and are gone now are struck through as sold or removed.
          const now = new Set(scan.candidates.map((c) => c.key));
          // Only while the same item is worn and the same stat ranks: gains from another baseline would mislead.
          const same = !!prev && prev.rankStat === scan.rankStat && prev.equipped === scan.equipped && prev.equippedBase === scan.equippedBase;
          const gone = (same ? (prev?.candidates ?? []) : []).filter((c) => !now.has(c.key) && !c.held).map((c) => ({ ...c, sold: true }));
          scan.candidates = [...scan.candidates, ...gone].slice(0, MAX_SCAN_KEEP);
          (this.saved.scans[input.buildKey] ??= {})[e.slot] = scan;
          // A match that was not in the last scan is news: the bell says so, and its button opens that very match.
          const seen = new Set((prev?.candidates ?? []).map((c) => c.key));
          const fresh = scan.candidates.find((c) => !seen.has(c.key) && !c.sold && !c.held && !c.overBudget && (c.main?.pct ?? -1) * 100 >= rule.minGainPct);
          if (fresh && this.d.notify) {
            const price = fresh.priceChaos !== null ? fmtChaos(fresh.priceChaos, this.d.book.divine || 370) : sellerPrice(fresh.listing.price);
            const gain = fresh.main?.pct != null ? `${scan.rankLabel} +${(fresh.main.pct * 100).toFixed(1)}%` : scan.rankLabel;
            if (background && this.saved.prefs.os) {
              const t = upgradeAlertText({ item: fresh.listing.item.name || fresh.listing.item.typeLine, price, rankLabel: scan.rankLabel, pct: fresh.main?.pct ?? null, hasHideoutToken: !!fresh.listing.hideoutToken });
              this.d.osNotify?.({ ...t, listing: fresh.listing });
            }
            this.d.notify({ title: `Upgrade listed for ${input.name}`, body: `${fresh.listing.item.name || fresh.listing.item.typeLine} · ${e.slot} · ${gain} · ${price}`, go: { sub: 'watch', patch: { wsel: fresh.key }, build: input.buildKey } });
          }
        }
        if (scan.error && (scan.error.kind === 'expired' || scan.error.kind === 'rate-limited' || scan.error.kind === 'no-cookie' || scan.error.kind === 'down')) {
          failure = { ok: false, kind: scan.error.kind as TradeFailure['kind'], message: scan.error.message };
          break;
        }
      }
    } finally {
      await scratch.close();
    }
    this.saved.scannedAt[input.buildKey] = this.d.now();
    await this.persist();
    this.d.publish();
    if (failure) return failure;
    return { ok: true, view: await this.upgradeView(input.buildKey, input.buildXml) };
  }

  /** A raw search for the assistant: listings with prices and ages. */
  async search(query: unknown, limit: number): Promise<{ ok: true; outcome: TradeSearchOutcome } | TradeFailure> {
    return this.d.searcher.search(query, { limit });
  }

}
