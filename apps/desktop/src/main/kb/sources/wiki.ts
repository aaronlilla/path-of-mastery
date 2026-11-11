import { decodeEntities } from './forum.js';
import type { EntityRow, KbSource, Pulled, SourceCtx } from './types.js';

/**
 * poewiki.net (community, CC BY-NC-SA 3.0; see NOTICE). Reached only through api.php with the bot User-Agent, one
 * request a second (PoliteHttp). robots.txt allows the API and disallows /index.php and Special: pages, so neither is
 * used. Cargo gives the unique items; page wikitext gives the rules the Journey tables need:
 *   vendor-recipes   "Vendor recipe system" page, one row per recipe bullet
 *   leveling-uniques Cargo `items`: uniques that drop at campaign levels
 *   resist-penalties "Resistance" page, the Part One / Part Two bullets
 *   xp-penalty       "Experience" page, the safe zone table
 * Pages are also stored as `mechanic` docs so search and getMechanic can answer from them. There is no wiki source for
 * life-floors, so that table is not written (Journey reads it as missing rather than invented).
 */

export const WIKI_API = 'https://www.poewiki.net/w/api.php';
export const WIKI_PAGE = 'https://www.poewiki.net/wiki/';
/** Campaign drops: monster levels up to the last act's areas. */
export const LEVELING_MAX_DROP_LEVEL = 68;

const enc = (o: Record<string, string>): string => '?' + Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

interface CargoResp {
  cargoquery?: Array<{ title: Record<string, string | null> }>;
  error?: { info?: string };
}

export async function cargoAll(ctx: SourceCtx, q: { tables: string; fields: string; where?: string }): Promise<Array<Record<string, string | null>>> {
  const rows: Array<Record<string, string | null>> = [];
  for (let offset = 0; ; offset += 500) {
    const url = WIKI_API + enc({ action: 'cargoquery', format: 'json', maxlag: '5', tables: q.tables, fields: q.fields, ...(q.where ? { where: q.where } : {}), limit: '500', offset: String(offset) });
    const { data } = await ctx.http.json<CargoResp>(url);
    if (data.error || !data.cargoquery) throw new Error(`wiki cargo ${q.tables}: ${data.error?.info ?? 'no result'}`);
    rows.push(...data.cargoquery.map((r) => r.title));
    if (data.cargoquery.length < 500) return rows;
  }
}

interface PageResp {
  query?: { pages?: Record<string, { title: string; missing?: string; revisions?: Array<{ timestamp?: string; slots?: { main?: { '*'?: string } } }> }> };
}

export async function pageText(ctx: SourceCtx, title: string): Promise<{ text: string; timestamp: string | null }> {
  const url = WIKI_API + enc({ action: 'query', format: 'json', maxlag: '5', prop: 'revisions', rvprop: 'content|timestamp', rvslots: 'main', titles: title });
  const { data } = await ctx.http.json<PageResp>(url);
  const page = Object.values(data.query?.pages ?? {})[0];
  const rev = page?.revisions?.[0];
  const text = rev?.slots?.main?.['*'];
  if (!page || page.missing !== undefined || typeof text !== 'string') throw new Error(`wiki page "${title}" not found`);
  return { text, timestamp: rev?.timestamp ?? null };
}

/** Wikitext to plain text: links, item-link templates, bold/italic marks, tags and other templates dropped. */
export function plainWiki(s: string): string {
  let t = decodeEntities(s);
  for (let i = 0; i < 4; i++) {
    t = t
      .replace(/\{\{(?:il|ii|c|mod|item link|gem link|cl)\|([^{}|]*)(?:\|[^{}]*)?\}\}/gi, '$1')
      .replace(/\{\{(?:Main|See also|For|Redirect|math)[^{}]*\}\}/gi, '');
  }
  return t
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Item names named by {{il|X}} links of a wikitext line. */
function itemNames(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\{\{(?:il|ii|item link)\|([^{}|]+)/gi)) out.push(m[1]!.trim());
  return [...new Set(out)];
}

export interface VendorRecipe {
  category: string;
  text: string;
  items: string[];
}

/** The bullets of the vendor recipe page, each under its == heading ==. */
export function parseVendorRecipes(wikitext: string): VendorRecipe[] {
  const out: VendorRecipe[] = [];
  let heading = '';
  for (const line of wikitext.split(/\r?\n/)) {
    const h = /^(={2,4})\s*([^=]+?)\s*\1\s*$/.exec(line);
    if (h) {
      heading = h[2]!;
      continue;
    }
    const b = /^\*+\s*(.+)$/.exec(line);
    if (!b || !heading) continue;
    const text = plainWiki(b[1]!);
    if (text.length < 8) continue;
    out.push({ category: heading, text, items: itemNames(b[1]!) });
  }
  return out;
}

/** "Completion of [[Part One]]: -30% to all resistances": Part One is act 5, Part Two act 10, so from act 6 and 11. */
export function parseResistPenalties(wikitext: string): Array<{ fromAct: number; penalty: number; source: string }> {
  const out: Array<{ fromAct: number; penalty: number; source: string }> = [];
  const afterAct: Record<string, number> = { one: 6, two: 11 };
  for (const m of wikitext.matchAll(/Completion of \[\[Part (One|Two)\]\]:\s*(-?\d+)%/gi)) {
    out.push({ fromAct: afterAct[m[1]!.toLowerCase()]!, penalty: -Math.abs(Number(m[2])), source: `poewiki Resistance: "Completion of Part ${m[1]}: ${m[2]}% to all resistances"` });
  }
  return out;
}

/** The safe zone table ("1-15 || 3" ... "96+ || 9") as level ranges. Cells may sit on one line or on two. */
export function parseXpSafeZone(wikitext: string): { fromLevel: number; toLevel: number; below: number; above: number }[] {
  const i = wikitext.search(/!\s*Level Range\s*!!\s*Safe Zone/i);
  if (i < 0) return [];
  const end = wikitext.indexOf('|}', i);
  const block = wikitext.slice(i, end < 0 ? undefined : end);
  const rows: { fromLevel: number; toLevel: number; below: number; above: number }[] = [];
  const lines = block.split('\n').map((l) => l.trim()).filter((l) => l && l !== '|-' && !l.startsWith('!'));
  const text = lines.map((l) => l.replace(/^\|\s*/, '')).join(' ; ');
  for (const m of text.matchAll(/(\d+)(?:-(\d+)|(\+))\s*(?:\|\||;)\s*(\d+)/g)) {
    const to = m[3] ? 100 : Number(m[2]);
    rows.push({ fromLevel: Number(m[1]), toLevel: to, below: Number(m[4]), above: Number(m[4]) });
  }
  return rows;
}

/** Game-mechanic pages stored as `mechanic` docs (the start of each page) so getMechanic can answer from them. */
const MECHANIC_PAGES = ['Righteous Fire', 'Lifetap Support', 'Ghost Reaver', 'Skill gem', 'Support gem', 'Item socket', 'Quality', 'Unique item', 'Leech', 'Allflame league', 'Curse of the Allflame', 'Chart', 'Voyage', 'Cursed Ducat'];
const PAGE_CHARS = 9000;

const statLines = (s: string | null): string[] => (s ? plainWiki(s).split('\n').map((l) => l.trim()).filter(Boolean) : []);

export const wikiSource: KbSource = {
  id: 'wiki',
  type: 'wiki',
  async pull(ctx): Promise<Pulled> {
    const fetchedAt = new Date().toISOString();
    const tables: NonNullable<Pulled['tables']> = {};
    const docs: EntityRow[] = [];
    const errors: string[] = [];
    const url = (title: string): string => WIKI_PAGE + title.replace(/ /g, '_');
    const doc = (title: string, text: string, ts: string | null, max = 60_000): void => {
      docs.push({ id: `wiki:${title}`, doc_kind: 'mechanic', title, version: null, posted_at: ts ? ts.slice(0, 10) : null, body: plainWiki(text).slice(0, max), data: { heading: title }, source_url: url(title) });
    };
    const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`);
        ctx.log(`wiki: ${name} failed: ${(e as Error).message}`);
      }
    };

    await step('vendor-recipes', async () => {
      const p = await pageText(ctx, 'Vendor recipe system');
      const rows = parseVendorRecipes(p.text);
      if (rows.length < 10) throw new Error(`only ${rows.length} recipes parsed`);
      tables['vendor-recipes'] = { data: rows, url: url('Vendor recipe system') };
      doc('Vendor recipe system', p.text, p.timestamp);
    });
    await step('resist-penalties', async () => {
      const p = await pageText(ctx, 'Resistance');
      const rows = parseResistPenalties(p.text);
      if (!rows.length) throw new Error('no penalty lines found');
      tables['resist-penalties'] = { data: rows, url: url('Resistance') };
      doc('Resistance', p.text, p.timestamp);
    });
    await step('xp-penalty', async () => {
      const p = await pageText(ctx, 'Experience');
      const ranges = parseXpSafeZone(p.text);
      if (ranges.length < 5) throw new Error(`only ${ranges.length} safe zone rows parsed`);
      const safeRange: { fromLevel: number; toLevel: number; below: number; above: number }[] = [];
      for (const r of ranges) for (let level = r.fromLevel; level <= r.toLevel; level++) safeRange.push({ fromLevel: level, toLevel: level, below: r.below, above: r.above });
      tables['xp-penalty'] = { data: { safeRange, source: 'poewiki Experience: safe zone table' }, url: url('Experience') };
      doc('Experience', p.text, p.timestamp);
    });
    for (const title of process.env.POM_KB_NO_PAGES ? [] : MECHANIC_PAGES) { // POM_KB_NO_PAGES: publish without the mechanic pages
      await step(`page ${title}`, async () => {
        const p = await pageText(ctx, title);
        doc(title, p.text, p.timestamp, PAGE_CHARS);
      });
    }
    await step('leveling-uniques', async () => {
      const rows = await cargoAll(ctx, {
        tables: 'items',
        fields: 'name,class,base_item,drop_level,required_level,drop_areas,drop_text,implicit_stat_text,explicit_stat_text',
        where: `rarity="Unique" AND drop_enabled=1 AND drop_level>0 AND drop_level<=${LEVELING_MAX_DROP_LEVEL}`,
      });
      if (rows.length < 20) throw new Error(`only ${rows.length} uniques returned`);
      const seen = new Set<string>();
      const data = rows
        .filter((r) => r.name && !seen.has(r.name) && seen.add(r.name))
        .map((r) => ({
          name: r.name!,
          class: r.class,
          base: r['base item'],
          dropLevel: Number(r['drop level']),
          requiredLevel: Number(r['required level'] ?? 0),
          dropAreas: r['drop areas'] ? plainWiki(r['drop areas']) : null,
          dropText: r['drop text'] ? plainWiki(r['drop text']) : null,
          implicits: statLines(r['implicit stat text'] ?? null),
          explicits: statLines(r['explicit stat text'] ?? null),
        }))
        .sort((a, b) => a.dropLevel - b.dropLevel || a.name.localeCompare(b.name));
      tables['leveling-uniques'] = { data, url: WIKI_API };
    });

    if (!Object.keys(tables).length) throw new Error(`the wiki gave nothing: ${errors.join('; ')}`);
    return {
      url: 'https://www.poewiki.net/',
      patch: ctx.livePatch,
      fetchedAt,
      entities: { doc: docs },
      tables,
      ...(errors.length ? { note: `partial: ${errors.join('; ')}` } : {}),
    };
  },
};
