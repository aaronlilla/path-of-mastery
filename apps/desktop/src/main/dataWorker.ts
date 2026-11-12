/**
 * Reads and trims the big game data files (gems, skills, passive trees: 1 to 10 MB of JSON each) on a worker thread, so
 * parsing them never stalls the main process. Each job runs on its own short-lived thread and returns only what the
 * callers read; `runDataJob` is the main-process side.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { GameInfo, SpectreInfo, TreeNodeInfo } from '../shared/library.js';
import type { TreeInfo } from './character/convert.js';
import type { ItemData } from './character/items.js';

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function needJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

// ---- character import (character/data.ts) ----------------------------------------------------------------------------

async function itemData(dir: string): Promise<ItemData> {
  const [bases, gems, forName, vaal] = await Promise.all([
    needJson<Record<string, Record<string, unknown>>>(join(dir, 'data_itemBases.json')),
    needJson<Record<string, Record<string, unknown>>>(join(dir, 'data_gems.json')),
    needJson<Record<string, string>>(join(dir, 'data_gemForBaseName.json')),
    needJson<Record<string, string>>(join(dir, 'data_gemGrantedEffectIdForVaalGemId.json')),
  ]);
  // Only the fields the import reads cross back to the main process (copying all of data_gems costs as much as parsing it).
  const pick = (row: Record<string, unknown>, keys: string[]) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) if (k in row) o[k] = row[k];
    return o;
  };
  const b: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(bases)) b[k] = pick(v, ['type', 'weapon', 'armour', 'flask', 'tincture']);
  const g: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(gems)) g[k] = pick(v, ['id', 'gameId', 'variantId', 'grantedEffectId', 'name']);
  // The Vaal map is keyed by the Vaal gem's key; upstream reads it by the granted effect id of the base gem.
  const vaalGemFor: Record<string, string> = {};
  for (const [effectId, vaalKey] of Object.entries(vaal)) vaalGemFor[effectId] = vaalKey;
  return { bases: b as ItemData['bases'], gems: g as unknown as ItemData['gems'], gemForBaseName: forName, vaalGemFor };
}

interface RawTree {
  classes: Record<string, { name: string; classes?: Record<string, { name?: string }> }>;
  jewelSlots?: number[];
  nodes: Record<string, { type?: string; ascendancyName?: string; isMultipleChoiceOption?: boolean }>;
  secondaryAscendNameMap?: Record<string, { ascendClassId?: number } | { $ref: string }>;
  ascendNameMap?: Record<string, { ascendClassId?: number }>;
  tattoo?: { nodes?: Record<string, { dn?: string; icon?: string; activeEffectImage?: string; sd?: string[] }> };
}

async function treeInfo(dir: string, version: string): Promise<TreeInfo> {
  const raw = await needJson<RawTree>(join(dir, `tree_${version}.json`));
  const classes: TreeInfo['classes'] = [];
  for (const [id, c] of Object.entries(raw.classes)) {
    const asc: string[] = [];
    for (const [ai, a] of Object.entries(c.classes ?? {})) {
      const n = Number(ai);
      if (n >= 1 && a.name) asc[n - 1] = a.name;
    }
    classes[Number(id)] = { name: c.name, ascendancies: asc };
  }
  const secondaryAscend: Record<string, number> = {};
  for (const [name, v] of Object.entries(raw.ascendNameMap ?? {})) {
    if (raw.secondaryAscendNameMap && name in raw.secondaryAscendNameMap && typeof v.ascendClassId === 'number') secondaryAscend[name] = v.ascendClassId;
  }
  const nodes: TreeInfo['nodes'] = {};
  for (const [id, n] of Object.entries(raw.nodes)) nodes[id] = { ...(n.type ? { type: n.type } : {}), ...(n.ascendancyName ? { ascendancyName: n.ascendancyName } : {}), ...(n.isMultipleChoiceOption ? { isMultipleChoiceOption: true } : {}) };
  const tattoos: TreeInfo['tattoos'] = {};
  for (const [name, t] of Object.entries(raw.tattoo?.nodes ?? {})) if (name && t.dn) tattoos[name] = { dn: t.dn, icon: t.icon ?? '', activeEffectImage: t.activeEffectImage ?? '', sd: t.sd ?? [] };
  return { classes, jewelSlots: raw.jewelSlots ?? [], nodes, secondaryAscend, tattoos };
}

// ---- game data for the screens (gameData.ts) --------------------------------------------------------------------------

interface GemRow {
  name?: string;
  baseTypeName?: string;
  tagString?: string;
  grantedEffect?: { color?: number; support?: boolean };
}

/** Gem name to attribute colour and support flag. Missing data gives empty tables, never made-up ones. */
async function gameInfo(dir: string): Promise<GameInfo> {
  const gems: GameInfo['gems'] = {};
  const rows = await readJson<Record<string, GemRow>>(join(dir, 'data_gems.json'));
  for (const g of Object.values(rows ?? {})) {
    const color = g.grantedEffect?.color;
    const attr = color === 1 ? 'str' : color === 2 ? 'dex' : color === 3 ? 'int' : '';
    const support = !!g.grantedEffect?.support || /\bSupport\b/.test(g.tagString ?? '');
    for (const n of [g.name, g.baseTypeName]) if (n && !gems[n]) gems[n] = { attr, support };
  }
  return { gems };
}

/** A 32-bit FNV-1a hash, never 0. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) || 1;
}

/** The node's own icon in the skill sheet (the "...Active" sprite of its type). */
function spriteOf(sprites: Record<string, Record<string, unknown>> | undefined): { sp?: [number, number, number] } {
  if (!sprites) return {};
  const key = Object.keys(sprites).find((k) => /Active$/.test(k) && !/^mastery/i.test(k));
  const c = key ? sprites[key] : undefined;
  if (!c) return {};
  const x = Number(c['1']);
  const y = Number(c['2']);
  const w = Number(c['3']) - x;
  return Number.isFinite(x) && Number.isFinite(y) && w > 0 ? { sp: [x, y, w] } : {};
}

async function treeNodes(dir: string, version: string): Promise<Record<string, TreeNodeInfo>> {
  const t = await readJson<{ nodes: Record<string, { id?: number; dn?: string; name?: string; type?: string; ascendancyName?: string; isMastery?: boolean; isJewelSocket?: boolean; modKey?: string; sprites?: Record<string, Record<string, unknown>> }> }>(join(dir, `tree_${version}.json`));
  if (!t) throw new Error(`no tree data for ${version}`);
  const out: Record<string, TreeNodeInfo> = {};
  for (const [id, n] of Object.entries(t.nodes)) {
    out[id] = { n: n.dn ?? n.name ?? id, t: n.type ?? 'Normal', ...(n.ascendancyName ? { a: n.ascendancyName } : {}), ...(n.modKey ? { k: hash(n.modKey) } : {}), ...(n.isJewelSocket ? { j: 1 as const } : {}), ...spriteOf(n.sprites) };
  }
  return out;
}

interface SpectreRow {
  name?: string;
  life?: number;
  energyShield?: number;
  armour?: number;
  evasion?: number;
  fireResist?: number;
  coldResist?: number;
  lightningResist?: number;
  chaosResist?: number;
  damage?: number;
  attackTime?: number;
  skillList?: string[];
}

/** The spectres of `data.spectres` with the figures the library's tooltip shows and its skills by name. */
async function spectres(dir: string): Promise<Record<string, SpectreInfo>> {
  const rows = (await readJson<Record<string, SpectreRow>>(join(dir, 'data_spectres.json'))) ?? {};
  const skills = (await readJson<Record<string, { name?: string }>>(join(dir, 'data_skills.json'))) ?? {};
  const out: Record<string, SpectreInfo> = {};
  for (const [id, m] of Object.entries(rows)) {
    out[id] = {
      name: m.name ?? id,
      life: m.life ?? 1,
      ...(m.energyShield ? { energyShield: m.energyShield } : {}),
      ...(m.armour ? { armour: m.armour } : {}),
      ...(m.evasion ? { evasion: m.evasion } : {}),
      resist: { fire: m.fireResist ?? 0, cold: m.coldResist ?? 0, lightning: m.lightningResist ?? 0, chaos: m.chaosResist ?? 0 },
      damage: m.damage ?? 1,
      attackTime: m.attackTime ?? 1,
      skills: (m.skillList ?? []).map((s) => skills[s]?.name).filter((n): n is string => !!n),
    };
  }
  return out;
}

// ---- the thread -------------------------------------------------------------------------------------------------------

const jobs = { itemData, treeInfo, gameInfo, treeNodes, spectres };
type Jobs = typeof jobs;
export type DataJob = keyof Jobs;

/** Runs one job on a fresh worker thread and resolves with its (structured-cloned) result. */
export function runDataJob<K extends DataJob>(kind: K, ...args: Parameters<Jobs[K]> extends [string, ...infer R] ? R : never): Promise<Awaited<ReturnType<Jobs[K]>>> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { kind, dir: process.env.POM_ENGINE_DATA ?? '', args } });
    let done = false;
    w.once('message', (m: { ok: true; value: Awaited<ReturnType<Jobs[K]>> } | { ok: false; error: string }) => {
      done = true;
      if (m.ok) resolve(m.value);
      else reject(new Error(m.error));
    });
    w.once('error', (e) => {
      done = true;
      reject(e);
    });
    w.once('exit', (code) => {
      if (!done) reject(new Error(`game data worker stopped (${code})`));
    });
  });
}

if (!isMainThread && parentPort && (workerData as { kind?: string } | null)?.kind) {
  const { kind, dir, args } = workerData as { kind: DataJob; dir: string; args: string[] };
  const port = parentPort;
  void (jobs[kind] as (dir: string, ...a: string[]) => Promise<unknown>)(dir, ...args).then(
    (value) => port.postMessage({ ok: true, value }),
    (e: unknown) => port.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
}
