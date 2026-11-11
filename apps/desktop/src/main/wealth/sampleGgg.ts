/**
 * A stand-in for pathofexile.com used by the dev switch (POM_WEALTH_SAMPLE=1) and by tests.
 *
 * It answers with the same shapes the character-window routes use (tab list with `n/i/id/type/colour`, items in GGG's
 * Item object form), built from real item names in the price book so every row prices. It also plays: `advance()`
 * runs a map (uses a map, a scarab and an orb; loot arrives), a boss, a craft or a sale, which is how sessions fill in
 * without a real account. Not for shipping decisions: the real endpoint's exact fields are verified with a real cookie.
 */
import { GggError, type GggApi, type RawCharacter, type RawTab, type StashPage } from './ggg.js';
import type { GggItem, PriceBook } from './priceBook.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgb = (r: number, g: number, b: number) => ({ r, g, b });

export const SAMPLE_ACCOUNT = 'Kaelen#4821';
export const SAMPLE_CHARACTER = 'KaelenBoneshatter';

export type Activity = 'map' | 'boss' | 'craft' | 'sale';

/** Currency the game stacks to 20 (the rest of the sample's currency stacks to 10). */
const STACK_20 = new Set(['Chaos Orb', 'Divine Orb', 'Exalted Orb', 'Stacked Deck', 'Orb of Annulment', 'Orb of Alteration', 'Chromatic Orb']);

export class SampleGgg implements GggApi {
  readonly tabs: RawTab[] = [
    { n: 'Currency', i: 0, id: 'tab-cur', type: 'CurrencyStash', colour: rgb(240, 192, 104) },
    { n: 'Fragments', i: 1, id: 'tab-frag', type: 'FragmentStash', colour: rgb(91, 143, 224) },
    { n: 'Scarabs', i: 2, id: 'tab-scar', type: 'NormalStash', colour: rgb(111, 220, 140) },
    { n: 'Dump 1', i: 3, id: 'tab-d1', type: 'PremiumStash', colour: rgb(143, 134, 118) },
    { n: 'Dump 3', i: 4, id: 'tab-d3', type: 'QuadStash', colour: rgb(143, 134, 118) },
    { n: 'Essence', i: 5, id: 'tab-ess', type: 'EssenceStash', colour: rgb(180, 138, 216) },
    { n: 'Uniques', i: 6, id: 'tab-uniq', type: 'NormalStash', colour: rgb(199, 112, 58) },
    { n: 'Map stock', i: 7, id: 'tab-maps', type: 'NormalStash', colour: rgb(224, 96, 74) },
    { n: 'Atlas maps', i: 8, id: 'tab-atlas', type: 'MapStash', colour: rgb(224, 96, 74) },
    { n: 'Heist locker', i: 9, id: 'tab-heist', type: 'HeistLocker', colour: rgb(132, 125, 112) },
    { n: 'Trade 1', i: 10, id: 'tab-trade', type: 'NormalStash', colour: rgb(132, 125, 112) },
    { n: 'Remove-only', i: 11, id: 'tab-rm', type: 'RemoveOnlyStash', colour: rgb(132, 125, 112) },
  ];
  readonly stash: Record<string, GggItem[]> = {};
  inventory: GggItem[] = [];
  /** Requests answered, for tests. */
  readonly log: string[] = [];
  /** Set to make every call fail the way pathofexile.com does. */
  failWith: { kind: 'expired' | 'rate-limited' | 'down' | 'private'; retryAfter?: number } | null = null;
  private rand: () => number;
  private uid = 1;

  constructor(
    private readonly book: PriceBook,
    seed = 7,
    restore: Record<string, GggItem[]> = {},
  ) {
    this.rand = rng(seed);
    this.fill();
    // After a restart the stash picks up where the saved one left off, so nothing looks like it was lost.
    for (const [k, v] of Object.entries(restore)) {
      if (k.startsWith('char:')) this.inventory = v;
      else if (k in this.stash) this.stash[k] = v;
    }
    this.uid = 100000;
  }

  // ---- items ----

  private id(): string {
    return `item-${this.uid++}`;
  }

  cur(name: string, qty: number, max = STACK_20.has(name) ? 20 : 10, frame = 5): GggItem {
    return { id: this.id(), typeLine: name, baseType: name, frameType: frame, stackSize: qty, maxStackSize: max, identified: true, inventoryId: 'Stash1', x: 0, y: 0, w: 1, h: 1 };
  }

  private frag(name: string, qty: number, max = 100): GggItem {
    return this.cur(name, qty, max, 0);
  }

  private card(name: string, qty: number, max = 10): GggItem {
    return this.cur(name, qty, max, 6);
  }

  private unique(name: string, base: string): GggItem {
    return { id: this.id(), name, typeLine: base, baseType: base, frameType: 3, identified: true, ilvl: 84, inventoryId: 'Stash1', x: 0, y: 0, w: 1, h: 1 };
  }

  private gem(name: string, level: number, quality: number, corrupted: boolean): GggItem {
    return {
      id: this.id(),
      typeLine: name,
      baseType: name,
      frameType: 4,
      identified: true,
      corrupted,
      properties: [{ name: 'Level', values: [[String(level), 0]] }, { name: 'Quality', values: [[`+${quality}%`, 1]] }],
      inventoryId: 'Stash1',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    };
  }

  private rare(name: string, base: string, ilvl: number, influence?: string): GggItem {
    return { id: this.id(), name, typeLine: base, baseType: base, frameType: 2, identified: true, ilvl, ...(influence ? { influences: { [influence]: true } } : {}), inventoryId: 'Stash1', x: 0, y: 0, w: 1, h: 1 };
  }

  private map(name: string, tier: number, qty: number): GggItem {
    return { id: this.id(), typeLine: name, baseType: name, frameType: 0, stackSize: qty, maxStackSize: 1, identified: true, properties: [{ name: 'Map Tier', values: [[String(tier), 0]] }], inventoryId: 'Stash1', x: 0, y: 0, w: 1, h: 1 };
  }

  private pick(type: string, n: number, lo: number, hi: number): string[] {
    const names = this.book.all().filter((l) => l.type === type && l.chaos >= lo && l.chaos <= hi).map((l) => l.name);
    const out: string[] = [];
    for (let i = 0; i < n && names.length; i++) out.push(names.splice(Math.floor(this.rand() * names.length), 1)[0] as string);
    return out;
  }

  private fill(): void {
    const e = this.book.lines.bind(this.book);
    const has = (n: string) => e(n).length > 0;
    this.stash['tab-cur'] = [
      this.cur('Chaos Orb', 2952, 20),
      this.cur('Divine Orb', 13, 20),
      this.cur('Exalted Orb', 21, 20),
      this.cur('Orb of Annulment', 14, 20),
      this.cur('Vaal Orb', 120),
      this.cur('Orb of Alteration', 800, 20),
      this.cur('Stacked Deck', 58, 20),
      this.cur('Chromatic Orb', 212, 20),
    ].filter((i) => has(i.typeLine));
    this.stash['tab-frag'] = [this.frag('Simulacrum Splinter', 212), this.frag("The Maven's Writ", 4, 1), this.frag('Timeless Templar Splinter', 85), this.frag('Timeless Vaal Splinter', 60)];
    const scarabs = ['Scarab of Wisps', 'Delirium Scarab of Paranoia', 'Legion Scarab of Eternal Conflict', 'Bestiary Scarab of Duplicating', 'Blight Scarab of Blooming', 'Divination Scarab of Plenty'];
    this.stash['tab-scar'] = scarabs.map((n, i) => this.frag(n, [17, 12, 8, 12, 9, 20][i] as number, 20));
    const infl = this.book.all().find((l) => l.type === 'BaseType' && l.variant === 'Elder' && (l.levelRequired ?? 0) >= 82 && l.chaos > 40);
    this.stash['tab-d1'] = [this.card('The Apothecary', 1), this.gem('Cyclone', 20, 20, false), this.gem('Cyclone', 21, 23, true), this.card('The Doctor', 1)];
    this.stash['tab-d3'] = [
      this.rare('Doom Loop', 'Vermillion Ring', 84),
      this.rare('Grim Grip', 'Spiked Gloves', 83),
      this.rare('Storm Twirl', 'Crystal Belt', 84),
      ...(infl ? [this.rare('Elder Edge', infl.baseType ?? infl.name, 86, 'elder')] : []),
    ];
    this.stash['tab-ess'] = [this.cur('Deafening Essence of Scorn', 12, 9, 0), this.cur('Shrieking Essence of Spite', 9, 9, 0), this.cur('Essence of Horror', 3, 9, 0)];
    this.stash['tab-uniq'] = [this.unique('Headhunter', 'Leather Belt'), this.unique('Aegis Aurora', 'Champion Kite Shield'), this.unique('The Taming', 'Two-Stone Ring'), this.unique('Mageblood', 'Heavy Belt')].filter((i) => has(i.name ?? ''));
    this.stash['tab-maps'] = [this.map('Strand Map', 16, 40)];
    this.stash['tab-atlas'] = [];
    this.stash['tab-heist'] = [];
    this.stash['tab-trade'] = [this.cur('Divine Orb', 3)];
    this.stash['tab-rm'] = [];
    this.inventory = [this.cur('Chaos Orb', 140), this.frag('Simulacrum Splinter', 22)];
    void this.pick;
  }

  // ---- playing ----

  private add(items: GggItem[], name: string, qty: number, mk: (n: string, q: number) => GggItem): void {
    if (qty <= 0) return;
    const ex = items.find((i) => i.typeLine === name);
    if (ex) ex.stackSize = (ex.stackSize ?? 1) + qty;
    else items.push(mk(name, qty));
  }

  private take(items: GggItem[], name: string, qty: number): void {
    const ex = items.find((i) => i.typeLine === name);
    if (!ex) return;
    ex.stackSize = Math.max(0, (ex.stackSize ?? 1) - qty);
    if (!ex.stackSize) items.splice(items.indexOf(ex), 1);
  }

  /** One step of play. */
  advance(kind: Activity): void {
    const r = this.rand;
    if (kind === 'map') {
      if (((this.stash['tab-maps']![0]?.stackSize) ?? 0) < 4) this.stash['tab-maps']!.length = 0;
      this.add(this.stash['tab-maps']!, 'Strand Map', this.stash['tab-maps']!.length ? 0 : 40, (n, q) => this.map(n, 16, q));
      this.take(this.stash['tab-maps']!, 'Strand Map', 2);
      if (r() < 0.5) this.take(this.stash['tab-scar']!, 'Scarab of Wisps', 1);
      if (r() < 0.5) this.take(this.stash['tab-scar']!, 'Delirium Scarab of Paranoia', 1);
      this.add(this.stash['tab-maps']!, 'Strand Map', r() < 0.15 ? 1 : 0, (n, q) => this.map(n, 16, q));
      const cur = this.stash['tab-cur']!;
      this.add(cur, 'Chaos Orb', 24 + Math.floor(r() * 50), (n, q) => this.cur(n, q));
      if (r() < 0.45) this.add(cur, 'Divine Orb', 1, (n, q) => this.cur(n, q));
      if (r() < 0.5) this.add(cur, 'Stacked Deck', 1 + Math.floor(r() * 2), (n, q) => this.cur(n, q));
      if (r() < 0.25) this.add(cur, 'Orb of Annulment', 1, (n, q) => this.cur(n, q));
      this.add(this.stash['tab-frag']!, 'Simulacrum Splinter', 8 + Math.floor(r() * 14), (n, q) => this.frag(n, q));
      if (r() < 0.2) this.add(this.stash['tab-ess']!, 'Deafening Essence of Scorn', 1, (n, q) => this.cur(n, q, 9, 0));
    } else if (kind === 'boss') {
      this.take(this.stash['tab-frag']!, "The Maven's Writ", 1);
      this.take(this.stash['tab-cur']!, 'Chaos Orb', 40);
      this.add(this.stash['tab-d1']!, 'The Apothecary', r() < 0.03 ? 1 : 0, (n, q) => this.card(n, q));
      this.add(this.stash['tab-cur']!, 'Divine Orb', 2 + Math.floor(r() * 3), (n, q) => this.cur(n, q));
      this.add(this.stash['tab-cur']!, 'Chaos Orb', 120 + Math.floor(r() * 120), (n, q) => this.cur(n, q));
    } else if (kind === 'craft') {
      this.take(this.stash['tab-cur']!, 'Orb of Alteration', 120 + Math.floor(r() * 80));
      this.take(this.stash['tab-cur']!, 'Chaos Orb', 60 + Math.floor(r() * 40));
      this.take(this.stash['tab-cur']!, 'Vaal Orb', 4);
    } else if (kind === 'sale') {
      this.take(this.stash['tab-uniq']!, 'The Taming', 1);
      this.add(this.stash['tab-cur']!, 'Chaos Orb', 20, (n, q) => this.cur(n, q));
    }
  }

  // ---- the GGG client interface ----

  private fail(kind: 'expired' | 'rate-limited' | 'down' | 'private'): GggError {
    return new GggError(kind, 'sample failure', kind === 'rate-limited' ? (this.failWith?.retryAfter ?? 60) : undefined);
  }

  async stashTab(_account: string, _league: string, index: number, withTabs: boolean): Promise<StashPage> {
    this.log.push(`stash:${index}`);
    if (this.failWith && this.failWith.kind !== 'private') throw this.fail(this.failWith.kind);
    const tab = this.tabs.find((t) => t.i === index);
    if (!tab) throw new GggError('not-found', 'no such tab');
    const items = JSON.parse(JSON.stringify(this.stash[tab.id] ?? [])) as GggItem[];
    return { numTabs: this.tabs.length, ...(withTabs ? { tabs: JSON.parse(JSON.stringify(this.tabs)) as RawTab[] } : {}), items };
  }

  async characters(): Promise<RawCharacter[]> {
    this.log.push('characters');
    if (this.failWith) throw this.fail(this.failWith.kind);
    return [{ name: SAMPLE_CHARACTER, league: 'Allflame', class: 'Juggernaut', level: 96 }];
  }

  async characterItems(): Promise<{ items: GggItem[] }> {
    this.log.push('items');
    if (this.failWith) throw this.fail(this.failWith.kind);
    return { items: JSON.parse(JSON.stringify(this.inventory)) as GggItem[] };
  }

  resumesAt(): number | null {
    return null;
  }
}
