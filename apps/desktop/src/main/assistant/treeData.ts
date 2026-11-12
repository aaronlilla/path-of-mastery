import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tattoo } from '../../renderer/tree/tattoos.js';

/** What the assistant needs to know about a passive tree node. */
export interface TreeNodeInfo {
  id: number;
  name: string;
  /** Normal, Notable, Keystone, Mastery, Socket, ClassStart or AscendClassStart. */
  type: string;
  stats: string[];
  ascendancy?: string;
  /** A mastery's effects: the id `pickMastery` takes and the effect's stat lines. */
  effects?: Array<{ id: number; stats: string[] }>;
  /** An ascendancy choice node that costs no ascendancy point (Ascendant's, Scion's picks). */
  multipleChoiceOption?: boolean;
  ascendancyStart?: boolean;
  /** The length of upstream's `linkedId`, which the tattoo rules count. */
  linked?: number;
}

interface RawTattoo {
  dn?: string;
  sd?: unknown;
  reminderText?: unknown;
  targetType?: string;
  targetValue?: string;
  MinimumConnected?: number;
  legacy?: boolean;
  icon?: string;
  activeEffectImage?: string;
}

interface RawNode {
  id: number;
  name?: string;
  dn?: string;
  type?: string;
  sd?: string[];
  ascendancyName?: string;
  masteryEffects?: Array<{ effect: number; stats?: unknown }>;
  isMultipleChoiceOption?: boolean;
  isAscendancyStart?: boolean;
  in?: unknown;
  out?: unknown;
}

export function engineDataDir(): string {
  return process.env.POM_ENGINE_DATA ?? '';
}

/** Node names and stat lines of the passive tree, read from the engine's exported tree file. */
/** A class with its ascendancies (`ascendClassId` is the position, 1-based) as the tree lists them. */
export interface TreeClassInfo {
  classId: number;
  name: string;
  ascendancies: Array<{ ascendClassId: number; name: string }>;
}

interface LoadedTree {
  nodes: Map<number, TreeNodeInfo>;
  classes: TreeClassInfo[];
  /** Secondary ascendancies (bloodlines): the id `setClass` takes as `secondaryAscendClassId`. */
  bloodlines: Array<{ secondaryAscendClassId: number; name: string }>;
  /** The tree's tattoo table, as the Tree tab's dialog lists it. */
  tattoos: Tattoo[];
}

export class TreeData {
  private cache = new Map<string, Promise<LoadedTree>>();

  constructor(private readonly dir: string = engineDataDir()) {}

  private load(version: string): Promise<LoadedTree> {
    let p = this.cache.get(version);
    if (!p) {
      p = (async () => {
        const raw = JSON.parse(await readFile(join(this.dir, `tree_${version}.json`), 'utf8')) as {
          nodes: Record<string, RawNode>;
          masteryEffects?: Record<string, { sd?: unknown }>;
          tattoo?: { nodes?: Record<string, RawTattoo> };
          classes?: Record<string, { name?: string; classes?: unknown }>;
          alternate_ascendancies?: Record<string, { name?: string }>;
        };
        // The dump shares repeated tables by reference ({"$ref": "tree.nodes.89.masteryEffects[1].stats"}, Lua indexes).
        const deref = (v: unknown): unknown => {
          for (let guard = 0; v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { $ref?: unknown }).$ref === 'string' && guard < 8; guard++) {
            let cur: unknown = raw;
            for (const t of (v as { $ref: string }).$ref.replace(/^tree\b\.?/, '').split(/\.|(?=\[)/).filter(Boolean)) {
              const m = /^\[(\d+)\]$/.exec(t);
              if (m && Array.isArray(cur)) cur = cur[Number(m[1]) - 1] ?? cur[Number(m[1])];
              else cur = (cur as Record<string, unknown> | undefined)?.[m ? m[1]! : t];
            }
            v = cur;
          }
          return v;
        };
        const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
        const map = new Map<number, TreeNodeInfo>();
        for (const n of Object.values(raw.nodes)) {
          if (typeof n.id !== 'number') continue;
          map.set(n.id, {
            id: n.id,
            name: n.dn ?? n.name ?? `Node ${n.id}`,
            type: n.type ?? 'Normal',
            stats: lines(deref(n.sd)),
            ...(n.ascendancyName ? { ascendancy: n.ascendancyName } : {}),
            ...(Array.isArray(n.masteryEffects) && n.masteryEffects.length
              ? { effects: n.masteryEffects.map((e) => ({ id: e.effect, stats: lines(deref(e.stats) ?? deref(raw.masteryEffects?.[e.effect]?.sd)) })) }
              : {}),
            ...(n.isMultipleChoiceOption ? { multipleChoiceOption: true } : {}),
            ...(n.isAscendancyStart ? { ascendancyStart: true } : {}),
            // Upstream's `linkedId`: the node's out links and in links, counted as listed.
            linked: (Array.isArray(n.in) ? n.in.length : 0) + (Array.isArray(n.out) ? n.out.length : 0),
          });
        }
        const classes: TreeClassInfo[] = Object.entries(raw.classes ?? {}).map(([id, c]) => {
          const asc = deref(c.classes) as Record<string, { name?: string }> | Array<{ name?: string }> | undefined;
          const list = Array.isArray(asc) ? asc.map((a, i) => [String(i), a] as const) : Object.entries(asc ?? {});
          return { classId: Number(id), name: c.name ?? '', ascendancies: list.filter(([k, a]) => Number(k) > 0 && a?.name).map(([k, a]) => ({ ascendClassId: Number(k), name: a.name! })) };
        });
        const bloodlines = Object.entries(raw.alternate_ascendancies ?? {}).map(([k, a]) => ({ secondaryAscendClassId: Number(k), name: a.name ?? '' }));
        // The same list scripts/build-tattoos.mjs writes for the Tree tab.
        const tattoos: Tattoo[] = [];
        for (const [key, n] of Object.entries(raw.tattoo?.nodes ?? {})) {
          const sd = deref(n.sd);
          if (!key || !n.dn || !Array.isArray(sd)) continue;
          const reminder = (deref(n.reminderText) as unknown[] | undefined)?.[0];
          tattoos.push({
            key,
            dn: n.dn,
            sd: sd.map(String),
            ...(typeof reminder === 'string' && reminder ? { reminder } : {}),
            targetType: n.targetType ?? '',
            targetValue: n.targetValue ?? '',
            minConnected: n.MinimumConnected ?? 0,
            ...(n.legacy ? { legacy: true } : {}),
            icon: n.icon ?? '',
            effectImage: n.activeEffectImage ?? '',
          });
        }
        return { nodes: map, classes, bloodlines, tattoos };
      })();
      p.catch(() => this.cache.delete(version));
      this.cache.set(version, p);
    }
    return p;
  }

  async node(version: string, id: number): Promise<TreeNodeInfo | undefined> {
    return (await this.load(version)).nodes.get(id);
  }

  /** The tree's tattoos (none before 3.21). */
  async tattoos(version: string): Promise<Tattoo[]> {
    return (await this.load(version)).tattoos;
  }

  async classes(version: string): Promise<Pick<LoadedTree, 'classes' | 'bloodlines'>> {
    const t = await this.load(version);
    return { classes: t.classes, bloodlines: t.bloodlines };
  }

  /** Every node of the tree (for budget counts and ranking). */
  async all(version: string): Promise<Map<number, TreeNodeInfo>> {
    return (await this.load(version)).nodes;
  }

  async nodes(version: string, ids: number[]): Promise<Array<TreeNodeInfo | { id: number; name: string; type: string; stats: string[] }>> {
    const m = (await this.load(version)).nodes;
    return ids.map((id) => m.get(id) ?? { id, name: `Node ${id}`, type: 'Normal', stats: [] });
  }

  /** Nodes whose name or stat text contains every word of the query (case-insensitive). Notables and keystones first. */
  async search(version: string, query: string, limit = 12): Promise<TreeNodeInfo[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const m = (await this.load(version)).nodes;
    const rank = (t: string) => (t === 'Keystone' ? 0 : t === 'Notable' ? 1 : t === 'Mastery' ? 3 : 2);
    const hits: TreeNodeInfo[] = [];
    for (const n of m.values()) {
      if (n.type === 'ClassStart' || n.type === 'AscendClassStart') continue;
      const hay = (n.name + ' ' + n.stats.join(' ')).toLowerCase();
      if (words.every((w) => hay.includes(w))) hits.push(n);
    }
    hits.sort((a, b) => rank(a.type) - rank(b.type) || a.name.length - b.name.length);
    return hits.slice(0, limit);
  }
}

/** Attribute colour of a gem by name, from the engine's gem table (1 red/Str, 2 green/Dex, 3 blue/Int, otherwise white). */
export class GemColours {
  private map: Promise<Map<string, 'str' | 'dex' | 'int' | 'white'>> | null = null;

  constructor(private readonly dir: string = engineDataDir()) {}

  private load() {
    this.map ??= (async () => {
      const raw = JSON.parse(await readFile(join(this.dir, 'data_gems.json'), 'utf8')) as Record<string, { baseTypeName?: string; name?: string; grantedEffect?: { color?: number } }>;
      const m = new Map<string, 'str' | 'dex' | 'int' | 'white'>();
      for (const g of Object.values(raw)) {
        // support gems carry only `name` (every support read as white before)
        const n = g.baseTypeName ?? g.name;
        if (!n) continue;
        const c = g.grantedEffect?.color;
        if (!m.has(n.toLowerCase())) m.set(n.toLowerCase(), c === 1 ? 'str' : c === 2 ? 'dex' : c === 3 ? 'int' : 'white');
      }
      return m;
    })();
    this.map.catch(() => (this.map = null));
    return this.map;
  }

  async of(name: string): Promise<'str' | 'dex' | 'int' | 'white'> {
    const m = await this.load().catch(() => new Map<string, 'str' | 'dex' | 'int' | 'white'>());
    const key = name.toLowerCase();
    return m.get(key) ?? m.get(key.replace(/ support$/, '')) ?? m.get(`${key} support`) ?? 'white';
  }
}
