/**
 * The game's own wording for stat ids (repoe-fork `stat_translations`, datamined from the game files). A gem or passive
 * row carries stat ids and raw values (Righteous Fire: `..._per_minute` 4200); this turns them into what the game shows
 * ("Deals 70% of your Maximum Life as Base Fire Damage per second") and stores it as `data.statText` on the row.
 */

export interface TransVariant { condition?: Array<{ min?: number; max?: number }>; format?: string[]; index_handlers?: string[][]; string: string; reminder_text?: string }
export interface TransEntry { ids: string[]; English: TransVariant[] }
export interface Handler { type: string; multiplier?: number | null; divisor?: number | null; addend?: number | null; precision?: number | null; fixed?: boolean | null }
export interface Translations { handlers: Record<string, Handler>; entries: TransEntry[] }
export type Stat = { id: string; value: number };

/** Keeps only the English text of each entry (the files carry trade-site data and 9 languages). */
export function slimEntries(raw: Array<Partial<TransEntry>>): TransEntry[] {
  return raw.filter((e): e is TransEntry => Array.isArray(e.ids) && Array.isArray(e.English)).map((e) => ({ ids: e.ids, English: e.English }));
}

function applyHandler(v: number, h: Handler | undefined): number | null {
  if (!h) return null;
  if (h.type === 'noop') return v;
  if (h.type !== 'int') return null;
  let x = (v * (h.multiplier ?? 1)) / (h.divisor ?? 1) + (h.addend ?? 0);
  if (h.precision != null) x = Number(x.toFixed(h.precision));
  return x;
}

const show = (x: number, fmt: string | undefined, fixedDigits: number | null): string => {
  const n = fixedDigits != null ? x.toFixed(fixedDigits) : String(Number(x.toFixed(2)));
  return fmt === '+#' && x >= 0 ? `+${n}` : n;
};

/** Text of one translation entry for the given values (by stat id); null when a handler is unknown or no variant fits. */
function render(e: TransEntry, values: Map<string, number>, handlers: Record<string, Handler>): string | null {
  const raw = e.ids.map((id) => values.get(id) ?? 0);
  const v = e.English.find((x) => raw.every((r, i) => { const c = x.condition?.[i] ?? {}; return (c.min == null || r >= c.min) && (c.max == null || r <= c.max); }));
  if (!v) return null;
  const shown: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let x: number | null = raw[i]!;
    for (const hn of v.index_handlers?.[i] ?? []) {
      x = x == null ? null : applyHandler(x, handlers[hn]);
    }
    if (x == null) return null;
    const fx = (v.index_handlers?.[i] ?? []).map((hn) => handlers[hn]).find((h) => h?.fixed);
    shown.push(show(x, v.format?.[i], fx ? (fx.precision ?? 2) : null));
  }
  const text = v.string.replace(/\{(\d+)(?::[^}]*)?\}/g, (_m, n: string) => (e.ids[Number(n)] && values.has(e.ids[Number(n)]!) ? shown[Number(n)]! : '#'));
  return v.reminder_text ? `${text} ${v.reminder_text}` : text;
}

/** In-game lines for a list of stats (stats without a translation are left out). */
export function statLines(stats: Stat[], tr: Translations, index: Map<string, TransEntry>): string[] {
  const values = new Map(stats.map((s) => [s.id, s.value]));
  const done = new Set<TransEntry>();
  const out: string[] = [];
  for (const s of stats) {
    const e = index.get(s.id);
    if (!e || done.has(e)) continue;
    done.add(e);
    const t = render(e, values, tr.handlers);
    if (t && t !== '#') out.push(t);
  }
  return out;
}

export const indexEntries = (tr: Translations): Map<string, TransEntry> => {
  const m = new Map<string, TransEntry>();
  for (const e of tr.entries) for (const id of e.ids) if (!m.has(id)) m.set(id, e);
  return m;
};

type Row = Record<string, unknown> & { data: Record<string, unknown> };
const asStats = (v: unknown): Stat[] => {
  let x = v;
  if (typeof x === 'string') {
    try { x = JSON.parse(x); } catch { return []; }
  }
  return Array.isArray(x) ? x.filter((s): s is Stat => !!s && typeof (s as Stat).id === 'string' && typeof (s as Stat).value === 'number') : [];
};

/** Adds `data.statText` to gems (constant + implicit stats), gem levels and passives. */
export function annotateStatText(tables: Map<string, Map<string, Row>>, tr: Translations): number {
  const index = indexEntries(tr);
  let n = 0;
  const put = (r: Row, stats: Stat[]) => {
    const lines = statLines(stats, tr, index);
    if (lines.length) { r.data.statText = lines; n++; } else delete r.data.statText;
  };
  for (const r of tables.get('gem')?.values() ?? []) {
    const d = r.data as { constantStats?: Stat[]; implicitStats?: string[] };
    put(r, [...asStats(d.constantStats), ...(d.implicitStats ?? []).map((id) => ({ id, value: 1 }))]);
  }
  for (const r of tables.get('gem_level')?.values() ?? []) put(r, asStats(r.stats));
  for (const r of tables.get('passive')?.values() ?? []) put(r, asStats(r.stats));
  return n;
}
