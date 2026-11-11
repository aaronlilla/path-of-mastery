import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openDb, type KbDb, type SqlValue } from './db.js';
import { PoliteHttp } from './http.js';
import { ddl, ENTITIES, KB_SCHEMA_VERSION, PROVENANCE, type EntityName, type SourceType } from './schema.js';
import { appSource } from './sources/app.js';
import { cdnSource, readLatestPatch } from './sources/cdn.js';
import { forumSource } from './sources/forum.js';
import { repoeSource } from './sources/repoe.js';
import { annotateStatText, type Translations } from './statText.js';
import { wikiSource } from './sources/wiki.js';
import type { AppDataPaths, EntityRow, KbSource, Pulled } from './sources/types.js';

/**
 * Builds the KB file: pull each source, merge, write a fresh `<out>.next`, validate, then swap it in and log what
 * changed. A source that fails (or is not asked for with `only`) keeps its rows from the previous KB, marked stale.
 * Idempotent: the same inputs give the same rows, and the change log then says nothing changed.
 */

export const DEFAULT_SOURCES: KbSource[] = [cdnSource, forumSource, appSource, wikiSource, repoeSource];

export interface BuildOptions {
  out: string;
  cacheDir: string;
  app: AppDataPaths;
  sources?: KbSource[];
  only?: string[];
  http?: PoliteHttp;
  livePatch?: string;
  log?: (m: string) => void;
  /** JSON-lines change log (default: <out dir>/kb-build.log.jsonl). */
  logFile?: string;
  /** Write even when validation fails (never used by the app). */
  force?: boolean;
  /** Do not let sources reuse rows from the previous KB (re-fetch everything). */
  fresh?: boolean;
}

export interface SourceReport { id: string; type: SourceType; status: 'fresh' | 'reused' | 'stale' | 'failed'; rows: number; patch: string | null; url: string | null; note?: string; error?: string }
export interface TableChange { table: string; before: number; after: number; added: number; removed: number; changed: number }
export interface BuildReport {
  out: string;
  livePatch: string;
  dataPatch: string | null;
  builtAt: string;
  sources: SourceReport[];
  changes: TableChange[];
  validation: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
  bytes: number;
  ms: number;
}

type Prov = { source: string; source_type: SourceType; source_url: string; patch: string; fetched_at: string };
type Stored = Record<string, unknown> & Prov & { data: Record<string, unknown> };

const pkOf = (table: string, r: Record<string, unknown>) => ENTITIES[table]!.pk.map((k) => String(r[k] ?? '')).join('\u0001');

/** Drop null, undefined, empty-string and empty-array/object fields (keeps the file small; readers treat missing as null). */
export function compact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = compact(x);
      if (c == null || c === '' || (Array.isArray(c) && !c.length) || (typeof c === 'object' && !Array.isArray(c) && !Object.keys(c as object).length)) continue;
      out[k] = c;
    }
    return out;
  }
  return v;
}

function toSql(v: unknown): SqlValue {
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  return JSON.stringify(compact(v));
}

function parseData(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string' || !v) return {};
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Rows a source wrote into the previous KB (to keep them when the source is skipped or fails). */
function previousRows(prev: KbDb, sourceId: string): Pulled | null {
  const entities: Pulled['entities'] = {};
  let n = 0;
  let meta: { url: string; patch: string; fetchedAt: string } | null = null;
  try {
    const s = prev.get<{ url: string; patch: string; fetched_at: string }>(`SELECT url, patch, fetched_at FROM source WHERE id = ?`, [sourceId]);
    if (s) meta = { url: s.url, patch: s.patch, fetchedAt: s.fetched_at };
    for (const t of Object.keys(ENTITIES)) {
      const rows = prev.all<Record<string, unknown>>(`SELECT * FROM ${t} WHERE source = ?`, [sourceId]);
      if (!rows.length) continue;
      entities[t as EntityName] = rows.map((r) => ({ ...r, data: parseData(r.data) }));
      n += rows.length;
    }
    const tables: NonNullable<Pulled['tables']> = {};
    for (const r of prev.all<Record<string, string>>(`SELECT * FROM kb_table WHERE source = ?`, [sourceId])) {
      tables[r.name!] = { data: JSON.parse(r.data!), url: r.source_url, type: r.source_type as SourceType, patch: r.patch };
      n++;
    }
    if (!n || !meta) return null;
    return { ...meta, entities, tables };
  } catch {
    return null;
  }
}

function rowHash(r: Record<string, unknown>): string {
  const { fetched_at: _f, ...rest } = r;
  return createHash('sha1').update(JSON.stringify(rest, Object.keys(rest).sort())).digest('hex');
}

/** Merge rows of one table from all sources: the first source owns provenance; later ones fill empty columns and data. */
class Merger {
  readonly tables = new Map<string, Map<string, Stored>>();
  readonly named = new Map<string, { data: unknown } & Prov>();

  add(src: { id: string; type: SourceType }, pulled: Pulled, keepProvenance = false): number {
    let n = 0;
    for (const [table, rows] of Object.entries(pulled.entities)) {
      const spec = ENTITIES[table];
      if (!spec || !rows) continue;
      const m = this.tables.get(table) ?? this.tables.set(table, new Map()).get(table)!;
      for (const raw of rows as EntityRow[]) {
        const prov: Prov = {
          source: keepProvenance && typeof raw.source === 'string' ? raw.source : src.id,
          source_type: raw.source_type ?? src.type,
          source_url: raw.source_url ?? pulled.url,
          patch: raw.patch ?? pulled.patch,
          fetched_at: keepProvenance && typeof raw.fetched_at === 'string' ? raw.fetched_at : pulled.fetchedAt,
        };
        const row: Stored = { ...raw, ...prov, data: (raw.data as Record<string, unknown>) ?? {} };
        const key = pkOf(table, row);
        const have = m.get(key);
        n++;
        if (!have) {
          m.set(key, row);
          continue;
        }
        if (have.source === row.source) {
          m.set(key, row);
          continue;
        }
        const filled: string[] = [];
        for (const c of spec.cols) {
          const cur = have[c];
          if ((cur == null || cur === '') && row[c] != null && row[c] !== '') {
            have[c] = row[c];
            filled.push(c);
          }
        }
        const extra = Object.keys(row.data).filter((k) => !(k in have.data));
        for (const k of extra) have.data[k] = row.data[k];
        const merged = (have.data.mergedFrom as unknown[]) ?? [];
        merged.push({ source: row.source, source_type: row.source_type, source_url: row.source_url, patch: row.patch, fields: [...filled, ...extra] });
        have.data.mergedFrom = merged;
      }
    }
    for (const [name, t] of Object.entries(pulled.tables ?? {})) {
      this.named.set(name, {
        data: t.data,
        source: src.id,
        source_type: t.type ?? src.type,
        source_url: t.url ?? pulled.url,
        patch: t.patch ?? pulled.patch,
        fetched_at: pulled.fetchedAt,
      });
      n++;
    }
    return n;
  }
}

function write(db: KbDb, merger: Merger, meta: Record<string, string>, sources: SourceReport[], fetched: Record<string, string>): void {
  db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
  db.exec(ddl());
  db.exec('BEGIN');
  for (const [k, v] of Object.entries(meta)) db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [k, v]);
  for (const s of sources) {
    db.run(`INSERT OR REPLACE INTO source (id, type, url, patch, fetched_at, rows, status, note) VALUES (?,?,?,?,?,?,?,?)`, [
      s.id, s.type, s.url, s.patch, fetched[s.id] ?? null, s.rows, s.status, s.error ?? s.note ?? null,
    ]);
  }
  for (const [name, t] of merger.named) {
    db.run(`INSERT OR REPLACE INTO kb_table (name, data, ${PROVENANCE.join(', ')}) VALUES (?,?,?,?,?,?,?)`, [
      name, JSON.stringify(t.data), t.source, t.source_type, t.source_url, t.patch, t.fetched_at,
    ]);
  }
  const search = db.prepare(`INSERT INTO search (name, body, kind, ref) VALUES (?,?,?,?)`);
  for (const [table, rows] of merger.tables) {
    const spec = ENTITIES[table]!;
    const cols = [...spec.cols, ...PROVENANCE, 'data'];
    const ins = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`);
    const sorted = [...rows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [, r] of sorted) {
      ins.run(cols.map((c) => toSql(r[c])));
      if (spec.kind) {
        const name = spec.name(r);
        if (name || table === 'doc') search.run([name, spec.body(r).slice(0, 20000), table === 'doc' ? `doc:${String(r.doc_kind)}` : spec.kind, `${table}:${spec.ref(r)}`]);
      }
    }
    ins.finalize();
  }
  search.finalize();
  db.exec('COMMIT');
  db.exec(`INSERT INTO search(search) VALUES('optimize')`);
}

/** Spot checks against known facts. Checks for a source run only when that source has rows. */
export async function validateKb(db: KbDb, app: AppDataPaths | null, present: Set<string>): Promise<BuildReport['validation']> {
  const checks: BuildReport['validation']['checks'] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const count = (t: string, where = '1=1', p: SqlValue[] = []) => db.get<{ n: number }>(`SELECT count(*) n FROM ${t} WHERE ${where}`, p)!.n;
  if (present.has('cdn')) {
    const mins: Record<string, number> = { gem: 500, gem_level: 5000, base_item: 3000, mod: 10000, passive: 2000, ascendancy: 19, area: 500, quest: 50, quest_reward: 100 };
    for (const [t, min] of Object.entries(mins)) {
      const n = count(t, `source = 'cdn' OR source_type = 'datamined'`);
      check(`rows ${t} >= ${min}`, n >= min, `${n}`);
    }
    const pc = db.get<{ id: string; req_level: number }>(`SELECT id, req_level FROM gem WHERE name = 'Poisonous Concoction' AND source = 'cdn'`);
    let refReq: number | null = null;
    if (app) {
      try {
        const skills = JSON.parse(await readFile(join(app.engineDataDir, 'data_skills.json'), 'utf8')) as Record<string, { levels?: Array<{ levelRequirement?: number }> }>;
        refReq = skills.PoisonousConcoction?.levels?.[0]?.levelRequirement ?? null;
      } catch {
        refReq = null;
      }
    }
    check(
      'Poisonous Concoction level 1 requirement matches the engine data',
      !!pc && (refReq == null || pc.req_level === refReq),
      pc ? `CDN ${pc.req_level}, engine ${refReq ?? 'n/a'}` : 'gem missing',
    );
    const fb = db.get<{ is_support: number }>(`SELECT is_support FROM gem WHERE name = 'Fireball' AND source = 'cdn'`);
    check('Fireball is an active gem', !!fb && fb.is_support === 0, fb ? `is_support=${fb.is_support}` : 'missing');
    check('Allflame league tables exist', count('league_mechanic', `id LIKE 'allflame:%'`) > 0, `${count('league_mechanic', `id LIKE 'allflame:%'`)} rows`);
    const pid = db.get<{ data: string }>(`SELECT data FROM kb_table WHERE name = 'passive-ids'`);
    const ids = pid ? Object.keys(JSON.parse(pid.data) as object).length : 0;
    check('passive-ids table', ids > 2000, `${ids} ids`);
  }
  if (present.has('forum')) {
    const n = count('doc', `source = 'forum'`);
    check('patch-note docs >= 20', n >= 20, `${n}`);
    const cu = db.get<{ title: string }>(`SELECT title FROM doc WHERE doc_kind = 'league' AND title LIKE '%Allflame%' LIMIT 1`);
    check('Allflame content update doc exists', !!cu, cu?.title ?? 'missing');
  }
  if (present.has('app')) {
    check('Tabula Rasa unique exists', !!db.get(`SELECT 1 FROM unique_item WHERE name = 'Tabula Rasa'`), '');
    check('gem-offers table exists', !!db.get(`SELECT 1 FROM kb_table WHERE name = 'gem-offers'`), '');
  }
  return { ok: checks.every((c) => c.ok), checks };
}

function tableHashes(db: KbDb, table: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const r of db.all<Record<string, unknown>>(`SELECT * FROM ${table}`)) out.set(table === 'kb_table' ? String(r.name) : pkOf(table, r), rowHash(r));
  } catch {
    /* table missing in an older KB */
  }
  return out;
}

export async function buildKb(o: BuildOptions): Promise<BuildReport> {
  const t0 = Date.now();
  const log = o.log ?? (() => undefined);
  const http = o.http ?? new PoliteHttp({ cacheDir: o.cacheDir, log });
  await mkdir(dirname(o.out), { recursive: true });
  await mkdir(o.cacheDir, { recursive: true });
  const livePatch = o.livePatch ?? (await readLatestPatch({ http }));
  log(`live patch ${livePatch}`);
  const prev = (await fileExists(o.out)) ? openDb(o.out, { readOnly: true }) : undefined;
  const sources = o.sources ?? DEFAULT_SOURCES;
  const merger = new Merger();
  const reports: SourceReport[] = [];
  const fetched: Record<string, string> = {};
  const present = new Set<string>();
  try {
    for (const src of sources) {
      const skip = o.only && !o.only.includes(src.id);
      let pulled: Pulled | null = null;
      let status: SourceReport['status'] = 'fresh';
      let error: string | undefined;
      if (!skip) {
        try {
          const t = Date.now();
          pulled = await src.pull({ http, cacheDir: o.cacheDir, livePatch, app: o.app, previous: o.fresh ? undefined : prev, log });
          log(`${src.id}: pulled in ${((Date.now() - t) / 1000).toFixed(1)} s`);
        } catch (e) {
          error = (e as Error).message;
          log(`${src.id}: FAILED: ${error}`);
        }
      }
      let keep = false;
      if (!pulled && prev) {
        pulled = previousRows(prev, src.id);
        keep = true;
        status = skip ? 'reused' : 'stale';
      }
      if (!pulled) {
        reports.push({ id: src.id, type: src.type, status: 'failed', rows: 0, patch: null, url: null, error });
        continue;
      }
      if (!error && !skip) present.add(src.id);
      else if (keep) present.add(src.id);
      const rows = merger.add(src, pulled, keep);
      fetched[src.id] = pulled.fetchedAt;
      reports.push({ id: src.id, type: src.type, status, rows, patch: pulled.patch, url: pulled.url, note: pulled.note, error });
    }
    // gem and passive stats get the game's own wording (repoe-fork stat_translations), whichever sources ran this time
    const trans = merger.named.get('stat-translations')?.data as Translations | undefined;
    if (trans) log(`stat text on ${annotateStatText(merger.tables as Parameters<typeof annotateStatText>[0], trans)} rows`);
    const cdn = reports.find((r) => r.id === 'cdn' && r.status !== 'failed');
    const forumThreads = merger.named.get('patch-threads')?.data as Array<{ id: number; title: string }> | undefined;
    const builtAt = new Date().toISOString();
    const meta: Record<string, string> = {
      schema_version: String(KB_SCHEMA_VERSION),
      data_patch: cdn?.patch ?? '',
      live_patch: livePatch,
      live_checked_at: builtAt,
      built_at: builtAt,
      forum_newest_thread: forumThreads?.[0] ? String(forumThreads[0].id) : '',
      forum_newest_title: forumThreads?.[0]?.title ?? '',
    };
    const next = `${o.out}.next`;
    await rm(next, { force: true });
    const db = openDb(next);
    let validation: BuildReport['validation'];
    const changes: TableChange[] = [];
    try {
      write(db, merger, meta, reports, fetched);
      validation = await validateKb(db, o.app, present);
      for (const t of [...Object.keys(ENTITIES), 'kb_table']) {
        const after = tableHashes(db, t);
        const before = prev ? tableHashes(prev, t) : new Map<string, string>();
        let added = 0;
        let changed = 0;
        for (const [k, h] of after) {
          const b = before.get(k);
          if (b == null) added++;
          else if (b !== h) changed++;
        }
        let removed = 0;
        for (const k of before.keys()) if (!after.has(k)) removed++;
        changes.push({ table: t, before: before.size, after: after.size, added, removed, changed });
      }
    } finally {
      db.close();
    }
    prev?.close();
    if (!validation.ok && !o.force) {
      const bad = validation.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
      throw new Error(`KB validation failed: ${bad.join('; ')}. Kept the previous KB; the candidate is at ${next}`);
    }
    await rename(next, o.out);
    const bytes = (await stat(o.out)).size;
    const report: BuildReport = { out: o.out, livePatch, dataPatch: meta.data_patch || null, builtAt, sources: reports, changes, validation, bytes, ms: Date.now() - t0 };
    const logFile = o.logFile ?? join(o.cacheDir, 'kb-build.log.jsonl');
    await appendFile(logFile, JSON.stringify({ builtAt, livePatch, dataPatch: report.dataPatch, sources: reports, changes: changes.filter((c) => c.added || c.removed || c.changed), validation: validation.ok, bytes }) + '\n');
    return report;
  } catch (e) {
    try {
      prev?.close();
    } catch {
      /* already closed */
    }
    throw e;
  }
}
