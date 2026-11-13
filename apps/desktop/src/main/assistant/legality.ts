// Can this item exist in game? The craft limit, mods the base cannot roll or the bench cannot craft, the affix limits, one mod per
// group, and influence, all read from the engine's mod pool (`modPool`, the one the craft tools use). The checks lane calls
// `buildLegality` for its check 6; the slot bill calls `itemLegality` before it searches for an item that cannot exist.
import type { ItemMod, PoolMod } from '@pom/protocol';
import { readEquipped } from './buildReaders.js';
import type { ToolContext } from './tools.js';

export type LegalityKind = 'craftLimit' | 'notOnBase' | 'affixLimit' | 'sameGroup' | 'influence';
export interface LegalityIssue {
  slot: string;
  item: string;
  kind: LegalityKind;
  /** One plain sentence in player words. */
  text: string;
}

const CLASSIC = new Set(['shaper', 'elder', 'crusader', 'redeemer', 'hunter', 'warlord', 'eyrie', 'basilisk', 'adjudicator']);
const ALL_CLASSIC = ['shaper', 'elder', 'crusader', 'redeemer', 'hunter', 'warlord'];
const MULTIMOD = /^Can have up to \d+ Crafted Modifiers$/i;
const ALLOWED_LINE = /^([+-]\d+) (Prefix|Suffix) Modifiers? allowed$/i;
const DEFENCE_LINE = /^#% increased ((?:Armour|Evasion|Energy Shield)(?:(?:, | and )(?:Armour|Evasion|Energy Shield))*)$/;

/** A mod line with its numbers and signs left out, so a roll and the pool's range read the same. */
export const lineShape = (s: string): string =>
  s
    .replace(/\{[^}]*\}/g, '')
    .replace(/\(-?\d+(?:\.\d+)?-+-?\d+(?:\.\d+)?\)|-?\d+(?:\.\d+)?/g, '#')
    .replace(/[+-]#/g, '#')
    .trim();

/** Whether every number of a rolled line sits inside the range of the pool's stat text ("+(25-28) to Dexterity"). */
const inRange = (line: string, stat: string): boolean => {
  const rolls = line.replace(/\{[^}]*\}/g, '').match(/-?\d+(?:\.\d+)?/g) ?? [];
  const spans = [...stat.matchAll(/\((-?\d+(?:\.\d+)?)-+(-?\d+(?:\.\d+)?)\)|(-?\d+(?:\.\d+)?)/g)].map((m) => (m[3] ? [Number(m[3]), Number(m[3])] : [Number(m[1]), Number(m[2])]));
  return rolls.length === spans.length && rolls.every((r, i) => Number(r) >= spans[i]![0]! && Number(r) <= spans[i]![1]!);
};

/** The item's explicit mods, minus lines the player wrote by hand and Foulborn swaps. */
const explicitOf = (mods: ItemMod[]): ItemMod[] => mods.filter((m) => m.bucket === 'explicit' && !m.custom && !m.mutated);

interface Index {
  /** shape -> the pool mods that carry it. */
  byShape: Map<string, PoolMod[]>;
  /** modifiers with more than one stat line: the item prints one line per stat. */
  hybrids: PoolMod[];
  prefixOf: Map<PoolMod, boolean>;
}

function indexOf(pool: { prefixes: PoolMod[]; suffixes: PoolMod[] }): Index {
  const ix: Index = { byShape: new Map(), hybrids: [], prefixOf: new Map() };
  for (const [isPrefix, mods] of [[true, pool.prefixes], [false, pool.suffixes]] as const) {
    for (const m of mods) {
      ix.prefixOf.set(m, isPrefix);
      if (m.stats.length > 1) ix.hybrids.push(m);
      for (const s of m.stats) ix.byShape.set(lineShape(s.text), [...(ix.byShape.get(lineShape(s.text)) ?? []), m]);
    }
  }
  ix.hybrids.sort((a, b) => b.stats.length - a.stats.length);
  return ix;
}

/** The beastcraft lines the item editor offers (shape -> whether it is a prefix); they sit outside the mod pool and print as plain lines. */
async function beastcraft(ctx: ToolContext, itemText: string): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  try {
    const { pool } = (await ctx.engine.send('itemPool', { itemText, kind: 'mods' })) as { pool: { sources?: Array<{ id?: string; mods?: Array<{ lines?: string[]; type?: string }> }> } | null };
    for (const m of pool?.sources?.find((x) => x.id === 'BEASTCRAFT')?.mods ?? []) for (const l of m.lines ?? []) out.set(lineShape(l), m.type === 'Prefix');
  } catch {
    // an engine without the editor lists gives no beastcraft lines: the line is then judged against the pool alone
  }
  return out;
}

/** The lines the base itself carries as implicits, read from a fresh item of it. */
async function baseImplicits(ctx: ToolContext, base: string): Promise<string[]> {
  try {
    return ((await ctx.engine.send('itemCraft', { base, rarity: 'NORMAL' })) as { text: string }).text.split('\n').map((l) => l.trim());
  } catch {
    return [];
  }
}

/** One modifier of the item: a single line, or the lines of one hybrid. */
interface Unit {
  lines: ItemMod[];
  /** The modifier group when the pool names exactly one. */
  group: string | null;
  crafted: boolean;
  /** The pool modifier a hybrid's lines were matched to. */
  hybrid?: PoolMod;
}

/** Why an item cannot exist, or an empty list. Never throws: an item the engine cannot read gets no verdict. */
export async function itemLegality(ctx: ToolContext, slot: string, itemText: string): Promise<LegalityIssue[]> {
  try {
    const info = (await ctx.engine.send('itemInfo', { itemText })).item;
    if (!info?.baseName || !/^(RARE|MAGIC)$/i.test(String(info.rarity ?? ''))) return [];
    const itemLevel = info.itemLevel ?? 84;
    const influences = info.influences ?? [];
    const item = info.name && info.name !== info.baseName ? `${info.name} (${info.baseName})` : info.baseName;
    const out: LegalityIssue[] = [];
    const flag = (kind: LegalityKind, text: string) => out.push({ slot, item, kind, text });

    const classic = influences.filter((i) => CLASSIC.has(i));
    if (influences.length && info.canInfluence === false) flag('influence', `${info.baseName} cannot carry an influence, and this one has ${influences.join(' and ')}.`);
    if (classic.length > 2) flag('influence', `The item has ${classic.length} influences (${classic.join(', ')}); an item holds two at most.`);

    const { pool } = await ctx.engine.send('modPool', { base: info.baseName, itemLevel, influences });
    const ix = indexOf(pool);
    // what the item would need if it had every influence: names the influence a mod is missing
    const all = indexOf((await ctx.engine.send('modPool', { base: info.baseName, itemLevel, influences: ALL_CLASSIC })).pool);

    // units: lines that are the stats of one hybrid modifier first (largest first), then each remaining line alone
    const mods = explicitOf(info.mods ?? []);
    const used = new Set<ItemMod>();
    const units: Unit[] = [];
    for (const h of ix.hybrids) {
      // an unveiled hybrid prints as plain lines in the game and as {crafted} lines when the bench made it; a veiled one is either, never mixed
      for (const crafted of h.source === 'veiled' ? [false, true] : [h.source === 'bench']) {
        // a plain line is the veiled mod's own roll only when it sits inside that mod's range
        const pick = h.stats.map((st) => mods.find((m) => !used.has(m) && m.crafted === crafted && lineShape(m.text) === lineShape(st.text) && (h.source !== 'veiled' || crafted || inRange(m.text, st.text))));
        if (pick.some((x) => !x) || new Set(pick).size < pick.length) continue;
        for (const m of pick as ItemMod[]) used.add(m);
        units.push({ lines: pick as ItemMod[], group: h.group, crafted, hybrid: h });
        break;
      }
    }
    for (const m of mods.filter((x) => !used.has(x))) {
      const g = new Set((ix.byShape.get(lineShape(m.text)) ?? []).filter((c) => c.stats.length === 1).map((c) => c.group));
      units.push({ lines: [m], group: g.size === 1 ? [...g][0]! : null, crafted: m.crafted });
    }

    const beast = mods.some((m) => !m.crafted && !ix.byShape.has(lineShape(m.text))) ? await beastcraft(ctx, itemText) : new Map<string, boolean>();

    // bench crafts: each must be a craft the bench offers on this base, and an item holds one unless it has the multimod
    const d = info.defences as Record<string, number> | null | undefined;
    let benchCrafts = 0;
    let multimod = false;
    for (const u of units.filter((x) => x.crafted)) {
      const m = u.lines[0]!;
      const k = lineShape(m.text);
      if (MULTIMOD.test(m.text)) {
        multimod = true;
        benchCrafts++;
        continue;
      }
      const cands = u.hybrid ? [u.hybrid] : ix.byShape.get(k) ?? [];
      if (cands.some((c) => c.source === 'bench')) benchCrafts++;
      else if (!cands.some((c) => c.source === 'veiled')) flag('notOnBase', `"${m.text}" is marked as a bench craft, but the bench offers no such craft on ${info.baseName}${cands.length ? ' (it can only be rolled, not crafted)' : ''}.`);
      // the bench pool lists armour, evasion and energy shield crafts for every glove, boot and helmet: the base must have that defence
      const named = d ? DEFENCE_LINE.exec(k)?.[1] : undefined;
      if (d && named) {
        const missing = [...named.matchAll(/Armour|Evasion|Energy Shield/g)].map((w) => w[0]).filter((w) => !(d[w === 'Energy Shield' ? 'EnergyShieldBase' : `${w}Base`]! > 0));
        if (missing.length) flag('notOnBase', `"${m.text}" cannot be crafted on ${info.baseName}: the base has no ${missing.join(' or ')}.`);
      }
    }
    const limit = multimod ? 3 : 1;
    if (benchCrafts > limit) flag('craftLimit', `${benchCrafts} bench crafts on one item; it holds ${limit}${multimod ? '' : ' without "Can have up to 3 Crafted Modifiers"'}.`);

    // rolled lines: the base must be able to roll them, with the influence they need
    for (const u of units.filter((x) => !x.crafted && !x.hybrid)) {
      const m = u.lines[0]!;
      const k = lineShape(m.text);
      if (ix.byShape.has(k) || beast.has(k)) continue;
      const infl = (all.byShape.get(k) ?? []).find((p) => p.source === 'influence' || p.source === 'elevated')?.influence;
      if (infl) flag('influence', `"${m.text}" needs ${infl} influence, and the item has ${influences.length ? influences.join(' and ') : 'none'}.`);
      else flag('notOnBase', `"${m.text}" is not a modifier ${info.baseName} can roll at item level ${itemLevel}.`);
    }

    // one modifier per group (a crafted life roll beside a rolled one is refused at the bench)
    const groups = new Map<string, string>();
    for (const u of units) {
      if (!u.group) continue;
      const text = u.lines.map((l) => l.text).join(' / ');
      if (groups.has(u.group)) flag('sameGroup', `"${groups.get(u.group)}" and "${text}" are the same modifier group; an item holds one of them.`);
      else groups.set(u.group, text);
    }

    // affix limits, one per unit; a line the pool places as both prefix and suffix and the item does not tag is left out
    let pfx = 0;
    let sfx = 0;
    for (const u of units) {
      const m = u.lines[0]!;
      const sides = new Set((ix.byShape.get(lineShape(m.text)) ?? []).map((c) => ix.prefixOf.get(c)));
      const side = u.hybrid ? ix.prefixOf.get(u.hybrid) : m.prefix ? true : m.suffix ? false : sides.size === 1 ? [...sides][0] : beast.get(lineShape(m.text));
      if (side === true) pfx++;
      else if (side === false) sfx++;
    }
    // "-1 Prefix Modifier allowed" and its kin (Cogwork, Helical, Geodesic rings...) move the limits, but only as the base's own implicit lines
    const own = (info.mods ?? []).some((m) => ALLOWED_LINE.test(m.text.trim())) ? await baseImplicits(ctx, info.baseName) : [];
    const shifts: Array<[string, number]> = [];
    for (const m of info.mods ?? []) {
      const a = ALLOWED_LINE.exec(m.text.trim());
      const at = a ? own.indexOf(m.text.trim()) : -1;
      if (a && at >= 0) shifts.push([a[2]!.toLowerCase(), Number(a[1])]), own.splice(at, 1);
    }
    const moved = (word: string) => shifts.reduce((n, [w, by]) => (w === word ? n + by : n), 0);
    const held = (base: number, word: string) => Math.max(0, Math.min(base + moved(word), 2 * base));
    const pl = held(info.rarity === 'MAGIC' ? Math.min(1, pool.prefixLimit) : pool.prefixLimit, 'prefix');
    const sl = held(info.rarity === 'MAGIC' ? Math.min(1, pool.suffixLimit) : pool.suffixLimit, 'suffix');
    if (pfx > pl) flag('affixLimit', `${pfx} prefixes on one item; it holds ${pl}.`);
    if (sfx > sl) flag('affixLimit', `${sfx} suffixes on one item; it holds ${sl}.`);
    return out;
  } catch {
    return [];
  }
}

/** Every equipped rare or magic item of a build text checked; the findings come back in the shape the assessment lists (`hard`: it cannot exist in game). */
export async function buildLegality(ctx: ToolContext, xml: string): Promise<{ issues: LegalityIssue[]; findings: Array<{ id: string; hard: boolean; text: string }> }> {
  const issues: LegalityIssue[] = [];
  for (const it of readEquipped(xml)) if (/rare|magic/i.test(it.rarity)) issues.push(...(await itemLegality(ctx, it.slot, it.text)));
  return { issues, findings: issues.map((i, n) => ({ id: `legal:${i.kind}:${n}`, hard: true, text: `${i.slot}: ${i.text}` })) };
}
