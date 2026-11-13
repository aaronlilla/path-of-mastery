// Real characters of one skill from poe.ninja's build API: the search answers
// in protobuf, a character in JSON with a build-code export taken at the time-machine snapshot.
const BASE = 'https://poe.ninja/poe1/api';
const UA = { 'User-Agent': 'Mozilla/5.0 pom-app (real builds for the AI)' };
export type Stage = 'league-start' | 'week-1' | 'mid';
const SNAPSHOT: Record<Stage, string | null> = { 'league-start': 'day-3', 'week-1': 'week-1', mid: null };

type Field = { f: number; v: number | Uint8Array };

/** One protobuf message as (field, value) pairs; null when the bytes are not a clean message. */
function fields(b: Uint8Array): Field[] | null {
  const out: Field[] = [];
  let i = 0;
  const varint = (): number => {
    let r = 0, s = 0;
    for (;;) {
      const c = b[i++];
      if (c === undefined) throw new RangeError('end');
      r += (c & 0x7f) * 2 ** s; s += 7;
      if (c < 0x80) return r;
    }
  };
  try {
    while (i < b.length) {
      const k = varint(), f = Math.floor(k / 8), wt = k & 7;
      if (f === 0) return null;
      if (wt === 0) out.push({ f, v: varint() });
      else if (wt === 2) { const n = varint(); if (i + n > b.length) return null; out.push({ f, v: b.subarray(i, i + n) }); i += n; }
      else if (wt === 1) { out.push({ f, v: b.subarray(i, i + 8) }); i += 8; }
      else if (wt === 5) { out.push({ f, v: b.subarray(i, i + 4) }); i += 4; }
      else return null;
    }
  } catch { return null; }
  return out;
}
const text = (v: number | Uint8Array): string => (typeof v === 'number' ? '' : new TextDecoder().decode(v));

/** One ladder row of a search answer. `ehp` and `dps` are poe.ninja's own text ("12k"); level and life come with the row, so a character outside the band is skipped without a fetch. */
export interface NinjaRow { account: string; name: string; ehp?: string; dps?: string; level?: number; life?: number }

/** A packed list of varints (poe.ninja sends the number columns this way), one per row. */
function varints(v: number | Uint8Array): number[] {
  const out: number[] = [];
  if (typeof v === 'number') return out;
  for (let i = 0; i < v.length;) {
    let r = 0, s = 0, c: number;
    do { c = v[i++]!; r += (c & 0x7f) * 2 ** s; s += 7; } while (c >= 0x80 && i < v.length);
    out.push(r);
  }
  return out;
}

/** The ladder rows of a search answer: account, name, level, life, poe.ninja's EHP and DPS text ("12k") per row, plus how many characters match. */
export function parseSearch(buf: Uint8Array): { total: number; rows: NinjaRow[] } {
  const top = fields(buf);
  const rootBytes = top?.find((x) => x.f === 1 && typeof x.v !== 'number')?.v;
  const root = rootBytes && typeof rootBytes !== 'number' ? fields(rootBytes) : null;
  if (!root) throw new Error('poe.ninja sent an answer this app cannot read.');
  const total = Number(root.find((x) => x.f === 1)?.v ?? 0);
  // A column is the strings (field 7) or packed numbers (field 6) of one list; a sparse string column names the rows that have one (field 14).
  const cols = new Map<string, Array<string | number | undefined>>();
  for (const x of root) {
    if (x.f !== 12 || typeof x.v === 'number') continue;
    const m = fields(x.v) ?? [];
    const name = text(m.find((y) => y.f === 1)?.v ?? 0);
    const strs = m.filter((y) => y.f === 7).map((y) => text(y.v));
    const rows = varints(m.find((y) => y.f === 14)?.v ?? 0);
    if (strs.length) {
      const col: Array<string | undefined> = rows.length ? [] : strs;
      rows.forEach((r, i) => { col[r] = strs[i]; });
      cols.set(name, col);
    }
    else cols.set(name, varints(m.find((y) => y.f === 6)?.v ?? 0));
  }
  const col = (n: string) => cols.get(n) ?? [];
  const names = col('name') as string[], accts = col('account') as string[];
  const dpsKey = [...cols.keys()].find((k) => k.startsWith('dps-') && k.endsWith('.total'));
  return {
    total,
    rows: names.map((name, i) => {
      const ehp = col('ehp__str')[i], dps = dpsKey ? col(dpsKey)[i] : undefined, level = col('level')[i], life = col('life')[i];
      return { name, account: accts[i] ?? '', ...(ehp !== undefined ? { ehp: String(ehp) } : {}), ...(dps !== undefined ? { dps: String(dps) } : {}), ...(typeof level === 'number' ? { level } : {}), ...(typeof life === 'number' ? { life } : {}) };
    }),
  };
}

// poe.ninja answered 429 with Retry-After 3600 after about 45 calls 1.2 s apart (2026-11-12): a short ask is waited out once, a long one is a refusal to report.
const get = async (url: string, retried = false): Promise<Response> => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (r.status === 429 || r.status >= 500) {
    const wait = Number(r.headers.get('retry-after') ?? 10);
    if (!retried && wait <= 60) { await new Promise((res) => setTimeout(res, wait * 1000)); return get(url, true); }
    throw new Error(`poe.ninja asked to wait ${wait} s (HTTP ${r.status}); try again later.`);
  }
  if (!r.ok) throw new Error(`poe.ninja answered ${r.status}.`);
  return r;
};

interface IndexState {
  economyLeagues?: Array<{ name: string; url: string }>;
  oldEconomyLeagues?: Array<{ name: string; url: string }>;
  snapshotVersions?: Array<{ type: string; url: string; version: string; snapshotName: string; name: string; timeMachineLabels?: string[] }>;
}

/**
 * The league the characters come from: the newest softcore challenge league poe.ninja lists (economy leagues first, then the ended ones, newest first), never Standard,
 * hardcore, solo or a private league. `url` picks another one by its poe.ninja id. (The first `exp` entry is Standard, so the list order alone gave the wrong league.)
 */
export function pickLeague(state: IndexState, url?: string) {
  const entries = state.snapshotVersions?.filter((s) => s.type === 'exp') ?? [];
  const wanted = url ?? [...(state.economyLeagues ?? []), ...(state.oldEconomyLeagues ?? [])].find((l) => !/^(standard|hardcore)$/i.test(l.name) && !/^hardcore /i.test(l.name))?.url;
  const lg = wanted ? entries.find((s) => s.url === wanted) : undefined;
  if (!lg) throw new Error(url ? `poe.ninja has no league "${url}".` : 'poe.ninja lists no current league.');
  return lg;
}

export interface RealCharacter { account: string; name: string; level: number; className: string; ascendancy: string; life: number; energyShield: number; ninjaEhp?: string; ninjaDps?: string; buildCode: string }

export type LevelBand = { min: number; max: number };
// Day-3 league-start kits are level 85-90; later snapshots are not banded.
const BAND: Record<Stage, LevelBand | undefined> = { 'league-start': { min: 85, max: 90 }, 'week-1': undefined, mid: undefined };
// shortcut: poe.ninja is slow and rate-limited, so 3 at a time with a pause between rounds; raise only if the feed copes.
const FETCH_CAP = 3;

/** Fetches rows `cap` at a time (pause between rounds), keeps characters inside the band, stops once `limit` are kept. A row whose own level is outside the band is never fetched. */
export async function collectInBand(all: NinjaRow[], fetchOne: (row: NinjaRow) => Promise<RealCharacter | null>, o: { limit: number; cap: number; band?: LevelBand; pauseMs?: number }): Promise<RealCharacter[]> {
  const rows = o.band ? all.filter((r) => r.level === undefined || (r.level >= o.band!.min && r.level <= o.band!.max)) : all;
  const out: RealCharacter[] = [];
  for (let i = 0; i < rows.length && out.length < o.limit; i += o.cap) {
    if (i > 0) await new Promise((r) => setTimeout(r, o.pauseMs ?? 1500));
    const got = await Promise.all(rows.slice(i, i + o.cap).map(fetchOne));
    for (const c of got) if (c && out.length < o.limit && (!o.band || (c.level >= o.band.min && c.level <= o.band.max))) out.push(c);
  }
  return out;
}

async function fetchCharacter(version: string, q: (e: Record<string, string>) => string, row: NinjaRow): Promise<RealCharacter | null> {
  const c = (await (await get(`${BASE}/builds/${version}/character?${q({ account: row.account, name: row.name })}`)).json()) as { level?: number; class?: string; ascendancyClassName?: string; pathOfBuildingExport?: string; defensiveStats?: { life?: number; energyShield?: number } };
  if (!c.pathOfBuildingExport) return null;
  return { account: row.account, name: row.name, level: c.level ?? 0, className: c.class ?? '', ascendancy: c.ascendancyClassName ?? '', life: c.defensiveStats?.life ?? 0, energyShield: c.defensiveStats?.energyShield ?? 0, ...(row.ehp ? { ninjaEhp: row.ehp } : {}), ...(row.dps ? { ninjaDps: row.dps } : {}), buildCode: c.pathOfBuildingExport };
}

/** Up to `limit` characters of `skill` in the current league (or `league`, a poe.ninja id) at the stage's snapshot, each with its build code. */
export async function fetchRealBuilds(o: { skill: string; stage: Stage; ascendancy?: string; limit: number; band?: LevelBand; league?: string }): Promise<{ league: string; snapshot: string; total: number; characters: RealCharacter[] }> {
  const lg = pickLeague((await (await get(`${BASE}/data/index-state`)).json()) as IndexState, o.league);
  const snap = SNAPSHOT[o.stage];
  if (snap && lg.timeMachineLabels && !lg.timeMachineLabels.includes(snap)) throw new Error(`poe.ninja keeps no ${snap} snapshot of ${lg.name}.`);
  const q = (extra: Record<string, string>) => new URLSearchParams({ overview: lg.snapshotName, type: 'exp', ...(snap ? { timemachine: snap } : {}), ...extra }).toString();
  const found = parseSearch(new Uint8Array(await (await get(`${BASE}/builds/${lg.version}/search?${q({ skills: o.skill, ...(o.ascendancy ? { class: o.ascendancy } : {}) })}`)).arrayBuffer()));
  const characters = await collectInBand(found.rows, (row) => fetchCharacter(lg.version, q, row), { limit: o.limit, cap: FETCH_CAP, band: o.band ?? BAND[o.stage] });
  return { league: lg.name, snapshot: snap ?? 'now', total: found.total, characters };
}
