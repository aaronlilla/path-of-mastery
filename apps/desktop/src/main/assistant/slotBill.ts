// What a result's rare slots cost in game: per slot the mods the build loses numbers without, as a trade search with minimum
// values (the player's own session, through the trade code Wealth has), the price with its date, and cheaper recipes
// (an essence that forces a must-have mod, a bench craft that stands in for a listing mod). An item that cannot exist
// (legality.ts) is refused and never searched. Without a session the knowledge pack's range stands in, with its date.
import { z } from 'zod';
import type { PoolMod } from '@pom/protocol';
import type { PriceBill, SlotBill } from '../../shared/assistant/types.js';
import { statMeta } from '../../shared/assistant/statLabels.js';
import { readEquipped } from './buildReaders.js';
import { itemLegality, lineShape } from './legality.js';
import { statIdFor } from './wealthTrade.js';
import { need, statMap, ToolError, withScratch, type Scalar, type ToolContext, type ToolDef } from './tools.js';

/** The knowledge pack's price range for a slot (lane knowledge fills it); null when the pack has none. */
export type PackRange = (slot: string, base: string, mustHave: string[]) => { lowDivines: number; highDivines: number; date: string } | null;
export interface BillOptions {
  pack?: PackRange;
  /** Searches stop after this long and the slots left say so (the trade site's limits make each search seconds). */
  deadlineMs?: number;
}

const RES = ['Fire', 'Cold', 'Lightning', 'Chaos'];
const CATEGORY: Array<[RegExp, string]> = [[/^Ring/, 'accessory.ring'], [/^Amulet/, 'accessory.amulet'], [/^Belt/, 'accessory.belt']];
const MIN_LOSS = 0.01;
/** Local mods: the trade site lists them under their own stat ("... (Local)"), apart from the global one with the same words. */
const LOCAL_ARMOUR = /^(?:#% increased (?:Armour|Evasion|Energy Shield)(?:(?:, | and )(?:Armour|Evasion|Energy Shield))*|# to (?:Armour|Evasion Rating|maximum Energy Shield))$/;
const LOCAL_WEAPON = /^(?:Adds # to # (?:Physical|Fire|Cold|Lightning|Chaos) Damage|#% increased (?:Physical Damage|Attack Speed|Critical Strike Chance)|# to Accuracy Rating)$/;

/** The line as the trade site words it: the "(Local)" stat when the item is armour or a weapon and the line is a local one, or when only that stat exists. */
export function searchText(text: string, armour: boolean, weapon: boolean): string {
  const local = `${text} (Local)`;
  const k = lineShape(text);
  if (((armour && LOCAL_ARMOUR.test(k)) || (weapon && LOCAL_WEAPON.test(k))) && statIdFor(local)) return local;
  return statIdFor(text) ? text : statIdFor(local) ? local : text;
}
const MAX_MODS = 6;
const num = (s: Record<string, Scalar>, k: string): number => (typeof s[k] === 'number' ? (s[k] as number) : 0);
const median = (xs: number[]): number | null => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The least roll worth searching for: 90% of the build's own (small whole numbers exactly), none for a line without a plain number. */
export function minFor(text: string): number | undefined {
  const m = /^[+]?(\d+(?:\.\d+)?)/.exec(text.replace(/\{[^}]*\}/g, '').trim());
  if (!m) return undefined;
  const v = Number(m[1]);
  return v <= 5 ? v : Math.floor(v * 0.9);
}

/** Two lines of the same stat (a hybrid's half beside a rolled line) are one trade filter, at the larger minimum. */
export function oneFilterPerStat(mods: Array<{ text: string; min?: number }>): Array<{ text: string; min?: number }> {
  const out = new Map<string, { text: string; min?: number }>();
  for (const m of mods) {
    const k = lineShape(m.text);
    const had = out.get(k);
    if (!had) out.set(k, m);
    else if (m.min !== undefined && (had.min === undefined || m.min > had.min)) had.min = m.min;
  }
  return [...out.values()];
}

interface Must {
  text: string;
  loss: number;
  said: string;
}

/** The rolled lines of the slot's item that the build's DPS, effective HP or a capped resist depend on: each line taken off on a scratch copy, one batch. */
async function mustHaves(ctx: ToolContext, xml: string, slot: string, itemText: string, mods: Array<{ text: string; rawLine: number | null }>): Promise<Must[]> {
  if (!mods.length) return [];
  const rows = itemText.split('\n').filter((l) => l.trim() !== '');
  return withScratch(ctx, xml, async (buildId) => {
    const base = await statMap(ctx, buildId);
    const dps = num(base, 'FullDPS') > 0 ? 'FullDPS' : 'CombinedDPS';
    const edits = mods.map((m) => ({ kind: 'setItem' as const, slot, itemText: rows.filter((_, i) => i !== m.rawLine).join('\n') }));
    const { results } = await ctx.engine.send('previewEdits', { buildId, edits, full: true });
    const out: Must[] = [];
    mods.forEach((m, i) => {
      const r = results[i];
      if (!r || 'error' in r) return;
      const after = (id: string) => {
        const c = r.statDiff.changed.find((x) => x.statId === id);
        return typeof c?.after === 'number' ? c.after : num(base, id);
      };
      const lost = (id: string) => (num(base, id) > 0 ? Math.max(0, (num(base, id) - after(id)) / num(base, id)) : 0);
      const parts = [dps, 'TotalEHP'].filter((id) => lost(id) >= MIN_LOSS).map((id) => `${statMeta(id).label} -${Math.round(lost(id) * 1000) / 10}%`);
      for (const e of RES) {
        const cap = num(base, `${e}ResistMax`);
        if (cap > 0 && num(base, `${e}Resist`) >= cap && after(`${e}Resist`) < cap) parts.push(`${e.toLowerCase()} resistance under its cap`);
      }
      if (parts.length) out.push({ text: m.text, loss: Math.max(lost(dps), lost('TotalEHP')), said: parts.join(', ') });
    });
    return out.sort((a, b) => b.loss - a.loss).slice(0, MAX_MODS);
  });
}

/** The bill for every rare slot of a build text. Reads only: nothing is bought, listed or whispered. */
export async function priceBill(ctx: ToolContext, xml: string, opts: BillOptions = {}): Promise<PriceBill> {
  const t0 = Date.now();
  const rares = readEquipped(xml).filter((i) => /rare/i.test(i.rarity));
  const slots: SlotBill[] = [];
  for (const it of rares) {
    const info = (await ctx.engine.send('itemInfo', { itemText: it.text }).catch(() => null))?.item;
    const item = info?.name && info.baseName && info.name !== info.baseName ? `${info.name} (${info.baseName})` : (info?.baseName ?? it.name);
    const bill: SlotBill = { slot: it.slot, item, legal: true, issues: [], mustHave: [], notSearchable: [], price: { status: 'failed', message: 'Not priced.' }, recipes: [] };
    slots.push(bill);
    const issues = await itemLegality(ctx, it.slot, it.text);
    if (issues.length) {
      bill.legal = false;
      bill.issues = issues.map((i) => i.text);
      bill.price = { status: 'refused', message: `Not priced: this item cannot exist in game (${bill.issues[0]}).` };
      continue;
    }
    if (!info?.baseName) {
      bill.price = { status: 'failed', message: 'The engine could not read this item.' };
      continue;
    }
    const rolled = (info.mods ?? []).filter((m) => m.bucket === 'explicit' && !m.crafted && !m.custom && !m.mutated);
    const must = await mustHaves(ctx, xml, it.slot, it.text, rolled).catch(() => [] as Must[]);
    bill.mustHave = must.map((m) => ({ text: m.text, ...(minFor(m.text) !== undefined ? { min: minFor(m.text)! } : {}), loss: m.said }));

    // the price: the player's own trade session, else the pack's range with its date
    const category = CATEGORY.find(([re]) => re.test(it.slot))?.[1];
    let chaosPerDivine = 0;
    let typicalChaos: number | null = null;
    if (ctx.trade && Date.now() - t0 < (opts.deadlineMs ?? 120_000)) {
      const armour = !!info.defences;
      const weapon = !armour && /^Weapon/.test(it.slot);
      const ask = (mods: typeof bill.mustHave) => ctx.trade!.search({ ...(category ? { category } : { type: info.baseName }), mods: oneFilterPerStat(mods.map((m) => ({ text: searchText(m.text, armour, weapon), ...(m.min !== undefined ? { min: m.min } : {}) }))), limit: 8 }).catch((e: unknown) => ({ ok: false as const, kind: 'failed', message: e instanceof Error ? e.message : String(e) }));
      // nothing lists all of them: leave out the mod the build misses least, twice at most, and say so
      const dropped: string[] = [];
      let searched = bill.mustHave;
      let r = await ask(searched);
      while (r.ok && r.total === 0 && searched.length > 2 && dropped.length < 2 && Date.now() - t0 < (opts.deadlineMs ?? 120_000)) {
        dropped.push(searched[searched.length - 1]!.text);
        searched = searched.slice(0, -1);
        r = await ask(searched);
      }
      if (r.ok) {
        bill.notSearchable = r.unmatchedMods;
        chaosPerDivine = r.chaosPerDivine;
        const priced = r.listings.map((l) => l.divine).filter((d): d is number => d !== null);
        const typical = median(priced.slice(0, 5));
        typicalChaos = typical === null ? null : typical * chaosPerDivine;
        bill.price = r.total === 0 || !r.listings.length
          ? { status: 'none-listed', message: `No online listing from the last week has ${searched.length === bill.mustHave.length ? `all ${searched.length}` : `even the best ${searched.length} of ${bill.mustHave.length}`} mods at these minimums.` }
          : { status: 'live', total: r.total, divines: typical === null ? null : round2(typical), cheapestDivines: priced.length ? round2(Math.min(...priced)) : null, listings: r.listings.slice(0, 3).map((l) => ({ asked: l.asked, divine: l.divine, ageMinutes: l.ageMinutes })), dropped, at: r.at, link: r.link };
      } else if (r.kind === 'no-cookie' || r.kind === 'expired') bill.price = { status: 'no-session', message: 'No trade session is connected, so there are no live listings.' };
      else if (r.kind === 'rate-limited') bill.price = { status: 'rate-limited', message: `The trade site asked the app to wait ${('retryAfterSec' in r && r.retryAfterSec) || 60} seconds.` };
      else bill.price = { status: 'failed', message: r.message };
    } else bill.price = { status: 'no-session', message: ctx.trade ? 'Out of time: this slot was not searched.' : 'No trade session is connected, so there are no live listings.' };
    if (bill.price.status === 'no-session') {
      const range = opts.pack?.(it.slot, info.baseName, bill.mustHave.map((m) => m.text));
      if (range) bill.price = { status: 'range', lowDivines: range.lowDivines, highDivines: range.highDivines, date: range.date };
    }

    // recipes: from the same mod pool the legality check reads
    try {
      const { pool } = await ctx.engine.send('modPool', { base: info.baseName, itemLevel: info.itemLevel ?? 84, influences: info.influences ?? [] });
      const all: PoolMod[] = [...pool.prefixes, ...pool.suffixes];
      const essences = new Map<string, string>();
      for (const m of bill.mustHave) {
        const k = lineShape(m.text);
        const e = all.find((p) => p.source === 'essence' && p.essence && p.stats.some((s) => lineShape(s.text) === k));
        if (e?.essence) essences.set(e.essence, m.text);
        const b = all.find((p) => p.source === 'bench' && p.stats.length === 1 && lineShape(p.stats[0]!.text) === k && (m.min === undefined || (p.stats[0]!.values[0]?.max ?? 0) >= m.min));
        if (b) bill.recipes.push({ kind: 'bench', what: `Bench craft: ${m.text}`, chaos: null, note: 'Stands in for this mod on the listing (one craft per item, three with the multimod). The bench price is not in the game data the app ships.', cheaper: null });
      }
      const names = [...essences.keys()];
      const looked = names.length ? await ctx.prices?.lookup(names).catch(() => null) : null;
      names.forEach((name, i) => {
        const chaos = looked?.lines[i]?.find((l) => l.name === name)?.chaos ?? null;
        bill.recipes.push({ kind: 'essence', what: `${name} forces ${essences.get(name)}`, chaos, note: 'One essence per try; the other mods are still rolled, so expect several tries.', cheaper: chaos !== null && typicalChaos !== null ? chaos < typicalChaos : null });
      });
    } catch {
      // no recipes for this slot
    }
    for (const m of (info.mods ?? []).filter((x) => x.bucket === 'explicit' && x.crafted && !/^Can have up to/i.test(x.text))) bill.recipes.push({ kind: 'bench', what: `Craft after buying: ${m.text}`, chaos: null, note: 'It is on the build\'s item; buy without it and leave an affix open.', cheaper: null });
  }
  const worth = (b: SlotBill): number | null => (b.price.status === 'live' ? b.price.divines : b.price.status === 'range' ? round2((b.price.lowDivines + b.price.highDivines) / 2) : null);
  const priced = slots.filter((b) => worth(b) !== null);
  return { slots, divines: priced.length ? round2(priced.reduce((a, b) => a + worth(b)!, 0)) : null, priced: priced.length, of: slots.length };
}

export const SLOT_BILL_TOOLS: ToolDef[] = [
  {
    name: 'priceSlots',
    chip: 'Price the rare slots',
    description:
      "The bill for the rare items of a solve result (index from getSolve) or of the open build: per slot, the mods the build loses numbers without, searched on the trade site with minimum values (the player's own session; without one the pack's range with its date), the price from live listings with their age and a link to the search, cheaper essence and bench recipes, and whether the item can exist in game at all (a craft the base cannot take, more crafts than allowed, too many affixes, an influence it lacks: not priced, the build is not ready). Rares only: uniques are priced in the result's own price. Nothing is bought or listed. Says plainly when a slot has no price.",
    shape: { index: z.number().int().min(0).max(7).optional().describe('A solve result; omit for the open build.') },
    run: async (args, ctx) => {
      let xml: string;
      if (typeof args.index === 'number') {
        if (!ctx.solve) throw new ToolError('The build solver is not available here.');
        xml = await ctx.solve.resultXml(args.index);
      } else xml = (await ctx.engine.send('getBuildXml', { buildId: need(ctx).buildId })).buildXml;
      return { ...(await priceBill(ctx, xml)), note: 'Listing prices are what sellers ask, from online sellers in the last week; divines use the poe.ninja rate. min is 90% of the build\'s own roll. A slot with notSearchable mods is priced on fewer mods than it has.' };
    },
  },
];
