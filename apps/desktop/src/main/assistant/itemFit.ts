// What a player keeps when they put a new item in a slot: the old item's sockets,
// links, quality and anoint, the base's own implicit, socket colours that fit the gems, a bench craft for a resist the swap
// dropped, and every special thing the old item gave, named with what the engine says it was worth.
// Shared by trial() (proposeEdit, previewEquip) and bestSupport (gem colours).
import type { ItemInfo, PoolMod } from '@pom/protocol';
import { activeSetOf, readItems } from '../../shared/itemsXml.js';
import { formatStat, statMeta } from '../../shared/assistant/statLabels.js';
import { readConfig, readEquipped, readSkills } from './buildReaders.js';
import { GemColours } from './treeData.js';
import type { Scalar, ToolContext } from './tools.js';

const num = (s: Record<string, Scalar>, id: string) => (typeof s[id] === 'number' ? (s[id] as number) : 0);
export const COLOUR = { str: 'R', dex: 'G', int: 'B', white: 'W' } as const;
const COLOUR_WORD: Record<string, string> = { R: 'red', G: 'green', B: 'blue', W: 'white' };

/**
 * `line` ("R-B-G-G-B-G", "-" a link, " " none) recoloured as little as possible so every gem colour in `need` has a socket
 * (white sockets take any gem). Links and socket count stay. shortcut: colours are matched per item, not per linked group;
 * per-group matching when an item carries two link groups of different colours.
 */
export function socketFit(line: string, need: string[]): { fits: boolean; sockets: string; missing: string[] } {
  const cols = line.trim().split(/[- ]/);
  const seps = line.trim().match(/[- ]/g) ?? [];
  const used = cols.map(() => false);
  const miss: string[] = [];
  for (const c of need.filter((x) => x !== 'W')) {
    const i = cols.findIndex((x, j) => !used[j] && x === c);
    if (i >= 0) used[i] = true;
    else miss.push(c);
  }
  const missing = [...miss];
  for (let k = miss.length - 1; k >= 0; k--) {
    const i = cols.findIndex((x, j) => !used[j] && x === 'W');
    if (i >= 0) { used[i] = true; miss.splice(k, 1); }
  }
  const out = [...cols];
  for (const c of miss) {
    const i = out.findIndex((x, j) => !used[j] && x !== 'A');
    if (i < 0) break;
    out[i] = c;
    used[i] = true;
  }
  return { fits: miss.length === 0, sockets: out.map((c, i) => c + (seps[i] ?? '')).join(''), missing: miss.length ? missing : [] };
}

/** The item text in `slot` of the active item set, or null. */
export function slotItemText(xml: string, slot: string): string | null {
  const m = readItems(xml);
  const id = activeSetOf(m).slots.get(slot)?.itemId;
  return (id && m.items.find((i) => i.id === id)?.text) || null;
}

/** Colours (R/G/B/W) of every gem socketed in `slot`, in group order, with the gem names. */
export async function slotGems(ctx: ToolContext, xml: string, slot: string): Promise<Array<{ name: string; colour: string }>> {
  const gems = readSkills(xml).filter((g) => g.slot === slot && !g.fromItem).flatMap((g) => g.gems).filter((g) => g.name);
  const colours = ctx.gems ?? new GemColours();
  return Promise.all(gems.map(async (g) => ({ name: g.name, colour: COLOUR[await colours.of(g.name)] })));
}

const header = (text: string, key: string) => text.split('\n').find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2).trim() ?? null;

/** Sets (or adds, before the implicits) one header line such as "Quality: 20". */
export function setHeader(text: string, key: string, value: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${key}: `));
  if (at >= 0) lines[at] = `${key}: ${value}`;
  else {
    // before the implicits, else after the header lines (never above Rarity: the engine reads rarity from line 1)
    let i = lines.findIndex((l) => l.startsWith('Implicits: '));
    if (i < 0) i = headerEnd(lines);
    lines.splice(i, 0, `${key}: ${value}`);
  }
  return lines.join('\n');
}

/** Index after Rarity, the name, the base and any "Key: value" header lines. */
function headerEnd(lines: string[]): number {
  const r = Math.max(0, lines.findIndex((l) => l.startsWith('Rarity: ')));
  let i = /UNIQUE|RARE/.test(lines[r] ?? '') ? r + 3 : r + 2;
  while (i < lines.length && /^[A-Za-z][A-Za-z ]*: /.test(lines[i]!)) i++;
  return Math.min(i, lines.length);
}

/** Rows of explicit bench crafts: {crafted} rows after the Implicits block (the import writes lab enchants as {crafted} inside it) that are not anoints. */
export function benchCraftRows(text: string): number[] {
  const rows = text.split('\n');
  const at = rows.findIndex((l) => l.startsWith('Implicits: '));
  const end = at < 0 ? 0 : at + 1 + (parseInt(rows[at]!.slice(11), 10) || 0);
  return rows.flatMap((r, i) => (i >= end && /\{crafted\}(?!Allocates )/.test(r) ? [i] : []));
}

/** Adds implicit lines (an "Implicits: n" line is made when missing, after the header lines). */
function addImplicits(text: string, add: string[]): string {
  const lines = text.split('\n');
  let at = lines.findIndex((l) => l.startsWith('Implicits: '));
  if (at < 0) {
    const i = headerEnd(lines);
    lines.splice(i, 0, 'Implicits: 0');
    at = i;
  }
  const n = parseInt(lines[at]!.slice(11), 10) || 0;
  lines[at] = `Implicits: ${n + add.length}`;
  lines.splice(at + 1 + n, 0, ...add);
  return lines.join('\n');
}

/** Old-item lines a player misses when they are gone: curses, granted skills, immunities, max resists, anoints, speed, leech. */
const SPECIAL = /Curse Enemies with|Grants Level|Socketed Gems|Cannot be (Chilled|Frozen|Shocked|Ignited|Poisoned|Stunned)|Avoid being (Chilled|Frozen|Shocked|Ignited|Poisoned|Stunned)|Avoid (Elemental Ailments|Bleeding)|[Ii]mmun|maximum .*Resistance|Allocates |Movement Speed|Action Speed|Leech|Curse|Aura|to all Elemental Resistances|to Chaos Resistance|chance to (Shock|Freeze|Ignite|Poison|cause Bleeding|inflict)|Cannot inflict|Life per Enemy Hit|Brittle|Sapped|Scorch/;
const SIGNED = /(?:(?<=^|[\s(+])-)?\d+(?:\.\d+)?/g;
const shape = (s: string) => s.replace(/\{[^}]*\}/g, '').replace(/\(\d+(\.\d+)?-\d+(\.\d+)?\)|\d+(\.\d+)?/g, '#').trim();

/**
 * A created item's rolls at the best the game has for that base and item level. A number above the highest tier any mod with
 * that line reaches is brought down to that maximum (+130 life, a roll no ring has). A number inside a tier
 * goes up to that tier's top, unless `exact` (the player named the numbers); each change is said with the tier and item level
 * (+33% where the tier gives +35%). Each explicit line is matched to the mod pool by shape; lines the pool does not
 * have are left as written.
 */
export async function clampRolls(ctx: ToolContext, text: string, base: string, itemLevel: number, exact = false, owned: Set<string> = new Set(), asked = ''): Promise<{ text: string; lines: string[] }> {
  const { pool } = await ctx.engine.send('modPool', { base, itemLevel });
  const best = new Map<string, number[]>();
  const tiers = new Map<string, Array<{ mod: PoolMod; values: Array<{ min: number; max: number }> }>>();
  for (const m of [...pool.prefixes, ...pool.suffixes]) {
    if (m.level > itemLevel) continue;
    for (const s of m.stats) {
      const k = shape(s.text);
      const was = best.get(k) ?? [];
      // a negative stat ("-# to Total Mana Cost") is best at its most negative roll
      best.set(k, s.values.map((v, i) => (v.max <= 0 ? Math.min(v.min, v.max, was[i] ?? Infinity) : Math.max(v.max, was[i] ?? -Infinity))));
      tiers.set(k, [...(tiers.get(k) ?? []), { mod: m, values: s.values }]);
    }
  }
  const rows = text.split('\n');
  const at = rows.findIndex((l) => l.startsWith('Implicits: '));
  const implicitEnd = at >= 0 ? at + 1 + (parseInt(rows[at]!.slice(11), 10) || 0) : 0;
  const lines: string[] = [];
  const out = rows.map((row0, i) => {
    // a line the player's item already has is real, whatever the pool says (31% rarity on Eater/Exarch gloves cut to 18%)
    if (owned.has(row0.trim())) return row0;
    let row = row0;
    // a line written as a range ("+(100-114) to maximum Life", as searchItemMods lists it) would roll in the middle: top of the range
    if (!/^[A-Za-z ]+: /.test(row0) && /\(-?\d+(\.\d+)?-\d+(\.\d+)?\)/.test(row0)) {
      row = row0.replace(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, (_, _a, b) => b);
      const t = (tiers.get(shape(row)) ?? []).find((x) => [...row0.matchAll(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g)].every((m, j) => x.values[j]?.min === Number(m[1]) && x.values[j]?.max === Number(m[2])));
      lines.push(`${row.replace(/^(\{[^}]*\})*/, '').trim()}: top of its range${t ? `, tier ${t.mod.tier} of ${t.mod.tiers}, ilvl ${t.mod.level}` : ''}`);
    }
    if (i < implicitEnd || /^\{crafted\}/.test(row)) return row;
    const max = best.get(shape(row));
    const tags = /^(\{[^}]*\})*/.exec(row)![0];
    const plain = row.slice(tags.length);
    // a minus after a space or at the start is the number's sign ("-6 to Total Mana Cost" became "--4"); "10-20" stays two numbers
    const nums = plain.match(SIGNED)?.map(Number) ?? [];
    if (!max || max.length !== nums.length) return row;
    const rewrite = (to: number[]) => { let j = 0; return plain.replace(SIGNED, () => String(to[j++])); };
    if (!nums.every((n, j) => (max[j]! < 0 ? n >= max[j]! : n <= max[j]!))) {
      const body = rewrite(nums.map((n, j) => (max[j]! < 0 ? Math.max(n, max[j]!) : Math.min(n, max[j]!))));
      // numbers the player typed themselves stay as asked: the line is flagged as not legal, never changed ("Adds 50 to 100" became "38 to 100")
      if (nums.every((n) => new RegExp(`(^|[^0-9.])${String(n).replace('.', '\\.')}(?![0-9])`).test(asked))) {
        lines.push(`Not a legal roll: ${plain.trim()}: ${base} at item level ${itemLevel} rolls at most ${body.trim()}; kept as you asked`);
        return row;
      }
      lines.push(`Lowered ${plain.trim()} to ${body.trim()}: the most this line can roll on ${base} at item level ${itemLevel}`);
      return tags + body;
    }
    if (exact) return row;
    // the best tier this base and item level give for that line (normal mods first): its top roll, never below what was written
    const bestTier = (tiers.get(shape(row)) ?? []).filter((t) => t.values.length === nums.length).sort((x, y) => Number(y.mod.source === 'normal') - Number(x.mod.source === 'normal') || x.mod.tier - y.mod.tier)[0];
    if (!bestTier) return row;
    const top = bestTier.values.map((v, j) => (v.max <= 0 ? Math.min(v.min, v.max, nums[j]!) : Math.max(v.max, nums[j]!)));
    if (nums.every((n, j) => n === top[j])) return row;
    const body = rewrite(top);
    lines.push(`${body.trim()}: top roll, tier ${bestTier.mod.tier} of ${bestTier.mod.tiers}, ilvl ${bestTier.mod.level} (was ${plain.trim()}; this item is ilvl ${itemLevel})`);
    return tags + body;
  });
  return { text: out.join('\n'), lines };
}

/** The short per-affix clauses the app prints under the answer itself: "+114 to maximum Life: tier 1 of 8, ilvl 44" (the model paraphrased the tier line away). */
export function rollNotes(itemLines: string[]): string[] {
  return itemLines.flatMap((l) => { const m = /^(.+?): top (?:roll|of its range), (tier \d+ of \d+, ilvl \d+)/.exec(l); return m ? [`${m[1]}: ${m[2]}`] : []; });
}

/** itemLines without the per-affix tier lines the app prints itself, so the model has nothing to restate. */
export const withoutRolls = (itemLines: string[]): string[] => itemLines.filter((l) => !/^.+?: top (?:roll|of its range), tier \d+ of \d+, ilvl \d+/.test(l));

export interface KeptItem {
  text: string;
  lines: string[];
  /** The old item's special lines the new one lacks. */
  lost: string[];
  /** A rare/magic/normal item put together for this change (open to bench crafts), not a unique. */
  created: boolean;
  info: ItemInfo;
  oldName: string | null;
}

/** The new item text for `slot` with what a player keeps from the old item (see the file comment). */
export async function keepOldItem(ctx: ToolContext, xml: string, slot: string, text: string, exact = false, asked = ''): Promise<KeptItem> {
  // no buildId: the app's AI gate refuses catalog commands that name a build (scopedContext GLOBAL_COMMANDS)
  const info = async (t: string) => (await ctx.engine.send('itemInfo', { itemText: t })).item;
  const old = slotItemText(xml, slot);
  const ni = await info(text);
  const oi = old ? await info(old) : null;
  const out: KeptItem = { text, lines: [], lost: [], created: false, info: ni, oldName: oi?.name ?? null };
  if (!ni.valid) return out;
  let t = text;
  out.created = ni.rarity !== 'UNIQUE' && ni.rarity !== 'RELIC' && !ni.corrupted && !ni.mirrored;
  const oldAnoint = old?.split('\n').map((l) => /Allocates (.+)$/.exec(l.replace(/\{[^}]*\}/g, '').trim())?.[1]).find(Boolean);
  if (out.created) {
    if (ni.baseName) {
      const owned = new Set(old && oi?.baseName === ni.baseName ? old.split('\n').map((l) => l.trim()).filter(Boolean) : []);
      const fixed = await clampRolls(ctx, t, ni.baseName, ni.itemLevel ?? 86, exact, owned, asked).catch(() => null);
      if (fixed?.lines.length) {
        t = fixed.text;
        out.lines.push(...fixed.lines);
      }
    }
    if (ni.baseName) {
      const craft = (await ctx.engine.send('itemCraft', { base: ni.baseName, rarity: 'RARE' }).catch(() => null))?.text ?? '';
      const lines = craft.split('\n');
      const at = lines.findIndex((l) => l.startsWith('Implicits: '));
      const impl = at >= 0 ? lines.slice(at + 1, at + 1 + (parseInt(lines[at]!.slice(11), 10) || 0)).filter(Boolean) : [];
      if (ni.implicitCount) {
        // an implicit the item text brought (12% rarity where the base rolls up to 20%) goes to the top of the base's range;
        // the player never names an implicit, so this holds for exact rolls too
        const rows = t.split('\n');
        const hdr = rows.findIndex((l) => l.startsWith('Implicits: '));
        for (let i = hdr + 1; hdr >= 0 && i <= hdr + (parseInt(rows[hdr]!.slice(11), 10) || 0); i++) {
          const tags = /^(\{[^}]*\})*/.exec(rows[i]!)![0];
          const plain = rows[i]!.slice(tags.length);
          // the player's own item in the slot keeps its rolled implicit (a craft on Dragon Grasp raised its +18% chaos to +23%)
          if (old && oi?.baseName === ni.baseName && old.split('\n').some((l) => l.trim() === rows[i]!.trim())) continue;
          const nums = plain.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
          for (const b of impl.filter((x) => shape(x) === shape(plain))) {
            const rg = [...b.matchAll(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
            if (rg.length !== nums.length || !nums.every((n, j) => n >= rg[j]![0] && n <= rg[j]![1]) || nums.every((n, j) => n === rg[j]![1])) continue;
            let j = 0;
            const body = plain.replace(/\d+(\.\d+)?/g, () => String(rg[j++]![1]));
            out.lines.push(`Raised the implicit ${plain.trim()} to ${body.trim()}: the top of the ${ni.baseName} implicit range`);
            rows[i] = tags + body;
            break;
          }
        }
        t = rows.join('\n');
      }
      if (!ni.implicitCount && impl.length) {
        // the base's own implicit rolls in a range: a created item gets its top (+20% where +23% was possible)
        const topRoll = impl.map((l) => l.replace(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, (_, _a, b) => b));
        t = addImplicits(t, topRoll);
        out.lines.push(`Added the ${ni.baseName} implicit every one has, at the top of its range: ${topRoll.join('; ')}`);
      }
    }
    if (oi && oi.type === ni.type) {
      if (ni.baseName) {
        const whole = await wholeCrafts(ctx, old!, t, ni.baseName).catch(() => null);
        if (whole?.lines.length) {
          t = whole.text;
          out.lines.push(...whole.lines);
        }
      }
      if (oldAnoint && ni.anointable && !/Allocates /.test(t)) {
        t = addImplicits(t, [`{crafted}Allocates ${oldAnoint}`]);
        out.lines.push(`Kept the anoint from ${oi.name}: Allocates ${oldAnoint} (anoint the new one with the same oils)`);
      }
      if (!ni.noQuality && !(ni.quality && ni.quality > 0) && (oi.quality ?? 0) > 0) {
        t = setHeader(t, 'Quality', String(oi.quality));
        out.lines.push(`Kept quality ${oi.quality} from ${oi.name}`);
      }
      const oldSockets = header(old!, 'Sockets');
      // the engine gives a socketless text default sockets, so the text's own header decides (the boots' gems lost their home)
      if (!header(t, 'Sockets') && oldSockets && (ni.socketLimit ?? 0) > 0) {
        t = setHeader(t, 'Sockets', oldSockets);
        out.lines.push(`Kept the sockets and links of ${oi.name}: ${oldSockets}`);
      }
    }
    const sockets = header(t, 'Sockets');
    const gems = sockets ? await slotGems(ctx, xml, slot) : [];
    if (sockets && gems.length) {
      const fit = socketFit(sockets, gems.map((g) => g.colour));
      if (!fit.fits) {
        t = setHeader(t, 'Sockets', fit.sockets);
        out.lines.push(`Socket colours ${sockets} did not fit the gems in ${slot} (${gems.map((g) => `${g.name} ${COLOUR_WORD[g.colour]}`).join(', ')}): set to ${fit.sockets}. In game that is a recolour with Chromatic Orbs or the crafting bench`);
      }
    }
  }
  if (oi) {
    const have = new Set((await info(t)).mods?.map((m) => shape(m.text)) ?? []);
    for (const m of oi.mods ?? []) {
      if (!SPECIAL.test(m.text) || have.has(shape(m.text))) continue;
      if (/Allocates /.test(m.text) && /Allocates /.test(t)) continue;
      out.lost.push(m.text);
    }
    const gems = await slotGems(ctx, xml, slot);
    const room = (header(t, 'Sockets') ?? '').split(/[- ]/).filter(Boolean).length;
    if (gems.length > room && (oi.sockets?.length ?? 0) > room) out.lost.push(`sockets for ${gems.map((g) => g.name).join(', ')} (the new item has ${room})`);
  }
  out.text = t;
  return out;
}

/**
 * The engine's worth of each lost line: the line put back on the new item in `slot`, one preview each. "not counted by the
 * engine" when nothing moves (a curse the build's numbers never used): the player still loses it in game. `unset` is the enemy
 * condition config (Brittle, Shocked...) that only the old item applied: the change unticks it so the numbers stop counting it.
 */
const ENEMY_CONDITION: Array<[RegExp, string, string]> = [[/Brittle/, 'conditionEnemyBrittle', 'Brittle'], [/Shock/, 'conditionEnemyShocked', 'Shocked'], [/Chill/, 'conditionEnemyChilled', 'Chilled'], [/Freeze/, 'conditionEnemyFrozen', 'Frozen'], [/Ignite/, 'conditionEnemyIgnited', 'Ignited'], [/Sap/, 'conditionEnemySapped', 'Sapped'], [/Scorch/, 'conditionEnemyScorched', 'Scorched']];

export async function lostWorth(ctx: ToolContext, buildId: string, slot: string, text: string, lost: string[], oldName: string | null, xml = ''): Promise<{ lines: string[]; unset: string[] }> {
  const out: string[] = [];
  const unset: string[] = [];
  const config = xml ? readConfig(xml) : [];
  for (const line of lost) {
    if (line.startsWith('sockets for ')) { out.push(`Lost from ${oldName ?? 'the old item'}: ${line}`); continue; }
    const r = await ctx.engine.send('previewEdit', { buildId, edit: { kind: 'setItem', slot, itemText: `${text}\n${line}` }, full: true }).catch(() => null);
    const rows = (r?.statDiff.changed ?? []).filter((c) => ['FullDPS', 'CombinedDPS', 'TotalEHP', 'Life', 'ChaosResist', 'FireResist', 'ColdResist', 'LightningResist', 'EffectiveMovementSpeedMod'].includes(c.statId) && typeof c.before === 'number' && typeof c.after === 'number' && c.before !== c.after);
    const worth = rows.slice(0, 3).map((c) => `${statMeta(c.statId).label} ${formatStat(c.statId, c.after as number)} instead of ${formatStat(c.statId, c.before as number)}`).join(', ');
    // the old item applied an ailment the config still forces on the enemy: the numbers after the swap still count it (Brittle)
    const cond = ENEMY_CONDITION.find(([re, key]) => re.test(line) && /chance to|inflict/i.test(line) && !/Cannot|Avoid/.test(line) && config.some((c) => c.name === key && c.value === true));
    // Brittle, Sap and Scorch come only from "chance to inflict" mods, so with no other item giving one the box is unticked; a
    // shock or chill can also come from crits or cold hits, so that is only said
    const exotic = !!cond && /Brittle|Sap|Scorch/.test(cond[2]) && !readItems(xml).items.some((i) => i.text !== slotItemText(xml, slot) && cond[0].test(i.text) && /chance to/i.test(i.text));
    if (cond && exotic) unset.push(cond[1]);
    const stale = !cond ? '' : exotic ? `; the config set the enemy as always ${cond[2]} and nothing else applies it, so that is now unticked and the numbers no longer count it` : `; the config still sets the enemy as ${cond[2]}: check something else still applies it`;
    out.push(`Lost from ${oldName ?? 'the old item'}: ${line} (${worth ? `with it: ${worth}` : 'not counted by the engine; still gone in game'}${stale})`);
  }
  return { lines: out, unset };
}

/**
 * Buffs a gem grants that the engine counts only when the config says the player has them (Fortify gave Fortification,
 * the config box was off, so swapping Fortify out read as free). shortcut: gem sources only, item sources (Onslaught on kill
 * rings, fortify on stun) not read; add them when a task needs it.
 */
export const GEM_BUFFS: Array<{ gem: RegExp; key: string; buff: string }> = [
  { gem: /^Fortify( Support)?$/i, key: 'buffFortification', buff: 'Fortification' },
  { gem: /^Onslaught( Support)?$/i, key: 'buffOnslaught', buff: 'Onslaught' },
  { gem: /^Arcane Surge( Support)?$/i, key: 'buffArcaneSurge', buff: 'Arcane Surge' },
];
const hasBuffGem = (xml: string, re: RegExp) => readSkills(xml).some((g) => g.enabled && g.gems.some((x) => x.enabled && re.test(x.name)));
const BUFF_STATS = /^(Physical|Fire|Cold|Lightning|Chaos)MaximumHitTaken$|^TotalEHP$|^CombinedDPS$|^FullDPS$/;

/** What having `key` on is worth on `buildId`: the rows that move when the config box is ticked (`on`) or, when it is already ticked, unticked. */
export async function buffWorth(ctx: ToolContext, buildId: string, key: string, on = true): Promise<Array<{ statId: string; without: number; with: number }>> {
  const r = await ctx.engine.send('previewEdit', { buildId, edit: { kind: 'setConfig', key, value: on }, full: true }).catch(() => null);
  return (r?.statDiff.changed ?? []).filter((c) => BUFF_STATS.test(c.statId) && typeof c.before === 'number' && typeof c.after === 'number' && c.before !== c.after)
    .map((c) => (on ? { statId: c.statId, without: c.before as number, with: c.after as number } : { statId: c.statId, without: c.after as number, with: c.before as number }));
}

/**
 * Buffs the change took away (the last gem granting one is gone), with what they were worth on `buildId` (the build after the
 * change). `unset`: a config box that still claims the buff, to untick so the numbers stop counting it.
 */
export async function lostBuffs(ctx: ToolContext, buildId: string, xmlBefore: string, xmlAfter: string): Promise<{ lines: string[]; unset: string[] }> {
  const lines: string[] = [];
  const unset: string[] = [];
  const config = readConfig(xmlBefore);
  for (const b of GEM_BUFFS) {
    if (!hasBuffGem(xmlBefore, b.gem) || hasBuffGem(xmlAfter, b.gem)) continue;
    const ticked = config.some((c) => c.name === b.key && c.value === true);
    if (ticked) unset.push(b.key);
    const worth = ticked ? [] : await buffWorth(ctx, buildId, b.key);
    const rows = worth.map((w) => `${statMeta(w.statId).label} ${formatStat(w.statId, w.without)} instead of ${formatStat(w.statId, w.with)}`).join(', ');
    lines.push(`Loses ${b.buff} (its only source was the ${b.buff === 'Fortification' ? 'Fortify' : b.buff} gem)${ticked ? ': the config said the build has it, so that is now unticked and the numbers show the loss' : rows ? `: ${rows}` : ': the engine shows no number for it, still gone in game'}`);
  }
  return { lines, unset };
}

/**
 * Skill groups the new item in `slot` has no room for (the Mark of Submission ring was the only home of Temporal
 * Chains; the ring that replaced it has no sockets, yet the group stayed on). `xml` is the build with the new item in. A group
 * is orphaned when it is on, sits in `slot`, has more gems than the item has sockets (its own Sockets line, else `socketLimit`)
 * and one of its skills is in no other group that is on. `dead` lists the lines on the other equipped items that name the skill.
 */
export function orphanedGroups(xml: string, slot: string, socketLimit: number, newText?: string): Array<{ group: number; skills: string[]; dead: string[] }> {
  const text = newText ?? slotItemText(xml, slot);
  const header = text?.split('\n').find((l) => l.startsWith('Sockets: '))?.slice(9) ?? '';
  const sockets = header ? header.split(/[- ]/).filter(Boolean).length : socketLimit;
  const groups = readSkills(xml);
  const on = groups.filter((g) => g.enabled);
  const out: Array<{ group: number; skills: string[]; dead: string[] }> = [];
  for (const g of on.filter((x) => x.slot === slot && x.gems.length > sockets)) {
    const skills = g.gems.filter((x) => !x.support && x.name).map((x) => x.name).filter((n) => !on.some((o) => o !== g && o.gems.some((x) => x.name === n)));
    if (!skills.length) continue;
    const dead = readEquipped(xml).filter((i) => i.slot !== slot).flatMap((i) => i.text.split('\n').map((l) => l.replace(/\{[^}]*\}/g, '').trim()).filter((l) => skills.some((n) => l.toLowerCase().includes(n.toLowerCase()))).map((l) => `${i.name}: ${l}`));
    out.push({ group: g.index, skills, dead });
  }
  return out;
}

const RES = ['Fire', 'Cold', 'Lightning', 'Chaos'];
const ATTR: Array<[string, string]> = [['Str', 'Strength'], ['Dex', 'Dexterity'], ['Int', 'Intelligence']];
const top = (m: PoolMod) => m.stats.map((s) => s.text.replace(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, (_, _a, b) => b)).join('\n');

/**
 * A bench craft on the open suffix of a created item for what the swap dropped: an elemental resist off its cap, chaos resist
 * down, or an attribute now under what the gems and gear need (Blight Idol's Dexterity). The craft that gets the most
 * back (an attribute shortfall first: it switches gems off), checked on `buildId` (which has the new item on). Null when
 * nothing fell, the item already has a craft or has no open suffix.
 */
export async function benchResist(ctx: ToolContext, buildId: string, slot: string, kept: KeptItem, before: Record<string, Scalar>, after: Record<string, Scalar>): Promise<{ text: string; line: string } | null> {
  // an anoint is written as {crafted}Allocates but is not a bench craft
  if (!kept.created || benchCraftRows(kept.text).length || !kept.info.baseName) return null;
  const capOf = (s: Record<string, Scalar>, e: string) => num(s, `${e}ResistMax`) || 75;
  type Fell = { stat: string; cap: number; word: string; weight: number; fits: (t: string) => boolean };
  const fell: Fell[] = [
    ...RES.filter((e) => (e === 'Chaos' ? num(after, `${e}Resist`) < num(before, `${e}Resist`) : num(before, `${e}Resist`) >= capOf(before, e) && num(after, `${e}Resist`) < capOf(after, e)))
      .map((e) => ({ stat: `${e}Resist`, cap: capOf(after, e), word: `${e.toLowerCase()} resistance`, weight: 1, fits: (t: string) => t.includes(e) && /Resistance/.test(t) })),
    ...ATTR.filter(([a]) => num(before, a) >= num(before, `Req${a}`) && num(after, a) < num(after, `Req${a}`))
      .map(([a, word]) => ({ stat: a, cap: num(after, `Req${a}`), word: `the ${word} the gems and gear need`, weight: 10, fits: (t: string) => t.includes(word) && !/Resistance/.test(t) })),
  ];
  if (!fell.length) return null;
  const { pool } = await ctx.engine.send('modPool', { base: kept.info.baseName, itemLevel: kept.info.itemLevel ?? 84 });
  const sfx = new Set(pool.suffixes.flatMap((m) => m.stats.map((s) => shape(s.text))));
  const pfx = new Set(pool.prefixes.flatMap((m) => m.stats.map((s) => shape(s.text))));
  const explicit = (kept.info.mods ?? []).filter((m) => m.bucket === 'explicit' && !m.crafted);
  const suffixes = explicit.filter((m) => sfx.has(shape(m.text)) && !pfx.has(shape(m.text))).length;
  if (suffixes >= (kept.info.rarity === 'MAGIC' ? Math.min(1, pool.suffixLimit) : pool.suffixLimit)) return null;
  // best tier of each bench suffix group that names something that fell
  const best = new Map<string, PoolMod>();
  for (const m of pool.suffixes.filter((x) => x.source === 'bench' && x.level <= (kept.info.itemLevel ?? 84) && fell.some((f) => x.stats.some((s) => f.fits(s.text))))) {
    const b = best.get(m.group);
    if (!b || m.tier < b.tier) best.set(m.group, m);
  }
  let pick: { text: string; line: string; gain: number } | null = null;
  for (const m of best.values()) {
    const text = `${kept.text}\n{crafted}${top(m)}`;
    const r = await ctx.engine.send('previewEdit', { buildId, edit: { kind: 'setItem', slot, itemText: text }, full: true }).catch(() => null);
    if (!r || r.blocked) continue;
    const now = (f: Fell) => r.statDiff.changed.find((c) => c.statId === f.stat)?.after;
    const won = fell.filter((f) => { const v = now(f); return typeof v === 'number' && v > num(after, f.stat); });
    // ties go to the craft that also wins back resist the swap took above the cap (fire/chaos, not cold/chaos with cold
    // already over it): overcap is a buffer against exposure and map mods
    const total = (s: (id: string) => number, e: string) => s(`${e}Resist`) + s(`${e}ResistOverCap`);
    const nowNum = (id: string) => { const v = r.statDiff.changed.find((c) => c.statId === id)?.after; return typeof v === 'number' ? v : num(after, id); };
    const buffer = RES.filter((e) => e !== 'Chaos').reduce((a, e) => a + 0.01 * Math.max(0, Math.min(total(nowNum, e), total((id) => num(before, id), e)) - total((id) => num(after, id), e)), 0);
    const gain = won.reduce((a, f) => a + f.weight * (Math.min(now(f) as number, f.cap) - Math.min(num(after, f.stat), f.cap)), 0) + (won.length ? buffer : 0);
    if (gain > 0 && (!pick || gain > pick.gain)) pick = { text, gain, line: `Already in this change and counted in the numbers: bench-crafted ${top(m).replace(/\n/g, ', ')} on the new item's open suffix (crafting bench) to win back ${won.map((f) => f.word).join(' and ')} the swap cost` };
  }
  if (!pick) return null;
  await ctx.engine.send('edit', { buildId, edit: { kind: 'setItem', slot, itemText: pick.text } });
  return { text: pick.text, line: pick.line };
}

/**
 * The rolled explicit mods an edited text drops from the SAME item (same rarity, name and base lines): a rolled mod cannot be taken
 * off an owned item, so an edit like that is not something the player can do. A different item is a purchase and drops nothing.
 */
export function removedRolledMods(oldText: string, newText: string): string[] {
  const lines = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const o = lines(oldText);
  const n = lines(newText);
  if (o.length < 3 || n.length < 3 || o.slice(0, 3).join('|') !== n.slice(0, 3).join('|')) return [];
  const rolled = (l: string[]) => {
    const at = l.findIndex((x) => /^Implicits:\s*\d+/.test(x));
    const count = at >= 0 ? Number(/(\d+)/.exec(l[at]!)![1]) : 0;
    // header lines of the text (Sockets: ..., Quality: ...) are not mods
    return (at >= 0 ? l.slice(at + 1 + count) : l.slice(3)).filter((x) => !/\{crafted\}/.test(x) && !/^[A-Za-z ]{3,24}:(\s|$)/.test(x)).map((x) => x.replace(/^\{[^}]*\}/, '').trim());
  };
  // a line that is still on the item anywhere (an implicit count that changed, a tag that moved) is not removed
  const still = new Set(n.map((x) => x.replace(/^\{[^}]*\}/, '').trim()));
  return rolled(o).filter((x) => !still.has(x));
}

/** The rolled mods an edited text of the same item adds (what the edit was after): the lines to look for on a listing instead. */
export function addedRolledMods(oldText: string, newText: string): string[] {
  const lines = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const o = lines(oldText);
  const n = lines(newText);
  if (o.length < 3 || n.length < 3 || o.slice(0, 3).join('|') !== n.slice(0, 3).join('|')) return [];
  const rolled = (l: string[]) => {
    const at = l.findIndex((x) => /^Implicits:\s*\d+/.test(x));
    const count = at >= 0 ? Number(/(\d+)/.exec(l[at]!)![1]) : 0;
    return (at >= 0 ? l.slice(at + 1 + count) : l.slice(3)).filter((x) => !/\{crafted\}/.test(x)).map((x) => x.replace(/^\{[^}]*\}/, '').trim());
  };
  const had = new Set(rolled(o));
  return rolled(n).filter((x) => !had.has(x));
}

/** How many suffixes the item still has room for: the pool's limit minus its rolled (not crafted, not implicit) suffixes. */
export function openSuffixes(pool: { suffixLimit: number; suffixes: Array<{ stats: Array<{ text: string }> }>; prefixes: Array<{ stats: Array<{ text: string }> }> }, mods: Array<{ bucket?: string; text: string; crafted?: boolean }> | undefined, rarity?: string): number {
  const sfx = new Set(pool.suffixes.flatMap((m) => m.stats.map((s) => shape(s.text))));
  const pfx = new Set(pool.prefixes.flatMap((m) => m.stats.map((s) => shape(s.text))));
  const rolled = (mods ?? []).filter((m) => m.bucket === 'explicit' && !m.crafted && !/\{crafted\}/.test(m.text)).filter((m) => sfx.has(shape(m.text)) && !pfx.has(shape(m.text))).length;
  // a magic item holds one prefix and one suffix; the pool reports the rare limits
  return Math.max(0, (rarity === 'MAGIC' ? Math.min(1, pool.suffixLimit) : pool.suffixLimit) - rolled);
}

/**
 * The bench craft for accuracy on an owned rare with an open suffix: only the real bench mods (the pool's source 'bench', at the
 * item level), one craft per item, no other roll touched. Null when the item has no room, already has a craft, or nothing gains.
 */
export async function benchAccuracy(ctx: ToolContext, buildId: string, slot: string, kept: KeptItem, stat: string, start: number): Promise<{ text: string; line: string; value: number } | null> {
  if (!kept.created || benchCraftRows(kept.text).length || !kept.info.baseName) return null;
  const { pool } = await ctx.engine.send('modPool', { base: kept.info.baseName, itemLevel: kept.info.itemLevel ?? 84 });
  if (openSuffixes(pool, kept.info.mods, kept.info.rarity) <= 0) return null;
  const best = new Map<string, PoolMod>();
  for (const m of pool.suffixes.filter((x) => x.source === 'bench' && x.level <= (kept.info.itemLevel ?? 84) && x.stats.some((t) => /accuracy rating/i.test(t.text)))) {
    const b = best.get(m.group);
    if (!b || m.tier < b.tier) best.set(m.group, m);
  }
  let pick: { text: string; line: string; value: number } | null = null;
  for (const m of best.values()) {
    const text = `${kept.text}\n{crafted}${top(m)}`;
    const r = await ctx.engine.send('previewEdit', { buildId, edit: { kind: 'setItem', slot, itemText: text }, full: true }).catch(() => null);
    if (!r || r.blocked) continue;
    const c = r.statDiff.changed.find((x) => x.statId === stat);
    const value = typeof c?.after === 'number' ? c.after : start;
    if (value > (pick?.value ?? start)) pick = { text, value, line: top(m).replace(/\n/g, ', ') };
  }
  return pick;
}

/**
 * Bench crafts for mana sustain (Boneshatter short 5.8 mana a second): each equipped non-unique item with a suffix
 * open once its own craft is off (an item holds one craft; the old one goes as a whole and is named in `replaced`), with
 * each real bench suffix for mana regeneration, mana leech or mana cost at its best tier.
 */
export async function manaCrafts(ctx: ToolContext, xml: string): Promise<Array<{ slot: string; how: string; edit: { kind: 'setItem'; slot: string; itemText: string } }>> {
  const out: Array<{ slot: string; how: string; edit: { kind: 'setItem'; slot: string; itemText: string } }> = [];
  for (const slot of activeSetOf(readItems(xml)).slots.keys()) {
    if (/Jewel|Swap/.test(slot)) continue;
    const old = slotItemText(xml, slot);
    if (!old) continue;
    if (/^Flask \d$/.test(slot)) {
      // a utility flask's suffix the pool has for mana, in place of its own (the same swap as the immunity suffixes)
      const fi = (await ctx.engine.send('itemInfo', { itemText: old })).item;
      const swap = fi.valid ? await flaskSuffix(ctx, { text: old, info: fi }, /mana/i).catch(() => null) : null;
      if (swap) out.push({ slot, how: `${fi.name ?? slot} (${slot}): suffix ${swap.mod.affix} (${mid(swap.mod).replace(/\n/g, ', ')})${swap.gone.length ? ` in place of ${swap.gone.map(plainRow).join(', ')}` : ' on its open suffix'}`, edit: { kind: 'setItem', slot, itemText: swap.itemText } });
      continue;
    }
    out.push(...(await benchSuffixes(ctx, slot, old, /mana regeneration|regenerate .*mana|mana cost|leeched as mana|mana (gained )?(on|per enemy|for each enemy) hit|gain \d+ mana/i)));
  }
  return out;
}

/**
 * Each real bench suffix whose line matches `re`, at its best tier, on the non-unique item `old` in `slot` with a suffix open
 * once its own craft is off (an item holds one craft; the old one goes as a whole and is named in `how`).
 */
export async function benchSuffixes(ctx: ToolContext, slot: string, old: string, re: RegExp): Promise<Array<{ slot: string; how: string; replaced: string; itemLevel?: number; next?: { text: string; level: number }; edit: { kind: 'setItem'; slot: string; itemText: string } }>> {
  const craftAt = new Set(benchCraftRows(old));
  const text = old.split('\n').filter((_, i) => !craftAt.has(i)).join('\n');
  const replaced = old.split('\n').filter((_, i) => craftAt.has(i)).map(plainRow).join(', ');
  const info = (await ctx.engine.send('itemInfo', { itemText: text })).item;
  if (!info.valid || !info.baseName || info.rarity === 'UNIQUE' || info.rarity === 'RELIC' || info.corrupted || info.mirrored) return [];
  const { pool } = await ctx.engine.send('modPool', { base: info.baseName, itemLevel: info.itemLevel ?? 84 });
  if (openSuffixes(pool, info.mods, info.rarity) <= 0) return [];
  const best = new Map<string, PoolMod>();
  for (const m of pool.suffixes.filter((x) => x.source === 'bench' && x.level <= (info.itemLevel ?? 84) && x.stats.some((t) => re.test(t.text)))) {
    const b = best.get(m.group);
    if (!b || m.tier < b.tier) best.set(m.group, m);
  }
  // the better tier the item level keeps out, so a craft that stops short can say why (74% of a 75% cap)
  const nextTier = (m: PoolMod) => pool.suffixes.filter((x) => x.source === 'bench' && x.group === m.group && x.level > (info.itemLevel ?? 84)).sort((x, y) => x.level - y.level)[0];
  return [...best.values()].map((m) => ({ slot, replaced, itemLevel: info.itemLevel ?? 84, ...(nextTier(m) ? { next: { text: top(nextTier(m)!).replace(/\n/g, ', '), level: nextTier(m)!.level } } : {}), how: `bench-craft ${top(m).replace(/\n/g, ', ')} on ${info.name ?? slot} (${slot}${replaced ? `, replacing its ${replaced} craft` : ', open suffix'})`, edit: { kind: 'setItem', slot, itemText: `${text}\n{crafted}${top(m)}` } }));
}

/**
 * One bench craft for an elemental resist left under its cap after a change (cold 63% after the
 * points were spent and nobody said so): the first equipped non-unique item with an open suffix and no craft, using benchResist's
 * pick. The craft is applied on `buildId` (pass a scratch copy). Null when every elemental resist is capped or no item has room.
 */
export async function resistCraft(ctx: ToolContext, buildId: string, xml: string, after: Record<string, Scalar>, withChaos = false): Promise<{ line: string; edit: { kind: 'setItem'; slot: string; itemText: string } } | null> {
  const capOf = (e: string) => num(after, `${e}ResistMax`) || 75;
  // withChaos: the audit's craft also counts chaos under its cap (on some builds chaos is the smallest max hit)
  const short = ['Fire', 'Cold', 'Lightning', ...(withChaos ? ['Chaos'] : [])].filter((e) => num(after, `${e}Resist`) < capOf(e));
  if (!short.length) return null;
  // benchResist crafts for what fell from the cap: say each short resist was capped before
  const capped = { ...after, ...Object.fromEntries(short.map((e) => [`${e}Resist`, capOf(e)])) };
  for (const slot of activeSetOf(readItems(xml)).slots.keys()) {
    if (/Flask|Jewel|Swap/.test(slot)) continue;
    const text = slotItemText(xml, slot);
    if (!text) continue;
    const info = (await ctx.engine.send('itemInfo', { itemText: text })).item;
    if (!info.valid) continue;
    const kept: KeptItem = { text, lines: [], lost: [], created: info.rarity !== 'UNIQUE' && info.rarity !== 'RELIC' && !info.corrupted && !info.mirrored, info, oldName: info.name ?? null };
    const r = await benchResist(ctx, buildId, slot, kept, capped, after).catch(() => null);
    if (!r) continue;
    const { stats } = await ctx.engine.send('getStats', { buildId });
    const now = Object.fromEntries((stats as Array<{ id: string; value: unknown }>).map((s) => [s.id, s.value])) as Record<string, Scalar>;
    const craft = r.text.slice(text.length + 1).replace('{crafted}', '');
    return { line: `Bench-craft ${craft.replace(/\n/g, ', ')} on ${info.name ?? slot} (${slot}, open suffix): ${resistMoves(short, after, now, capOf).join(', ')}`, edit: { kind: 'setItem', slot, itemText: r.text } };
  }
  // no open suffix: a resist craft in place of an item's own craft, the one the engine finds moves the short resists most toward
  // their caps without taking another one under its cap (cold 33% under, no card offered)
  let best: { how: string; edit: { kind: 'setItem'; slot: string; itemText: string }; now: Record<string, Scalar>; score: number } | null = null;
  const re = new RegExp(`\\b(${short.join('|')})\\b.*Resistances?$|all Elemental Resistances$`);
  for (const slot of activeSetOf(readItems(xml)).slots.keys()) {
    const text = /Flask|Jewel|Swap/.test(slot) ? null : slotItemText(xml, slot);
    if (!text) continue;
    for (const c of await benchSuffixes(ctx, slot, text, re).catch(() => [])) {
      const p = await ctx.engine.send('previewEdit', { buildId, edit: c.edit, full: true }).catch(() => null);
      if (!p || p.blocked) continue;
      const now = { ...after };
      for (const d of p.statDiff.changed) if (d.after === null || typeof d.after !== 'object') now[d.statId] = d.after as Scalar;
      if (['Fire', 'Cold', 'Lightning'].some((e) => num(after, `${e}Resist`) >= capOf(e) && num(now, `${e}Resist`) < capOf(e))) continue;
      const score = short.reduce((a, e) => a + Math.min(num(now, `${e}Resist`), capOf(e)) - num(after, `${e}Resist`), 0);
      if (score > 0 && (!best || score > best.score)) best = { how: c.how, edit: c.edit, now, score };
    }
  }
  return best ? { line: `${best.how[0]!.toUpperCase()}${best.how.slice(1)}: ${resistMoves(short, after, best.now, capOf).join(', ')}`, edit: best.edit } : null;
}

/** "cold resistance 43% to 76% (cap 76%), cold max hit 18.7k -> 36.2k" for each short resist the fix moved, engine numbers. */
export function resistMoves(short: string[], after: Record<string, Scalar>, now: Record<string, Scalar>, capOf: (e: string) => number): string[] {
  return short.filter((e) => num(now, `${e}Resist`) > num(after, `${e}Resist`)).map((e) => `${e.toLowerCase()} resistance ${num(after, `${e}Resist`)}% to ${num(now, `${e}Resist`)}% (cap ${capOf(e)}%)${num(after, `${e}MaximumHitTaken`) ? `, ${e.toLowerCase()} max hit ${formatStat(`${e}MaximumHitTaken`, num(after, `${e}MaximumHitTaken`))} -> ${formatStat(`${e}MaximumHitTaken`, num(now, `${e}MaximumHitTaken`))}` : ''}`);
}

/**
 * A version of a created item that does better for `stat` when the asked one loses heavily (a +2 bow 28% under Soul
 * Siege, offered only Undo): the asked lines stay, and each open prefix and suffix gets the pool mod (best tier at the item
 * level, normal mods only) the engine rates highest, one slot at a time on `buildId` (previews only). Null when no affix is open.
 */
export async function betterItem(ctx: ToolContext, buildId: string, slot: string, kept: KeptItem, stat: string, start: number, opts: { limit?: number; only?: 'prefix' | 'suffix'; filter?: (m: PoolMod) => boolean } = {}): Promise<{ text: string; added: string[]; value: number } | null> {
  if (!kept.created || !kept.info.baseName) return null;
  const ilvl = kept.info.itemLevel ?? 86;
  const { pool } = await ctx.engine.send('modPool', { base: kept.info.baseName, itemLevel: ilvl });
  const sfx = new Set(pool.suffixes.flatMap((m) => m.stats.map((s) => shape(s.text))));
  const pfx = new Set(pool.prefixes.flatMap((m) => m.stats.map((s) => shape(s.text))));
  // a crafted mod holds an affix slot too
  const explicit = (kept.info.mods ?? []).filter((m) => m.bucket === 'explicit').map((m) => shape(m.text));
  const open = { prefix: pool.prefixLimit - explicit.filter((s) => pfx.has(s) && !sfx.has(s)).length, suffix: pool.suffixLimit - explicit.filter((s) => sfx.has(s)).length };
  if (open.prefix <= 0 && open.suffix <= 0) return null;
  // best tier of each group; a group the item already has is skipped
  const bestOf = (mods: PoolMod[]) => {
    const best = new Map<string, PoolMod>();
    for (const m of mods.filter((x) => x.source === 'normal' && x.level <= ilvl && (!opts.filter || opts.filter(x)) && !x.stats.some((s) => explicit.includes(shape(s.text))))) {
      const b = best.get(m.group);
      if (!b || m.tier < b.tier) best.set(m.group, m);
    }
    return [...best.values()];
  };
  const value = async (t: string) => {
    const r = await ctx.engine.send('previewEdit', { buildId, edit: { kind: 'setItem', slot, itemText: t }, full: true }).catch(() => null);
    const c = r && !r.blocked ? r.statDiff.changed.find((x) => x.statId === stat) : undefined;
    return typeof c?.after === 'number' ? c.after : null;
  };
  let text = kept.text;
  let now = start;
  const added: string[] = [];
  const used = new Set<string>();
  for (const [kind, mods] of [['prefix', pool.prefixes], ['suffix', pool.suffixes]] as const) {
    if (opts.only && opts.only !== kind) continue;
    for (let n = 0; n < open[kind] && added.length < (opts.limit ?? Infinity); n++) {
      let pick: { line: string; v: number; group: string } | null = null;
      for (const m of bestOf(mods).filter((x) => !used.has(x.group))) {
        const v = await value(`${text}\n${top(m)}`);
        if (v !== null && v > (pick?.v ?? now)) pick = { line: top(m), v, group: m.group };
      }
      if (!pick) break;
      text = `${text}\n${pick.line}`;
      now = pick.v;
      used.add(pick.group);
      added.push(pick.line.replace(/\n/g, ', '));
    }
  }
  return added.length ? { text, added, value: now } : null;
}

/** Each resist the change lowered, with where it ends against its cap (the old boots' +41% fire went unsaid). */
export function resistDrops(before: Record<string, Scalar>, after: Record<string, Scalar>): string[] {
  const out: string[] = [];
  for (const e of RES) {
    const tb = num(before, `${e}Resist`) + num(before, `${e}ResistOverCap`);
    const ta = num(after, `${e}Resist`) + num(after, `${e}ResistOverCap`);
    if (tb - ta < 1) continue;
    const cap = num(after, `${e}ResistMax`) || 75;
    const a = num(after, `${e}Resist`);
    out.push(`${e} resistance falls ${Math.round(tb - ta)}%: ${a >= cap ? `still capped at ${cap}%, ${Math.round(num(before, `${e}ResistOverCap`))}% over the cap to ${Math.round(num(after, `${e}ResistOverCap`))}% (less buffer against exposure and map mods)` : `${Math.round(num(before, `${e}Resist`))}% to ${Math.round(a)}%, ${Math.round(cap - a)}% under its ${cap}% cap`}`);
  }
  return out;
}

type SetItemOffer = { line: string; beatsOld: boolean; edits: Array<{ kind: 'setItem'; slot: string; itemText: string }> };

/**
 * A resist line on the new item that only adds resist over the cap. Before it is called useless, the engine says what the
 * build does with it: the line taken off, anything that moves (RF Chieftain turns every 1% of uncapped fire resistance into
 * 1 life regeneration per second) is said with its numbers and the line stays. When nothing moves, the slot gets the best
 * replacement the engine rates (a pool mod in the freed suffix, ranked by Combined DPS, else effective HP), offered as one tap.
 * `buildId` has the new item in `slot`; `after` are its stats, `before` the build's before the change.
 */
export async function wastedResists(ctx: ToolContext, buildId: string, slot: string, kept: KeptItem, before: Record<string, Scalar>, after: Record<string, Scalar>): Promise<{ lines: string[]; better: SetItemOffer | null }> {
  const lines: string[] = [];
  let better: SetItemOffer | null = null;
  const rows = kept.text.split('\n');
  const at = rows.findIndex((l) => l.startsWith('Implicits: '));
  const implicitEnd = at >= 0 ? at + 1 + (parseInt(rows[at]!.slice(11), 10) || 0) : 0;
  for (const [i, row] of rows.entries()) {
    const r = i < implicitEnd || /^\{crafted\}/.test(row) ? null : /^\+(\d+)% to (Fire|Cold|Lightning|Chaos) Resistance$/.exec(row.replace(/\{[^}]*\}/g, '').trim());
    if (!r) continue;
    const over = num(after, `${r[2]}ResistOverCap`);
    if (over < Number(r[1])) continue;
    const line = row.replace(/\{[^}]*\}/g, '').trim();
    const word = `${r[2]!.toLowerCase()} resistance`;
    const stripped = rows.filter((_, j) => j !== i).join('\n');
    const p = await ctx.engine.send('previewEdit', { buildId, edit: { kind: 'setItem', slot, itemText: stripped }, full: true }).catch(() => null);
    if (!p || p.blocked) { lines.push(`The ${line} on the new item is all over the cap (${word} is ${Math.round(over)}% over it): it adds nothing here`); continue; }
    const moved = p.statDiff.changed.filter((c) => !/^(Fire|Cold|Lightning|Chaos)Resist/.test(c.statId) && typeof c.before === 'number' && typeof c.after === 'number' && Math.abs((c.before as number) - (c.after as number)) > 1e-6);
    if (moved.length) {
      lines.push(`The ${line} on the new item is over the cap (${word} is ${Math.round(over)}% over it) but the build scales it, so it is not wasted: with it ${moved.filter((c, k) => moved.findIndex((x) => statMeta(x.statId).label === statMeta(c.statId).label) === k).slice(0, 3).map((c) => `${statMeta(c.statId).label} ${formatStat(c.statId, c.before as number)} instead of ${formatStat(c.statId, c.after as number)}`).join(', ')}`);
      continue;
    }
    lines.push(`The ${line} on the new item is all over the cap (${word} is ${Math.round(over)}% over it) and nothing in the build scales it: it adds nothing here`);
    if (better) continue;
    const info = (await ctx.engine.send('itemInfo', { itemText: stripped }).catch(() => null))?.item;
    if (!info?.valid) continue;
    for (const stat of num(before, 'CombinedDPS') > 0 ? ['CombinedDPS', 'TotalEHP'] : ['TotalEHP']) {
      const b = await betterItem(ctx, buildId, slot, { ...kept, text: stripped, info }, stat, num(after, stat), { limit: 1, only: 'suffix' }).catch(() => null);
      if (!b) continue;
      const pct = `${b.value >= num(after, stat) ? '+' : ''}${Math.round((b.value / (num(after, stat) || 1) - 1) * 1000) / 10}%`;
      const msg = `Best use of that suffix instead (${b.added.join('; ')}): ${statMeta(stat).label} ${formatStat(stat, b.value)} (${pct} against the item as asked)`;
      lines.push(msg);
      better = { line: msg, beatsOld: b.value >= num(before, stat), edits: [{ kind: 'setItem', slot, itemText: b.text }] };
      break;
    }
  }
  return { lines, better };
}

const plainRow = (r: string) => r.replace(/\{[^}]*\}/g, '').trim();

/**
 * A bench craft comes on and off as a whole (the Onslaught line of the boots' Movement Speed and Onslaught craft
 * was swapped for a resist craft and its 19% movement speed kept, an item no bench makes). A multi-line bench craft of the old
 * item that the new text keeps only part of loses the rest too, and that is said.
 */
export async function wholeCrafts(ctx: ToolContext, oldText: string, text: string, base: string): Promise<{ text: string; lines: string[] }> {
  const oldCrafted = oldText.split('\n').filter((r) => r.includes('{crafted}')).map(plainRow);
  if (oldCrafted.length < 2) return { text, lines: [] };
  const { pool } = await ctx.engine.send('modPool', { base, itemLevel: 100 });
  let rows = text.split('\n');
  const lines: string[] = [];
  for (const m of [...pool.prefixes, ...pool.suffixes].filter((x) => x.source === 'bench' && x.stats.length > 1)) {
    const shapes = m.stats.map((s) => shape(s.text));
    const craft = oldCrafted.filter((r) => shapes.includes(shape(r)));
    if (craft.length !== shapes.length) continue;
    const kept = rows.filter((r) => craft.includes(plainRow(r)));
    if (!kept.length || kept.length === craft.length) continue;
    rows = rows.filter((r) => !kept.includes(r));
    lines.push(`Took off the rest of the old bench craft (${craft.join(', ')}): a craft is removed as a whole, so ${kept.map(plainRow).join(', ')} goes too`);
  }
  return { text: rows.join('\n'), lines };
}

const DEFENSIVE = /Curses on you|Immun|Avoid|Removes|Cannot be/;
const AVOID: Record<string, string> = { freeze: 'FreezeAvoidChance', bleeding: 'BleedAvoidChance' };

/**
 * A magic utility flask with its suffix swapped for the pool's best suffix matching `re` (middle roll), or null: a life, mana or
 * hybrid flask, one with an immunity, one whose suffix the pool can't name, or one whose suffix is defensive.
 */
async function flaskSuffix(ctx: ToolContext, f: { text: string; info: ItemInfo }, re: RegExp, life = false): Promise<{ mod: PoolMod; gone: string[]; itemText: string } | null> {
  // `life`: an immunity may go on the life flask (pressed in danger, so it is up when the hit lands); its pool says whether it rolls
  if (f.info.rarity !== 'MAGIC' || !f.info.baseName || (life ? /Mana/ : /Life|Mana|Hybrid/).test(f.info.baseName) || /Immun/.test(f.text)) return null;
  const ilvl = f.info.itemLevel ?? 84;
  const { pool } = await ctx.engine.send('modPool', { base: f.info.baseName, itemLevel: ilvl });
  const mod = pool.suffixes.filter((m) => m.source === 'normal' && m.level <= ilvl && m.stats.some((s) => re.test(s.text))).sort((a, b) => a.tier - b.tier)[0];
  if (!mod) return null;
  const sfx = new Set(pool.suffixes.flatMap((m) => m.stats.map((s) => shape(s.text))));
  const pfx = new Set(pool.prefixes.flatMap((m) => m.stats.map((s) => shape(s.text))));
  const rows = f.text.trim().split('\n').map((r) => r.trim());
  const at = rows.findIndex((l) => l.startsWith('Implicits: '));
  const explicitFrom = at >= 0 ? at + 1 + (parseInt(rows[at]!.slice(11), 10) || 0) : 2;
  // the old suffix goes, a bench-crafted one too (Chemist's Amethyst Flask "of Craft"); one the pool can't name: next flask
  const gone = rows.filter((r, i) => i >= explicitFrom && sfx.has(shape(r)) && !pfx.has(shape(r)));
  if (!gone.length && / of /.test(rows[1]!)) return null;
  // never trade curse reduction or an ailment immunity for it; an offensive suffix goes before any other
  if (gone.some((r) => DEFENSIVE.test(r))) return null;
  const name = rows[1]!.replace(/ of .+$/, '');
  return { mod, gone, itemText: [rows[0]!, `${name} ${mod.affix}`, ...rows.slice(2).filter((r) => !gone.includes(r)), ...mid(mod).split('\n')].join('\n') };
}
/** A flask use enchant that leaves the flask down against most enemies. */
const NARROW_USE = /Used when you Hit a Rare or Unique Enemy[^\n]*/i;
const OFFENSIVE = /chance to (Freeze|Shock|Ignite|Poison)|Damage|Critical|Accuracy|Penetrat|Attack Speed|Cast Speed|Projectile|Onslaught/;
const IMMUNITY: Array<[string, RegExp]> = [['freeze', /Immunity to Freeze and Chill during Effect/], ['bleeding', /Immunity to Bleeding and Corrupted Blood during Effect/]];
const mid = (m: PoolMod) => m.stats.map((s) => s.text.replace(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, (_, a, b) => String(Math.round((Number(a) + Number(b)) / 2)))).join('\n');

/**
 * Freeze and bleed immunity the build's flasks lack ("of Heat" / "of Staunching" were once
 * suggested, which only work if drunk while already frozen or bleeding and no longer roll). For each, a magic utility flask with
 * no immunity suffix gets the best pool suffix for it (middle roll) in place of its own suffix: the flask whose suffix the engine
 * misses least (an open suffix first). Edits for proposeEdit.
 */
export async function immunityFlasks(ctx: ToolContext, buildId: string, xml: string): Promise<Array<{ need: string; line: string; gap?: string; edit: { kind: 'setItem'; slot: string; itemText: string } }>> {
  const flasks: Array<{ slot: string; text: string; info: ItemInfo }> = [];
  for (const slot of activeSetOf(readItems(xml)).slots.keys()) {
    if (!/^Flask \d$/.test(slot)) continue;
    const text = slotItemText(xml, slot);
    const info = text ? (await ctx.engine.send('itemInfo', { itemText: text })).item : null;
    if (text && info?.valid) flasks.push({ slot, text, info });
  }
  const out: Array<{ need: string; line: string; gap?: string; edit: { kind: 'setItem'; slot: string; itemText: string } }> = [];
  for (const [need, re] of IMMUNITY) {
    if (!flasks.length || flasks.some((f) => re.test(f.text))) continue;
    // shortcut: magic flasks only (a normal one would need its rarity raised too); a flask with any immunity keeps it
    const cands: Array<{ life: boolean; narrow: boolean; open: boolean; offensive: boolean; score: number; line: string; gap?: string; edit: { kind: 'setItem'; slot: string; itemText: string } }> = [];
    for (const f of flasks) {
      if (out.some((o) => o.edit.slot === f.slot)) continue;
      const swap = await flaskSuffix(ctx, f, re, true);
      if (!swap) continue;
      const { mod, gone, itemText } = swap;
      const edit = { kind: 'setItem' as const, slot: f.slot, itemText };
      const r = await ctx.engine.send('previewEdit', { buildId, edit, full: true }).catch(() => null);
      if (!r || r.blocked) continue;
      // a card must gain what it is for (Iguana on the Basalt while the life flask already covers bleeding)
      if (!r.statDiff.changed.some((c) => c.statId === AVOID[need] && typeof c.after === 'number' && c.after > (typeof c.before === 'number' ? c.before : 0))) continue;
      // never at the cost of movement speed (Walrus on the Quicksilver cut its duration and the speed with it)
      if (r.statDiff.changed.some((c) => c.statId === 'EffectiveMovementSpeedMod' && typeof c.before === 'number' && typeof c.after === 'number' && c.after < c.before - 0.005)) continue;
      const score = r.statDiff.changed.filter((c) => ['FullDPS', 'CombinedDPS', 'TotalEHP'].includes(c.statId) && typeof c.before === 'number' && c.before > 0 && typeof c.after === 'number').reduce((x, c) => x + ((c.after as number) - (c.before as number)) / (c.before as number), 0);
      cands.push({
        life: /Life|Hybrid/.test(f.info.baseName ?? ''),
        narrow: NARROW_USE.test(f.text),
        open: !gone.length,
        offensive: gone.some((r) => OFFENSIVE.test(r)),
        score,
        line: `${f.info.name ?? f.slot} (${f.slot}): suffix ${mod.affix} (${mid(mod).replace(/\n/g, ', ')})${gone.length ? ` in place of ${gone.map(plainRow).join(', ')}` : ' on its open suffix'}`,
        ...(NARROW_USE.test(f.text) ? { gap: `Not covered: its enchant ("${plainRow(NARROW_USE.exec(f.text)![0])}") fires it only on a rare or unique enemy, so a white or magic pack can still ${need === 'freeze' ? 'freeze you' : 'make you bleed'} unless you drink it yourself` } : {}),
        edit,
      });
    }
    // the life flask first: it is drunk when a hit lands, so the immunity is up when it is needed; a utility flask may sit unused
    // a flask whose enchant fires it only on rare and unique enemies goes last: it is down when a white pack freezes you
    cands.sort((x, y) => Number(x.narrow) - Number(y.narrow) || Number(y.life) - Number(x.life) || Number(y.open) - Number(x.open) || Number(y.offensive) - Number(x.offensive) || y.score - x.score);
    if (cands[0]) out.push({ need, line: cands[0].line, ...(cands[0].gap ? { gap: cands[0].gap } : {}), edit: cands[0].edit });
  }
  return out;
}

/**
 * The explicit mods of a made item whose numbers the player did not write in the ask (a +15% Fire and Chaos Resistances line the
 * player never named). An ask with no numbers names nothing to compare, so nothing is reported.
 */
export function unaskedMods(itemText: string, asked: string): string[] {
  if (!/\d/.test(asked)) return [];
  const rows = itemText.split(/\r?\n/);
  const at = rows.findIndex((l) => l.startsWith('Implicits: '));
  const start = at >= 0 ? at + 1 + (parseInt(rows[at]!.slice(11), 10) || 0) : 0;
  return rows.slice(start).map((r) => r.replace(/^(\{[^}]*\})*/, '').trim()).filter((r) => {
    if (!r || /^[A-Za-z ]+: /.test(r)) return false;
    const nums = r.match(/-?\d+(?:\.\d+)?/g) ?? [];
    return nums.length > 0 && !nums.every((n) => new RegExp(`(^|[^0-9.])${n.replace('.', '\\.').replace('-', '')}(?![0-9])`).test(asked));
  });
}

const SLOT_TYPE: Array<[RegExp, string]> = [[/^Ring\b/, 'Ring'], [/^Amulet$/, 'Amulet'], [/^Belt$/, 'Belt'], [/^Helmet$/, 'Helmet'], [/^Gloves$/, 'Gloves'], [/^Boots$/, 'Boots'], [/^Body Armour$/, 'Body Armour']];

/** Whether an item of the engine's `type` can sit in `slot` (a ring is never a belt). A slot or type the table does not know is not rejected. */
export function itemFitsSlot(slot: string, itemType: string | undefined): boolean {
  const want = SLOT_TYPE.find(([re]) => re.test(slot))?.[1];
  return !want || !itemType || itemType === want;
}

/** What the item's own text says about spell suppression: the engine's numbers come from the build, so the answer must not credit an item that lists none. */
export function suppressionSource(itemText: string, slot: string): string {
  return /suppress spell damage/i.test(itemText) ? `The ${slot} item gives spell suppression itself.` : `The old ${slot} item lists no spell suppression: the suppression the engine says is lost is not from its mods (do not say it gave any).`;
}

/** The old item's damage lines that the new item does not carry (speed, damage, crit, accuracy, penetration): why damage fell with the swap. */
export function lostDamageMods(oldText: string, newText: string): string[] {
  const lines = (t: string) => {
    const rows = t.split(/\r?\n/);
    const at = rows.findIndex((l) => l.startsWith('Implicits: '));
    return rows.slice(at >= 0 ? 1 + at : 0).map((r) => r.replace(/^(\{[^}]*\})*/, '').trim()).filter((r) => r && !/^[A-Za-z ]+: /.test(r));
  };
  const shapeOf = (l: string) => l.replace(/-?\d+(?:\.\d+)?/g, '#').toLowerCase();
  const have = new Set(lines(newText).map(shapeOf));
  return lines(oldText).filter((l) => /action speed|attack speed|cast speed|damage|critical|accuracy|penetrat|leech/i.test(l) && !have.has(shapeOf(l)));
}

/** The explicit mods of an item whose numbers the player wrote in the ask (the ones a listing must keep, such as a 30% movement speed). */
export function typedMods(itemText: string, asked: string): string[] {
  const rows = itemText.split(/\r?\n/);
  const at = rows.findIndex((l) => l.startsWith('Implicits: '));
  const start = at >= 0 ? at + 1 + (parseInt(rows[at]!.slice(11), 10) || 0) : 0;
  return rows.slice(start).map((r) => r.replace(/^(\{[^}]*\})*/, '').trim()).filter((r) => {
    if (!r || /^[A-Za-z ]+: /.test(r)) return false;
    const nums = r.match(/-?\d+(?:\.\d+)?/g) ?? [];
    return nums.length > 0 && nums.every((n) => new RegExp(`(^|[^0-9.])${n.replace('.', '\\.').replace('-', '')}(?![0-9])`).test(asked));
  });
}
