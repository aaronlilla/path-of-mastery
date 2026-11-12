/**
 * A stand-in for the trade site's search and fetch endpoints: a `fetch` that answers in the site's real response
 * shapes (headers included), used by the dev switch POM_WEALTH_SAMPLE=1 and by tests. The real trade client runs
 * against it, so the rate limiter, the 429 and 403 handling and the parsing are the shipped code. It never touches
 * the network. Listings are generated from the search itself (its category, name and modifier filters), so a search
 * for "life and resistances on a ring" returns rings with life and resistances.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TradeItem } from '../../shared/wealthTrade.js';

export type SampleTradeMode = 'ok' | 'expired' | 'rate-limited' | 'down' | 'empty' | 'slow';

export interface SampleTradeOptions {
  now: () => number;
  /** Trade stat id to its template text ("explicit.stat_1" to "+# to maximum Life"). */
  statText: (id: string) => string | undefined;
  /** Base names by trade category, from the game's item bases. */
  basesFor: (category: string) => string[];
  /** Item for a named unique: the worn one with every roll scaled by `factor` (1.03 to 1.15), when it is known. */
  unique?: (name: string, base: string, factor: number) => TradeItem | null;
  /**
   * Items worn in the slots that were scanned. When given, a rare search lists the worn base with its implicits and its other
   * mods (re-rolled a little), and every listing carries a couple of common mods besides the searched ones, as the real market
   * does; without it (tests) a listing is a random base with only the searched mods.
   */
  worn?: () => TradeItem[];
  mode?: SampleTradeMode;
  retryAfter?: number;
}

export interface SampleTradeFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  mode: SampleTradeMode;
  log: string[];
}

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

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const HEADERS = { 'x-rate-limit-policy': 'trade-search-request-limit', 'x-rate-limit-rules': 'Ip', 'x-rate-limit-ip': '8:10:60,15:60:120,60:300:1800', 'x-rate-limit-ip-state': '1:10:0,1:60:0,1:300:0' };
const FETCH_HEADERS = { 'x-rate-limit-policy': 'trade-fetch-request-limit', 'x-rate-limit-rules': 'Ip', 'x-rate-limit-ip': '12:4:60,16:12:60', 'x-rate-limit-ip-state': '1:4:0,1:12:0' };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Filter {
  id: string;
  min?: number;
}

function filtersOf(query: Record<string, unknown>): Filter[] {
  const groups = (query.stats as { filters?: { id: string; value?: { min?: number } }[] }[] | undefined) ?? [];
  return groups.flatMap((g) => (g.filters ?? []).map((f) => ({ id: f.id, ...(f.value?.min !== undefined ? { min: f.value.min } : {}) })));
}

/** A mod line with its numbers taken out, to tell whether two lines are the same mod. */
const shape = (t: string): string => t.replace(/[+-]?\d+(?:\.\d+)?/g, '#').trim().toLowerCase();
/** Common rolls a listing carries besides the searched ones (template, low, high). */
const EXTRA: Array<[string, number, number]> = [
  ['+# to maximum Life', 40, 90], ['+#% to Fire Resistance', 20, 45], ['+#% to Cold Resistance', 20, 45], ['+#% to Lightning Resistance', 20, 45],
  ['+#% to Chaos Resistance', 10, 30], ['+# to Strength', 15, 45], ['+# to Dexterity', 15, 45], ['+# to Intelligence', 15, 45],
];

/** Fills a template like "+# to maximum Life" with a number. */
let k = 0;
const fill = (tpl: string, n: number): string => ((k = 0), tpl.replace(/#/g, () => String(k++ === 0 ? n : Math.round(n * 1.5))));

const NAME_FIRST = ['Doom', 'Gale', 'Grim', 'Rune', 'Bone', 'Storm'];
const NAME_LAST: Array<[RegExp, string[]]> = [
  [/ring/, ['Loop', 'Coil', 'Band', 'Twirl', 'Circle', 'Knot']],
  [/belt/, ['Cord', 'Sash', 'Girdle', 'Binding', 'Wrap', 'Clasp']],
  [/amulet/, ['Mark', 'Charm', 'Pendant', 'Talisman', 'Locket', 'Choker']],
  [/glove/, ['Grip', 'Wraps', 'Mitts', 'Clutch', 'Fists', 'Hold']],
  [/boot/, ['Stride', 'Treads', 'Step', 'Tread', 'Pace', 'Track']],
];

/** A rare's name the way the game names it for its slot: a belt is a Cord or a Sash, never a Loop. */
export function sampleItemName(category: string, i: number): string {
  const last = NAME_LAST.find(([re]) => re.test(category.toLowerCase()))?.[1] ?? ['Loop', 'Coil', 'Grip', 'Mark', 'Knot', 'Twirl'];
  return `${NAME_FIRST[i % 6]!} ${last[(i + 2) % 6]!}`;
}

export function sampleTradeFetch(o: SampleTradeOptions): SampleTradeFetch {
  const searches = new Map<string, { ids: string[]; items: Map<string, { item: TradeItem; chaos: number; indexed: number; seller: string }> }>();
  const f = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    f.log.push(`${init?.method ?? 'GET'} ${url.replace(/^https:\/\/www\.pathofexile\.com/, '')}`);
    if (f.mode === 'down') return new Response('bad gateway', { status: 502 });
    if (f.mode === 'expired') return new Response('forbidden', { status: 403 });
    if (f.mode === 'rate-limited') return new Response('slow down', { status: 429, headers: { 'retry-after': String(o.retryAfter ?? 90), ...HEADERS } });
    const search = /\/api\/trade\/search\/(?:[a-z]+\/)?([^/?]+)$/.exec(url);
    if (search && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { query: Record<string, unknown> };
      const league = decodeURIComponent(search[1]!);
      const id = 'q' + hash(JSON.stringify(body.query) + league).toString(36);
      if (f.mode === 'empty') return json({ id, result: [], total: 0 }, 200, HEADERS);
      if (!searches.has(id)) searches.set(id, build(id, body.query));
      const s = searches.get(id)!;
      return json({ id, complexity: 4, result: s.ids, total: 40 + (hash(id) % 200) }, 200, HEADERS);
    }
    const fetchM = /\/api\/trade\/fetch\/([^?]+)\?query=([^&]+)/.exec(url);
    if (fetchM) {
      const s = searches.get(decodeURIComponent(fetchM[2]!));
      if (!s) return json({ error: { code: 2, message: 'Query not found' } }, 400);
      const ids = decodeURIComponent(fetchM[1]!).split(',');
      const now = o.now();
      return json(
        {
          result: ids.map((id) => {
            const e = s.items.get(id);
            if (!e) return null;
            const div = e.chaos >= 800;
            return {
              id,
              listing: {
                method: 'psapi',
                indexed: new Date(e.indexed).toISOString(),
                stash: { name: '~price', x: 3, y: 1 },
                whisper: `@${e.seller} Hi, I would like to buy your ${e.item.name || e.item.typeLine} listed for ${div ? Math.round(e.chaos / 400) : e.chaos} ${div ? 'divine' : 'chaos'} in Allflame (stash tab "~price"; position: left 4, top 2)`,
                account: { name: e.seller, online: hash(id) % 3 === 0 ? null : { league: 'Allflame' }, lastCharacterName: e.seller + 'X', language: 'en_US' },
                price: { type: '~price', amount: div ? Math.max(1, Math.round(e.chaos / 400)) : e.chaos, currency: div ? 'divine' : 'chaos' },
              },
              item: e.item,
            };
          }),
          _at: now,
        },
        200,
        FETCH_HEADERS,
      );
    }
    return json({ error: { message: 'Not found' } }, 404);
  }) as SampleTradeFetch;
  f.mode = o.mode ?? 'ok';
  f.log = [];

  function build(queryId: string, query: Record<string, unknown>) {
    const rand = rng(hash(queryId));
    const items = new Map<string, { item: TradeItem; chaos: number; indexed: number; seller: string }>();
    const ids: string[] = [];
    const cat = (((query.filters as Record<string, { filters?: { category?: { option?: string } } }> | undefined)?.type_filters?.filters?.category?.option) as string | undefined) ?? '';
    const mods = filtersOf(query).map((m) => ({ tpl: o.statText(m.id), min: m.min }));
    const name = typeof query.name === 'string' ? query.name : '';
    const type = typeof query.type === 'string' ? query.type : '';
    const bases = type ? [type] : o.basesFor(cat);
    const now = o.now();
    for (let i = 0; i < 24; i++) {
      const wornHere = !name && o.worn ? (o.worn().find((w) => bases.includes(w.baseType ?? w.typeLine)) ?? null) : null;
      const base = wornHere ? (wornHere.baseType ?? wornHere.typeLine) : (bases[Math.floor(rand() * bases.length)] ?? 'Coral Ring');
      let item: TradeItem | null = name ? (o.unique?.(name, base, 1.08 + rand() * 0.22) ?? null) : null;
      let score = 0;
      if (!item) {
        const lines: string[] = [];
        for (const m of mods) {
          if (!m.tpl || rand() < 0.08) continue;
          const lo = m.min ?? 10;
          // The search asks for about 90% of the worn roll; listings land roughly 8 to 30% above the worn roll, which gives the 2 to 15% gains of a real upgrade rather than a different item.
          const v = Math.round(lo * (1.2 + rand() * 0.3));
          lines.push(fill(m.tpl.replace(/^\+?/, m.tpl.startsWith('+') ? '+' : ''), v));
          score += v;
        }
        if (o.worn) {
          const asked = new Set(lines.map(shape));
          // the worn item's other mods, each re-rolled to 85-110% of the worn value
          for (const t of wornHere?.explicitMods ?? []) if (!asked.has(shape(t)) && lines.length < 6) { lines.push(t.replace(/\d+(?:\.\d+)?/g, (n) => String(Math.max(1, Math.round(Number(n) * (0.85 + rand() * 0.25)))))); asked.add(shape(t)); }
          // and a couple of common rolls, so a search result is never only what was asked for
          for (let j = 0; j < 2 && lines.length < 6; j++) {
            const [tpl, lo, hi] = EXTRA[Math.floor(rand() * EXTRA.length)]!;
            if (asked.has(shape(tpl))) continue;
            lines.push(fill(tpl, Math.round(lo + rand() * (hi - lo))));
            asked.add(shape(tpl));
          }
        }
        item = {
          id: `it${queryId}${i}`,
          name: name || sampleItemName(cat || base, i),
          typeLine: base,
          baseType: base,
          frameType: name ? 3 : 2,
          ilvl: 76 + Math.floor(rand() * 10),
          identified: true,
          icon: '',
          ...(wornHere?.implicitMods?.length ? { implicitMods: wornHere.implicitMods } : {}),
          explicitMods: lines,
        };
      }
      const ilvlBonus = item.ilvl ?? 80;
      const chaos = Math.max(2, Math.round((score + ilvlBonus / 2) * (0.6 + rand() * 1.8) * 1.4 + i * 6));
      const id = 'L' + queryId + String(i).padStart(2, '0');
      ids.push(id);
      items.set(id, { item, chaos, indexed: now - Math.round((2 + rand() * 120) * 60000), seller: ['Kaeli', 'Voss', 'Mirren', 'Tolbek', 'Anwen'][i % 5]! + String(100 + (i * 37) % 800) });
    }
    ids.sort((a, b) => items.get(a)!.chaos - items.get(b)!.chaos);
    return { ids, items };
  }
  return f;
}

/** The trade stat texts by id and the bases by category, read from the app's own data. */
export function sampleDataFrom(tradeStats: Record<string, Record<string, string>>, engineDataDir: string | undefined): Pick<SampleTradeOptions, 'statText' | 'basesFor'> {
  const byId = new Map<string, string>();
  for (const group of Object.values(tradeStats)) for (const [tpl, id] of Object.entries(group)) if (!byId.has(id)) byId.set(id, tpl);
  let bases: Record<string, { type: string }> = {};
  try {
    bases = JSON.parse(readFileSync(join(engineDataDir ?? 'engine-data', 'data_itemBases.json'), 'utf8'));
  } catch {
    /* no game data: the fallbacks below are used */
  }
  const TYPE: Record<string, string[]> = {
    'accessory.ring': ['Ring'],
    'accessory.amulet': ['Amulet'],
    'accessory.belt': ['Belt'],
    'armour.chest': ['Body Armour'],
    'armour.helmet': ['Helmet'],
    'armour.gloves': ['Gloves'],
    'armour.boots': ['Boots'],
    'armour.shield': ['Shield'],
    'armour.quiver': ['Quiver'],
    'weapon.onesword': ['One Handed Sword'],
    'weapon.twosword': ['Two Handed Sword'],
    'weapon.oneaxe': ['One Handed Axe'],
    'weapon.twoaxe': ['Two Handed Axe'],
    'weapon.onemace': ['One Handed Mace', 'Sceptre'],
    'weapon.twomace': ['Two Handed Mace'],
    'weapon.bow': ['Bow'],
    'weapon.staff': ['Staff'],
    'weapon.wand': ['Wand'],
    'weapon.dagger': ['Dagger'],
    'weapon.claw': ['Claw'],
    'weapon.sceptre': ['Sceptre'],
  };
  const fallback: Record<string, string[]> = { 'accessory.ring': ['Coral Ring', 'Two-Stone Ring', 'Vermillion Ring'], 'accessory.amulet': ['Onyx Amulet'], 'accessory.belt': ['Stygian Vise', 'Leather Belt'], 'armour.chest': ['Astral Plate'], 'armour.helmet': ['Eternal Burgonet'], 'armour.gloves': ['Spiked Gloves'], 'armour.boots': ['Titan Greaves'] };
  return {
    statText: (id) => byId.get(id),
    basesFor: (cat) => {
      const types = TYPE[cat] ?? (cat.startsWith('weapon.') ? ['One Handed Sword', 'Bow', 'Staff', 'Wand'] : []);
      const list = Object.entries(bases).filter(([, b]) => types.includes(b.type)).map(([n]) => n);
      return list.length ? list : (fallback[cat] ?? ['Coral Ring']);
    },
  };
}
