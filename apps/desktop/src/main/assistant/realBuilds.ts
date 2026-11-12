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

/** The ladder rows of a search answer: account, name and poe.ninja's EHP text ("12k") per row, plus how many characters match. */
export function parseSearch(buf: Uint8Array): { total: number; rows: Array<{ account: string; name: string; ehp?: string }> } {
  const top = fields(buf);
  const rootBytes = top?.find((x) => x.f === 1 && typeof x.v !== 'number')?.v;
  const root = rootBytes && typeof rootBytes !== 'number' ? fields(rootBytes) : null;
  if (!root) throw new Error('poe.ninja sent an answer this app cannot read.');
  const total = Number(root.find((x) => x.f === 1)?.v ?? 0);
  const lists = new Map<string, string[]>();
  for (const x of root) {
    if (x.f !== 12 || typeof x.v === 'number') continue;
    const m = fields(x.v) ?? [];
    const name = text(m.find((y) => y.f === 1)?.v ?? 0);
    lists.set(name, m.filter((y) => y.f === 7).map((y) => text(y.v)));
  }
  const names = lists.get('name') ?? [], accts = lists.get('account') ?? [], ehp = lists.get('ehp__str') ?? [];
  return { total, rows: names.map((name, i) => ({ name, account: accts[i] ?? '', ...(ehp.length === names.length ? { ehp: ehp[i] } : {}) })) };
}

const get = async (url: string): Promise<Response> => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`poe.ninja answered ${r.status}.`);
  return r;
};

export interface RealCharacter { account: string; name: string; level: number; className: string; ascendancy: string; life: number; energyShield: number; ninjaEhp?: string; buildCode: string }

export type LevelBand = { min: number; max: number };
// Day-3 league-start kits are level 85-90; later snapshots are not banded.
const BAND: Record<Stage, LevelBand | undefined> = { 'league-start': { min: 85, max: 90 }, 'week-1': undefined, mid: undefined };
// shortcut: poe.ninja is slow and rate-limited, so 3 at a time with a pause between rounds; raise only if the feed copes.
const FETCH_CAP = 3;

/** Fetches rows `cap` at a time (pause between rounds), keeps characters inside the band, stops once `limit` are kept. */
export async function collectInBand(rows: Array<{ account: string; name: string; ehp?: string }>, fetchOne: (row: { account: string; name: string; ehp?: string }) => Promise<RealCharacter | null>, o: { limit: number; cap: number; band?: LevelBand; pauseMs?: number }): Promise<RealCharacter[]> {
  const out: RealCharacter[] = [];
  for (let i = 0; i < rows.length && out.length < o.limit; i += o.cap) {
    if (i > 0) await new Promise((r) => setTimeout(r, o.pauseMs ?? 1500));
    const got = await Promise.all(rows.slice(i, i + o.cap).map(fetchOne));
    for (const c of got) if (c && out.length < o.limit && (!o.band || (c.level >= o.band.min && c.level <= o.band.max))) out.push(c);
  }
  return out;
}

async function fetchCharacter(version: string, q: (e: Record<string, string>) => string, row: { account: string; name: string; ehp?: string }): Promise<RealCharacter | null> {
  const c = (await (await get(`${BASE}/builds/${version}/character?${q({ account: row.account, name: row.name })}`)).json()) as { level?: number; class?: string; ascendancyClassName?: string; pathOfBuildingExport?: string; defensiveStats?: { life?: number; energyShield?: number } };
  if (!c.pathOfBuildingExport) return null;
  return { account: row.account, name: row.name, level: c.level ?? 0, className: c.class ?? '', ascendancy: c.ascendancyClassName ?? '', life: c.defensiveStats?.life ?? 0, energyShield: c.defensiveStats?.energyShield ?? 0, ...(row.ehp ? { ninjaEhp: row.ehp } : {}), buildCode: c.pathOfBuildingExport };
}

/** Up to `limit` characters of `skill` in the current league at the stage's snapshot, each with its build code. */
export async function fetchRealBuilds(o: { skill: string; stage: Stage; ascendancy?: string; limit: number; band?: LevelBand }): Promise<{ league: string; snapshot: string; total: number; characters: RealCharacter[] }> {
  const state = (await (await get(`${BASE}/data/index-state`)).json()) as { snapshotVersions?: Array<{ type: string; version: string; snapshotName: string; name: string }> };
  const lg = state.snapshotVersions?.find((s) => s.type === 'exp');
  if (!lg) throw new Error('poe.ninja lists no current league.');
  const snap = SNAPSHOT[o.stage];
  const q = (extra: Record<string, string>) => new URLSearchParams({ overview: lg.snapshotName, type: 'exp', ...(snap ? { timemachine: snap } : {}), ...extra }).toString();
  const found = parseSearch(new Uint8Array(await (await get(`${BASE}/builds/${lg.version}/search?${q({ skills: o.skill, ...(o.ascendancy ? { class: o.ascendancy } : {}) })}`)).arrayBuffer()));
  const characters = await collectInBand(found.rows, (row) => fetchCharacter(lg.version, q, row), { limit: o.limit, cap: FETCH_CAP, band: o.band ?? BAND[o.stage] });
  return { league: lg.name, snapshot: snap ?? 'now', total: found.total, characters };
}
