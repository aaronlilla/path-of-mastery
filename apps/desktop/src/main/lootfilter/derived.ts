import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResistAffix } from '../../shared/lootfilter/buildRules.js';
import { reduceBases, type BaseInfo } from '../../shared/lootfilter/bases.js';
import { countHidden } from '../../shared/lootfilter/hiddenCount.js';
import { STRICTNESS } from '../../shared/lootfilter/styles.js';
import type { EngineBases, HiddenCounts } from '../../shared/lootfilter/ipcTypes.js';
import type { NeverSinkStore } from './neversink.js';

/**
 * Numbers that come from running every item through each of the seven NeverSink files. It takes a few seconds,
 * so the answer is cached next to the user's data, keyed by the NeverSink version.
 */
export async function hiddenCounts(ns: NeverSinkStore, version: string, cacheDir: string, bases: BaseInfo[] = []): Promise<HiddenCounts> {
  // hidden2: counts that include stack-size, rarity and class rules and the engine's gear bases. The first version only counted catalogued names.
  const file = join(cacheDir, `hidden2-${version}-${bases.length}.json`);
  try {
    const cached = JSON.parse(await readFile(file, 'utf8')) as HiddenCounts;
    if (cached.version === version && cached.hidden?.length === STRICTNESS.length) return cached;
  } catch {
    // compute below
  }
  const texts: string[] = [];
  for (const s of STRICTNESS) texts.push(await ns.readOne(version, s.id));
  const out = await countHidden(version, texts, bases, () => new Promise((r) => setImmediate(r)));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + '.tmp', JSON.stringify(out), 'utf8');
  await rename(file + '.tmp', file);
  return out;
}

/** Item bases from the engine's game data. Unavailable data is reported, not invented. */
export async function engineBases(dataDir: string): Promise<EngineBases> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, 'data_itemBases.json'), 'utf8')) as Record<string, unknown>;
    const bases = reduceBases(raw as Parameters<typeof reduceBases>[0]);
    return { available: bases.length > 0, bases };
  } catch (e) {
    return { available: false, bases: [], note: `The engine's item data was not found at ${dataDir}.` };
  }
}

/** Resistance suffixes from the engine's item data: name, item level and roll range, for the elements a build can be under cap in. */
export async function resistAffixes(dataDir: string): Promise<ResistAffix[]> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, 'data_itemMods.json'), 'utf8')) as { Explicit?: Record<string, Record<string, unknown>> };
    const out: ResistAffix[] = [];
    for (const [id, m] of Object.entries(raw.Explicit ?? {})) {
      // The ordinary ladder only (ColdResist1 to ColdResist8), not essence, Delve or other special suffixes.
      if (m.type !== 'Suffix' || !/^(Fire|Cold|Lightning)Resist\d+$/.test(id)) continue;
      const t = m['1'];
      const mm = typeof t === 'string' ? /^\+\((\d+)-(\d+)\)% to (Fire|Cold|Lightning) Resistance$/.exec(t) : null;
      if (!mm || !/Resist/.test(String(m.group)) || String(m.group).startsWith('All')) continue;
      out.push({ element: mm[3] as ResistAffix['element'], affix: String(m.affix), level: Number(m.level), min: Number(mm[1]), max: Number(mm[2]) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Support gem names from the engine's gem data, as a build file writes them (the game's item adds " Support"). */
export async function supportGemNames(dataDir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, 'data_gems.json'), 'utf8')) as Record<string, { name?: string; baseTypeName?: string; tags?: Record<string, boolean> }>;
    const skills = new Set<string>();
    const supports = new Set<string>();
    for (const g of Object.values(raw)) {
      const n = g.baseTypeName ?? g.name;
      if (!n) continue;
      (g.tags?.support ? supports : skills).add(n);
    }
    return [...supports].filter((n) => !skills.has(n));
  } catch {
    return [];
  }
}
