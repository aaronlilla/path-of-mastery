import { openDb, type KbDb, type SqlValue } from './db.js';
import { ENTITIES } from './schema.js';

/**
 * Read side of the KB, shared by the assistant tools, the Journey KnowledgeBase and the dev CLI. Every answer carries
 * its citation (source, type, URL, patch, fetched-at) and the KB's data patch.
 */

export interface Cite {
  source: string;
  sourceType: string;
  url: string;
  patch: string;
  fetchedAt: string;
}

export interface KbStatus {
  /** Game patch of the datamined tables (CDN), e.g. "3.29.3.3". */
  dataPatch: string | null;
  /** Live patch from the last check of latest.txt; null when never checked. */
  livePatch: string | null;
  behind: boolean;
  /** Plain words, e.g. "data is 3.29.3.3, live is 3.29.4.0" or "2 newer patch-note threads"; null when current. */
  behindBy: string | null;
  lastRefresh: string | null;
  lastCheck: string | null;
  newestPatchNote: { id: number; title: string } | null;
  sources: Array<{ id: string; type: string; status: string; rows: number; patch: string | null; fetchedAt: string | null; note: string | null }>;
}

export interface SearchHit {
  kind: string;
  ref: string;
  name: string;
  snippet: string;
  cite: Cite;
}

/** Aliases the tools accept for `kind`. */
export const KIND_TABLE: Record<string, string> = {
  gem: 'gem',
  skill: 'gem',
  support: 'gem',
  base: 'base_item',
  item: 'base_item',
  base_item: 'base_item',
  mod: 'mod',
  affix: 'mod',
  unique: 'unique_item',
  unique_item: 'unique_item',
  passive: 'passive',
  node: 'passive',
  keystone: 'passive',
  notable: 'passive',
  ascendancy: 'ascendancy',
  quest: 'quest',
  area: 'area',
  zone: 'area',
  card: 'div_card',
  div_card: 'div_card',
  divination: 'div_card',
  currency: 'currency',
  league: 'league_mechanic',
  league_mechanic: 'league_mechanic',
  boss: 'boss',
  doc: 'doc',
  patch: 'doc',
};

const parse = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
};

function citeOf(r: Record<string, unknown>): Cite {
  return { source: String(r.source ?? ''), sourceType: String(r.source_type ?? ''), url: String(r.source_url ?? ''), patch: String(r.patch ?? ''), fetchedAt: String(r.fetched_at ?? '') };
}

/** A row without provenance columns, JSON columns parsed. */
function clean(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'source' || k === 'source_type' || k === 'source_url' || k === 'patch' || k === 'fetched_at') continue;
    if (v == null || v === '') continue;
    out[k] = parse(v);
  }
  return out;
}

/** User text to an FTS5 query: each word quoted, last word as a prefix. `any` joins with OR. */
export function ftsQuery(text: string, any = false): string | null {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%'+.\- ]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.'\-]+|[.'\-]+$/g, '').replace(/"/g, ''))
    .filter((w) => w.length > 0);
  if (!words.length) return null;
  const parts = words.map((w, i) => (i === words.length - 1 && w.length >= 2 ? `"${w}"*` : `"${w}"`));
  return parts.join(any ? ' OR ' : ' ');
}

/** Prefer exact and prefix name matches, then entity kinds people ask about, keeping bm25 order otherwise. */
const KIND_RANK: Record<string, number> = { gem: 0, unique: 0, league: 0, passive: 1, ascendancy: 1, boss: 1, card: 1, currency: 1, quest: 2, area: 2, base: 2, 'doc:league': 2, 'doc:patch_note': 2, 'doc:hotfix': 3, mod: 4 };
function rerank<T>(rows: T[], text: string, name: (r: T) => string, kind: (r: T) => string): T[] {
  const q = text.trim().toLowerCase();
  const score = (r: T, i: number) => {
    const n = name(r).toLowerCase();
    const exact = n === q ? -1000 : n.startsWith(q) ? -500 : n.includes(q) ? -200 : 0;
    return exact + (KIND_RANK[kind(r)] ?? 3) * 8 + i;
  };
  return rows.map((r, i) => ({ r, s: score(r, i) })).sort((a, b) => a.s - b.s).map((x) => x.r);
}

const versionKey = (v: string): number[] => v.split(/[.]/).map((p) => parseInt(p, 10) || 0);

/**
 * Hit vs damage over time for a gem, from its own stat ids (Righteous Fire has only per-minute damage and never
 * hits). A hit needs the attack tag or a damage effectiveness; undefined when the data says neither.
 */
export function gemDamageKind(tags: unknown, data: { constantStats?: Array<{ id: string }> }, levels: Array<Record<string, unknown>>): string | undefined {
  const ids = [...(data.constantStats ?? []).map((x) => x.id), ...levels.flatMap((l) => ((parse(l.stats) as Array<{ id: string }>) ?? []).map((x) => x.id))];
  const dot = ids.some((id) => /^base_.*(damage|to_deal).*per_minute$/.test(id));
  const hit = String(tags).split(',').includes('attack') || levels.some((l) => Number((parse(l.data) as { damageEffectiveness?: number })?.damageEffectiveness) > 0 || Number((parse(l.data) as { baseMultiplier?: number })?.baseMultiplier) > 0);
  if (hit && dot) return 'hit and damage over time';
  const pools = [ids.some((id) => /max(imum)?_life/.test(id)) && 'maximum life', ids.some((id) => /energy_shield/.test(id)) && 'maximum energy shield'].filter(Boolean);
  const self = ids.some((id) => /taken_per_minute|nonlethal/.test(id)); // real self-damage stats (Righteous Fire)
  if (dot) return `damage over time only, it does not hit, so penetration, crit and hit-only bonuses do not apply${ids.includes('spell_damage_modifiers_apply_to_skill_dot') ? '; spell damage bonuses do apply' : ''}${self ? `; only the damage's own element resistance reduces what it deals to the player` : ''} (its per-minute rates are per minute: divide by sixty for per second${pools.length ? `; they are a percent of your ${pools.join(' and ')}: say each` : ''})`;
  return hit ? 'hit' : undefined;
}

export class KbQuery {
  private constructor(readonly db: KbDb, readonly path: string) {}

  static open(path: string, opts: { readOnly?: boolean } = { readOnly: true }): KbQuery {
    return new KbQuery(openDb(path, opts), path);
  }

  close(): void {
    this.db.close();
  }

  meta(key: string): string | null {
    return this.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key])?.value || null;
  }

  status(live?: { livePatch?: string | null; checkedAt?: string | null; newestThread?: { id: number; title: string } | null }): KbStatus {
    const dataPatch = this.meta('data_patch');
    const livePatch = live?.livePatch !== undefined ? live.livePatch : this.meta('live_patch');
    const newestId = Number(this.meta('forum_newest_thread') || 0);
    const liveThread = live?.newestThread ?? null;
    const reasons: string[] = [];
    if (dataPatch && livePatch && dataPatch !== livePatch) reasons.push(`data is ${dataPatch}, live is ${livePatch}`);
    if (liveThread && newestId && liveThread.id > newestId) reasons.push(`newer patch notes: "${liveThread.title}"`);
    const sources = this.db
      .all<Record<string, unknown>>(`SELECT id, type, status, rows, patch, fetched_at, note FROM source ORDER BY id`)
      .map((s) => ({ id: String(s.id), type: String(s.type), status: String(s.status), rows: Number(s.rows), patch: (s.patch as string) ?? null, fetchedAt: (s.fetched_at as string) ?? null, note: (s.note as string) ?? null }));
    return {
      dataPatch,
      livePatch: livePatch ?? null,
      behind: reasons.length > 0,
      behindBy: reasons.length ? reasons.join('; ') : null,
      lastRefresh: this.meta('built_at'),
      lastCheck: live?.checkedAt ?? this.meta('live_checked_at'),
      newestPatchNote: newestId ? { id: newestId, title: this.meta('forum_newest_title') ?? '' } : null,
      sources,
    };
  }

  /** Full-text search across every entity and patch-note chunk. `kind` narrows to one kind (gem, unique, doc, ...). */
  search(text: string, o: { kind?: string; limit?: number } = {}): SearchHit[] {
    const limit = Math.min(Math.max(o.limit ?? 10, 1), 50);
    const kindFilter = o.kind ? (KIND_TABLE[o.kind] === 'doc' ? 'doc:%' : (ENTITIES[KIND_TABLE[o.kind] ?? '']?.kind ?? o.kind)) : null;
    const run = (q: string, n: number) =>
      this.db.all<{ kind: string; ref: string; name: string; snip: string }>(
        `SELECT kind, ref, name, snippet(search, 1, '[', ']', '…', 18) AS snip FROM search WHERE search MATCH ? ${kindFilter ? `AND kind LIKE ?` : ''} ORDER BY bm25(search, 6.0, 1.0) LIMIT ?`,
        (kindFilter ? [q, kindFilter, n] : [q, n]) as SqlValue[],
      );
    let rows: ReturnType<typeof run> = [];
    const strict = ftsQuery(text);
    if (!strict) return [];
    const wide = Math.max(limit * 4, 40);
    try {
      rows = run(strict, wide);
      if (!rows.length) rows = run(ftsQuery(text, true)!, wide);
    } catch {
      rows = [];
    }
    return rerank(rows, text, (r) => r.name, (r) => r.kind)
      .slice(0, limit)
      .map((r) => ({ kind: r.kind, ref: r.ref, name: r.name, snippet: r.snip, cite: this.citeRef(r.ref) }));
  }

  private citeRef(ref: string): Cite {
    const i = ref.indexOf(':');
    const table = ref.slice(0, i);
    const id = ref.slice(i + 1);
    if (!ENTITIES[table]) return { source: '', sourceType: '', url: '', patch: '', fetchedAt: '' };
    const r = this.db.get<Record<string, unknown>>(`SELECT source, source_type, source_url, patch, fetched_at FROM ${table} WHERE id = ?`, [id]);
    return r ? citeOf(r) : { source: '', sourceType: '', url: '', patch: '', fetchedAt: '' };
  }

  /** One row by table and id, cleaned, with its citation. */
  byRef(ref: string): { row: Record<string, unknown>; cite: Cite } | null {
    const i = ref.indexOf(':');
    const table = ref.slice(0, i);
    if (!ENTITIES[table]) return null;
    const r = this.db.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [ref.slice(i + 1)]);
    return r ? { row: clean(r), cite: citeOf(r) } : null;
  }

  /**
   * Exact lookup by kind and name (case-insensitive), or by id. Returns the best row with related rows (gem levels and
   * quest offers for a gem, rewards for a quest), else close candidates from search.
   */
  lookup(kind: string, name: string, o: { levels?: number[] | 'all' } = {}): { found: boolean; kind: string; table: string; rows: Array<{ row: Record<string, unknown>; cite: Cite; related?: Record<string, unknown> }>; candidates?: SearchHit[] } {
    const table = KIND_TABLE[kind.toLowerCase()];
    if (!table) throw new Error(`unknown kind "${kind}". Kinds: ${[...new Set(Object.keys(KIND_TABLE))].join(', ')}`);
    const nameCol = table === 'doc' ? 'title' : 'name';
    let rows = this.db.all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${nameCol} = ? COLLATE NOCASE LIMIT 5`, [name]);
    if (!rows.length) rows = this.db.all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [name]);
    if (table === 'passive' && !rows.length && /^\d+$/.test(name)) rows = this.db.all<Record<string, unknown>>(`SELECT * FROM passive WHERE hash = ?`, [Number(name)]);
    if (table === 'gem' && rows.length > 1) rows.sort((a, b) => Number(!!(parse(a.data) as Record<string, unknown>)?.vaal) - Number(!!(parse(b.data) as Record<string, unknown>)?.vaal));
    if (!rows.length) return { found: false, kind, table, rows: [], candidates: this.search(name, { kind, limit: 8 }) };
    return {
      found: true,
      kind,
      table,
      rows: rows.map((r) => ({ row: clean(r), cite: citeOf(r), related: this.related(table, r, o) })),
    };
  }

  private related(table: string, r: Record<string, unknown>, o: { levels?: number[] | 'all' }): Record<string, unknown> | undefined {
    if (table === 'gem') {
      const all = this.db.all<Record<string, unknown>>(`SELECT level, req_level, stats, data FROM gem_level WHERE gem_id = ? ORDER BY level`, [String(r.id)]);
      const want = o.levels === 'all' ? null : new Set(o.levels ?? [1, 20]);
      const levels = all.filter((l) => !want || want.has(Number(l.level))).map((l) => ({ level: l.level, reqLevel: l.req_level, stats: parse(l.stats), ...(parse(l.data) as object) }));
      const offers = this.db
        .all<Record<string, unknown>>(`SELECT r.quest_id, q.name AS quest_name, r.reward_type, r.classes, r.source, r.source_url, r.data FROM quest_reward r LEFT JOIN quest q ON q.id = r.quest_id WHERE r.reward = ? COLLATE NOCASE ORDER BY r.quest_id`, [String(r.name)])
        // the player sees the quest's name; its id (a3q8) stays out of the result when the name is known
        .map((q) => ({ quest: q.quest_name ?? q.quest_id, type: q.reward_type, classes: q.classes, source: q.source, ...(parse(q.data) as object) }));
      const damageKind = gemDamageKind(r.tags, (parse(r.data) as { constantStats?: Array<{ id: string }> }) ?? {}, all);
      return { levels, levelCount: all.length, offers, ...(damageKind ? { damageKind } : {}) };
    }
    if (table === 'quest') {
      const rewards = this.db
        .all<Record<string, unknown>>(`SELECT reward_type, reward, classes, source, data FROM quest_reward WHERE quest_id = ? ORDER BY reward_type, reward`, [String(r.id)])
        .map((q) => ({ type: q.reward_type, reward: q.reward, classes: q.classes, source: q.source }));
      return { rewards };
    }
    return undefined;
  }

  /** Versions that have patch notes, newest first, with thread titles. */
  patchVersions(): Array<{ version: string; titles: string[]; postedAt: string | null }> {
    const rows = this.db.all<{ version: string; title: string; posted_at: string }>(
      `SELECT version, json_extract(data, '$.threadTitle') AS title, posted_at FROM doc WHERE source = 'forum' AND json_extract(data, '$.chunk') = 0 ORDER BY posted_at DESC, id DESC`,
    );
    const by = new Map<string, { version: string; titles: string[]; postedAt: string | null }>();
    for (const r of rows) {
      const v = r.version ?? 'unversioned';
      const e = by.get(v) ?? by.set(v, { version: v, titles: [], postedAt: r.posted_at }).get(v)!;
      e.titles.push(r.title);
    }
    return [...by.values()];
  }

  /**
   * Patch-note text. `version` "3.29.3" matches 3.29.3, 3.29.3b and its hotfixes; "3.29" matches the whole league.
   * With `query`, only matching sections (ranked); without, the sections in post order, capped at `maxChars`.
   */
  patchChanges(o: { version?: string; query?: string; limit?: number; maxChars?: number } = {}): {
    version: string | null;
    sections: Array<{ title: string; version: string | null; postedAt: string | null; text: string; cite: Cite }>;
    truncated: boolean;
    versions?: ReturnType<KbQuery['patchVersions']>;
  } {
    const maxChars = o.maxChars ?? 14000;
    const limit = Math.min(o.limit ?? 40, 200);
    let version = o.version?.trim().replace(/^v/i, '') || null;
    const params: SqlValue[] = [];
    let where = `d.source = 'forum'`;
    if (!version && !o.query) {
      // newest versioned patch by default
      const v = this.patchVersions().find((x) => x.version !== 'unversioned');
      version = v?.version.replace(/[a-z]$/, '') ?? null;
    }
    if (version) {
      where += ` AND (d.version = ? OR d.version LIKE ?)`;
      params.push(version, `${version}${/\.\d+\.\d+$/.test(version) ? '' : '.'}%`);
    }
    let rows: Array<Record<string, unknown>>;
    const q = o.query ? ftsQuery(o.query) : null;
    if (q) {
      const sql = `SELECT d.* FROM search s JOIN doc d ON s.ref = 'doc:' || d.id WHERE search MATCH ? AND s.kind LIKE 'doc:%' AND ${where} ORDER BY bm25(search, 6.0, 1.0) LIMIT ?`;
      rows = this.db.all(sql, [q, ...params, limit]);
      if (!rows.length) rows = this.db.all(sql, [ftsQuery(o.query!, true)!, ...params, limit]);
    } else {
      rows = this.db.all(`SELECT d.* FROM doc d WHERE ${where} ORDER BY d.posted_at ASC, CAST(json_extract(d.data, '$.thread') AS INTEGER) ASC, CAST(json_extract(d.data, '$.chunk') AS INTEGER) ASC LIMIT ?`, [...params, limit * 4]);
    }
    let used = 0;
    let truncated = false;
    const sections: Array<{ title: string; version: string | null; postedAt: string | null; text: string; cite: Cite }> = [];
    for (const r of rows) {
      const text = String(r.body ?? '');
      if (used + text.length > maxChars && sections.length) {
        truncated = true;
        break;
      }
      used += text.length;
      sections.push({ title: String(r.title), version: (r.version as string) ?? null, postedAt: (r.posted_at as string) ?? null, text, cite: citeOf(r) });
    }
    return { version, sections, truncated, ...(sections.length ? {} : { versions: this.patchVersions().slice(0, 12) }) };
  }

  /** League and game mechanics: league_mechanic rows plus the best patch-note / content-update sections. */
  mechanic(name: string, o: { limit?: number } = {}): { name: string; mechanics: Array<{ row: Record<string, unknown>; cite: Cite }>; sections: Array<{ title: string; version: string | null; text: string; cite: Cite }> } {
    const q = ftsQuery(name);
    const mechanics: Array<{ row: Record<string, unknown>; cite: Cite }> = [];
    const seen = new Set<string>();
    if (q) {
      for (const h of this.db.all<{ ref: string }>(`SELECT ref FROM search WHERE search MATCH ? AND kind = 'league' ORDER BY bm25(search, 6.0, 1.0) LIMIT 6`, [q])) {
        const r = this.byRef(h.ref);
        if (r && !seen.has(h.ref)) {
          seen.add(h.ref);
          mechanics.push(r);
        }
      }
    }
    const sections: Array<{ title: string; version: string | null; text: string; cite: Cite }> = [];
    if (q) {
      // body-weighted: every chunk of a content update carries the league name in its title
      const sql = `SELECT d.* FROM search s JOIN doc d ON s.ref = 'doc:' || d.id WHERE search MATCH ? AND s.kind LIKE 'doc:%' ORDER BY bm25(search, 1.0, 3.0) LIMIT 40`;
      let rows = this.db.all<Record<string, unknown>>(sql, [q]);
      if (!rows.length) rows = this.db.all<Record<string, unknown>>(sql, [ftsQuery(name, true)!]);
      const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const heading = (r: Record<string, unknown>) => String((parse(r.data) as { heading?: string })?.heading ?? '').toLowerCase();
      // a section titled with the term comes first, in post order; then league docs; then rank
      const chunk = (r: Record<string, unknown>) => Number((parse(r.data) as { chunk?: number })?.chunk ?? 0);
      const score = (r: Record<string, unknown>, i: number) => (words.some((w) => heading(r).includes(w)) ? -10000 + chunk(r) : i - (r.doc_kind === 'league' ? 20 : 0));
      rows = rows.map((r, i) => ({ r, s: score(r, i) })).sort((a, b) => a.s - b.s).map((x) => x.r).slice(0, o.limit ?? 6);
      for (const r of rows) sections.push({ title: String(r.title), version: (r.version as string) ?? null, text: String(r.body), cite: citeOf(r) });
    }
    return { name, mechanics, sections };
  }

  /** A named JSON table (Journey's KnowledgeBase). */
  table<T = unknown>(name: string): { data: T; cite: Cite } | null {
    const r = this.db.get<Record<string, unknown>>(`SELECT * FROM kb_table WHERE name = ?`, [name]);
    if (!r) return null;
    return { data: JSON.parse(String(r.data)) as T, cite: citeOf(r) };
  }

  tableNames(): string[] {
    return this.db.all<{ name: string }>(`SELECT name FROM kb_table ORDER BY name`).map((r) => r.name);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of [...Object.keys(ENTITIES), 'kb_table']) out[t] = this.db.get<{ n: number }>(`SELECT count(*) n FROM ${t}`)!.n;
    return out;
  }
}

export { versionKey };
