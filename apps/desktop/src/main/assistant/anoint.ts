// Anoints: a notable from three oils on an amulet ("Allocates <notable>"), so a stat line can be crossed without spending passive
// points (and the life they cost). The notables, their stats and their oils come from the engine's own anoint pool.
import type { ToolContext } from './tools.js';
import { slotItemText } from './itemFit.js';
import type { Threshold } from './thresholds.js';
import { guardBreaks } from './playerSense.js';

const scalars = (stats: Array<{ id: string; value: unknown }>) => Object.fromEntries(stats.filter((x) => x.value === null || typeof x.value !== 'object').map((x) => [x.id, x.value])) as Record<string, string | number | boolean | null>;

type PoolNode = { id: number; name: string; stats: string[]; oils: string[] };

const ALLOCATES = /^(\s*)\{crafted\}Allocates (.+)$/m;
export const anointOf = (text: string | null | undefined): string | undefined => ALLOCATES.exec(text ?? '')?.[2]?.trim();

/** The anointable notables for this item (name, stat lines, three oils). */
async function pool(ctx: ToolContext, itemText: string): Promise<PoolNode[]> {
  const { pool: p } = await ctx.engine.send('itemPool', { itemText, kind: 'anoint' });
  return ((p as { nodes?: PoolNode[] } | null)?.nodes ?? []).filter((n) => Array.isArray(n.oils) && Array.isArray(n.stats));
}

/** The item text with `name` as its anoint (the old anoint line is replaced, else one is added as an implicit). */
export function withAnoint(text: string, name: string): string {
  if (ALLOCATES.test(text)) return text.replace(ALLOCATES, `$1{crafted}Allocates ${name}`);
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^\s*Implicits: /.test(l));
  if (at < 0) return text;
  const n = parseInt(lines[at]!.replace(/^\s*Implicits: /, ''), 10) || 0;
  lines[at] = lines[at]!.replace(/\d+\s*$/, String(n + 1));
  lines.splice(at + 1 + n, 0, `{crafted}Allocates ${name}`);
  return lines.join('\n');
}

const oilName = (id: string) => id.replace(/Oil$/, ' Oil').replace(/([a-z])([A-Z])/g, '$1 $2');

/** "2 Black Oil, Clear Oil and Violet Oil", with each oil's poe.ninja price and the total when the price book has them. */
export async function oilsLine(ctx: ToolContext, oils: string[]): Promise<string> {
  const names = oils.map(oilName);
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const uniq = [...count.keys()];
  const r = ctx.prices ? await Promise.race([ctx.prices.lookup(uniq), new Promise<null>((res) => setTimeout(() => res(null), 2500))]).catch(() => null) : null;
  const div = r?.chaosPerDivine || 0;
  const show = (c: number) => (div > 0 && c >= div ? `${Math.round((c / div) * 10) / 10} div` : `${Math.round(c * 10) / 10}c`);
  let total = 0;
  let priced = 0;
  const parts = uniq.map((n, i) => {
    const l = r?.lines[i]?.[0];
    if (!l) return `${count.get(n)! > 1 ? `${count.get(n)} ` : ''}${n}`;
    total += l.chaos * count.get(n)!;
    priced += count.get(n)!;
    return `${count.get(n)! > 1 ? `${count.get(n)} ` : ''}${n} (${show(l.chaos)} each)`;
  });
  return `${parts.join(', ')}${priced === names.length ? `, about ${show(total)} in all (poe.ninja)` : ''}`;
}

/** What an anoint change says in words: the notable, the item, what it replaces, the oils and their price. */
export async function anointNote(ctx: ToolContext, slot: string, oldText: string | null, newText: string): Promise<string | null> {
  const to = anointOf(newText);
  const from = anointOf(oldText);
  if (!to || to === from) return null;
  const node = (await pool(ctx, newText).catch(() => [])).find((x) => x.name === to);
  const item = newText.split('\n').map((l) => l.trim()).filter((l) => l && !/^Rarity:/.test(l))[0] ?? slot;
  return `Anoints ${to}${node?.stats.length ? ` (${node.stats.join('; ')})` : ''} on your ${item}${from ? `, replacing ${from}` : ''}${node ? `: oils ${await oilsLine(ctx, node.oils)}` : ''}`;
}

/**
 * The anoint that gains most toward the line `t` (never a notable the tree already has), as the edit that sets it on the amulet the
 * build wears, with what it costs in spell suppression (`lost`). null when there is no amulet, no anointable notable carries the stat, or none moves it.
 */
export async function bestAnoint(ctx: ToolContext, buildId: string, t: Threshold, slot = 'Amulet'): Promise<{ edit: { kind: 'setItem'; slot: string; itemText: string }; label: string; name: string; lost: string[]; alone: boolean } | null> {
  const xml = (await ctx.engine.send('getBuildXml', { buildId })).buildXml;
  const text = slotItemText(xml, slot);
  if (!text) return null;
  const { tree } = await ctx.engine.send('treeState', { buildId });
  const have = new Set(tree.allocated);
  const current = anointOf(text);
  const cands = (await pool(ctx, text).catch(() => [])).filter((n) => !have.has(n.id) && n.name !== current && n.stats.some((s) => t.lines.test(s)));
  if (!cands.length) return null;
  const { buildId: scratch } = await ctx.engine.send('loadBuild', { buildXml: xml });
  try {
    const stats0 = (await ctx.engine.send('getStats', { buildId: scratch })).stats;
    const short0 = t.short(stats0);
    let best: { name: string; gain: number } | null = null;
    for (const c of cands) {
      const depth = (await ctx.engine.send('history', { buildId: scratch })).undo;
      if (!(await ctx.engine.send('edit', { buildId: scratch, edit: { kind: 'setItem', slot, itemText: withAnoint(text, c.name) } })).blocked) {
        const gain = short0 - t.short((await ctx.engine.send('getStats', { buildId: scratch })).stats);
        if (gain > 0 && (!best || gain > best.gain)) best = { name: c.name, gain };
      }
      for (let h = (await ctx.engine.send('history', { buildId: scratch })).undo; h > depth; h--) await ctx.engine.send('undo', { buildId: scratch });
    }
    if (!best) return null;
    // the anoint it replaces can be what holds a defence layer up (Intuition's spell suppression): `lost` says so, and it is then offered, never applied
    await ctx.engine.send('edit', { buildId: scratch, edit: { kind: 'setItem', slot, itemText: withAnoint(text, best.name) } });
    const lost = guardBreaks(scalars(stats0), scalars((await ctx.engine.send('getStats', { buildId: scratch })).stats), false).filter((b) => /suppression/i.test(b));
    return { edit: { kind: 'setItem', slot, itemText: withAnoint(text, best.name) }, label: `Anoint ${best.name} on your ${slot.toLowerCase()}`, name: best.name, lost, alone: short0 - best.gain <= 0 };
  } finally {
    await ctx.engine.send('closeBuild', { buildId: scratch }).catch(() => undefined);
  }
}
