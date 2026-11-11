// planUpgrade: what the model otherwise works out over six or seven turns for "what should I upgrade next", done at once in the
// app's own engine: the audit's ready-to-apply fixes with their engine numbers, and tree routes for what the audit says is short
// (accuracy for a keystone that compares it with life), each checked against the guards (no suppression layer lost, no stat down
// more than 15%). The app starts it as soon as the question arrives, so the model's call just collects the result.
import { fixNames } from './firstLine.js';
import { z } from 'zod';
import { agoText } from '../../shared/wealthTrade.js';
import { formatStat, statMeta } from '../../shared/assistant/statLabels.js';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { auditBuild } from './audit.js';
import { RANK_TOOLS } from './rankTools.js';
import { ACCURACY_OVER_LIFE, thresholdRoute } from './thresholdRoute.js';
import { bestAnoint } from './anoint.js';
import { readSkills } from './buildReaders.js';
import { benchAccuracy, slotItemText, type KeptItem } from './itemFit.js';
import { budgetChaos } from './profile.js';
import { changeRows, listingItemText, costRows, costsLine, need, pickChanges, statMap, toBuildEdit, TOOLS, trial, turnAsk, type ToolContext, type ToolDef, type ToolEdit } from './tools.js';

const BUDGET_MS = 10_000;

/** Runs a tool the way the model's own call would (same access checks and the same context: trade search is only there for the tools that need it). Set by the app per turn. */
let runner: ((tool: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;
/** Runs a tool through the app's own path (access checks, trade context), or null when no turn is running. */
export async function runViaApp(ctx: { origin: 'panel' | 'external' }, tool: string, args: Record<string, unknown>): Promise<unknown> {
  // the runner is bound to the panel's turn and build: an outside MCP client's call must not go through it
  return runner && ctx.origin === 'panel' ? runner(tool, args) : null;
}

/**
 * For an upgrade ask the app applies the plan's change itself (service.autoApplyPlan) instead of hoping the model picks it: the plan it
 * used, what was applied (a promise while it goes in) and the use ids that went in, so the model's own planUpgrade call hears about it and
 * a repeat of the same planIds cannot toggle the tree edits back.
 */
interface AutoApplied { plan: Plan; applied: Promise<Record<string, unknown> | null>; used: string[]; /** the offers the app put on cards */ cards: string[] }
const auto = new Map<string, AutoApplied>();
let appCall = false;
/** The next planUpgrade call is the app's own (it must not wait for the change it is about to make). */
export const markAppPlanCall = (): void => { appCall = true; };
export const setAutoApplied = (buildKey: string, a: AutoApplied): void => { auto.set(buildKey, a); };
export const clearAutoApplied = (): void => auto.clear();
/** Words that name what the app already put in this turn (its fix names and the gems it slotted, Enlighten): advice to do them again is dropped. */
export function appliedWords(buildKey: string): string[] {
  const a = auto.get(buildKey);
  if (!a?.used.length) return [];
  const fixes = ((a.plan as { fixes?: Array<{ use: string; edits?: Array<{ gemId?: string }> }> }).fixes ?? []).filter((f) => a.used.includes(f.use));
  const gems = fixes.flatMap((f) => (f.edits ?? []).map((e) => /SkillGem(?:Support)?(\w+)$/.exec(e.gemId ?? '')?.[1]).filter((x): x is string => !!x));
  const names = fixNames(a.used.filter((id) => id.startsWith('fix:')));
  // the mana fix is the reservation fix in a player's words ("reservation ... the bigger priorities" after Enlighten went in)
  return [...new Set([...names, ...(names.includes('mana') ? ['reservation', 'reservations'] : []), ...gems])];
}

/** Drops each sentence that tells the player to do something already done this turn ("I'd prioritize Enlighten" after it went in). */
export function dropDoneAdvice(text: string, words: string[]): string {
  if (!words.length) return text;
  const lower = words.map((w) => w.toLowerCase());
  const named = (x: string) => lower.some((w) => new RegExp(`(^|[^a-z])${w.replace(/[^a-z0-9 ]/g, '')}([^a-z]|$)`).test(x.toLowerCase()));
  const advise = /\b(prioriti[sz]e|priorit(y|ies)|recommend|focus on|start with|I'?d (get|buy|take|do|go for)|you should (get|buy|do|fix|take))\b/i;
  // sentences end at . ! ? before a space, so 2.27M stays whole
  return text.split('\n').map((line) => line.split(/(?<=[.!?])\s+/).filter((x) => !(advise.test(x) && named(x) && !x.includes('{{'))).join(' ')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** Every id here was applied or made into a card by the app (a repeat proposeEdit for them has nothing to do). */
export function planHandled(ctx: ToolContext, ids: string[]): boolean {
  const mine = auto.get(need(ctx).buildKey);
  return !!mine && ids.every((id) => mine.used.includes(id) || mine.cards.includes(id));
}
export const markPlanCard = (buildKey: string, id: string): void => { auto.get(buildKey)?.cards.push(id); };

/** The use ids of what the app applies on its own: every fix inside the cap, the best route and the best buy. */
export function autoApplyIds(p: { fixes?: Array<{ use: string }>; routes?: Array<{ use: string }>; buy?: Array<{ use: string }> }): string[] {
  return [...(p.fixes ?? []).map((x) => x.use), ...(p.routes?.[0] ? [p.routes[0].use] : []), ...(p.buy?.[0] ? [p.buy[0].use] : [])];
}

export function setPlanRunner(r: ((tool: string, args: Record<string, unknown>) => Promise<unknown>) | null): void {
  runner = r;
}

/** Eval-only: one line per plan branch in the eval trace (candidates found, gain, trade context). */
function planLog(branch: string, info: Record<string, unknown>): void {
  if (process.env.POM_AUTOMATION === '1' && process.env.AE_TRACE_FILE) {
    try { appendFileSync(process.env.AE_TRACE_FILE, `${JSON.stringify({ src: 'app', ev: 'plan', branch, ...info, t: Date.now() })}\n`); } catch { /* optional */ }
  }
}

type Plan = Record<string, unknown>;

/** A question about spending currency: the plan also searches the budget's buys. */
export const SPEND_WORDS = /\b(spend|buy|invest|currency|budget|divines?|chaos orbs?)\b/i;

/** The anoint card the app makes after the tree route goes in: a better route that costs a defence layer, so it is offered, never applied. */
export interface AnointOffer { edit: { kind: 'setItem'; slot: string; itemText: string }; title: string; summary: string }
const anointOffers = new Map<string, AnointOffer>();
export const peekAnointOffer = (buildKey: string): AnointOffer | null => anointOffers.get(buildKey) ?? null;
const cache = new Map<string, { key: string; at: number; result: Promise<Plan> }>();

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** The plan for the open build, computed once per build text; a second ask within a minute gets the same promise. */
export function plan(ctx: ToolContext): Promise<Plan> {
  const open = need(ctx);
  // the change the app applied for this answer: its plan stays the plan (the build it was made for has just changed)
  const mine = auto.get(open.buildKey);
  if (mine) return Promise.resolve(mine.plan);
  const started = Date.now();
  const run = async (): Promise<Plan> => {
    const { buildXml } = await ctx.engine.send('getBuildXml', { buildId: open.buildId });
    const key = createHash('sha1').update(buildXml).update(`${SPEND_WORDS.test(turnAsk.text)}:${/\d|\b(one|two|three|four|five|ten|twenty|thirty)\b/i.test(turnAsk.text)}`).digest('hex');
    const hit = cache.get(open.buildKey);
    if (hit && hit.key === key && Date.now() - hit.at < 60_000) return hit.result;
    const result = compute(ctx, open.buildId, buildXml, started);
    cache.set(open.buildKey, { key, at: Date.now(), result });
    void result.then((r) => { if (r.anointOffer) anointOffers.set(open.buildKey, r.anointOffer as AnointOffer); else anointOffers.delete(open.buildKey); }).catch(() => undefined);
    return result;
  };
  return run();
}

/** The accuracy short of the keystone, from the audit's fix ("... (471 more)"), or 0. */
export function accuracyShort(fix: string): number {
  return Number(/\(([\d,]+) more\)/.exec(fix)?.[1]?.replace(/,/g, '') ?? 0);
}

/** The worn item's life and resistance rolls as trade filters at 90%, the largest first (at most three: rings lost the chaos resistance at two): what a replacement must keep. */
export function keepFilters(itemText: string): Array<{ text: string; min: number }> {
  // implicits are the base's own: a listing of any ring base would not carry them
  const rows = itemText.split(/\r?\n/);
  const at = rows.findIndex((l) => /^Implicits: \d+/.test(l));
  const n = at >= 0 ? Number(/\d+/.exec(rows[at]!)![0]) : 0;
  return rows.filter((_, i) => at < 0 || i <= at || i > at + n).flatMap((l) => {
    const m = /^\+(\d+)(%?) to (maximum Life|[\w ]*Resistances?)$/.exec(l.replace(/^\{[^}]*\}/, '').trim());
    return m ? [{ text: `+#${m[2]} to ${m[3]}`, min: Math.floor(Number(m[1]) * 0.9), v: Number(m[1]) * (m[2] ? 1 : 0.5) }] : [];
  }).sort((a, b) => b.v - a.v).slice(0, 3).map(({ text, min }) => ({ text, min }));
}

/** For each worn rare ring, amulet, gloves and helmet, listings with half the missing accuracy and that ring's own life and resistances, as upgradeCandidates rows. */
async function accuracyRings(xml: string, fix: string, run: (tool: string, args: Record<string, unknown>) => Promise<unknown>, skip: Set<string> = new Set()): Promise<Array<{ slot: string; r: { candidates: Array<Record<string, unknown>>; link?: string } }>> {
  const more = accuracyShort(fix);
  if (!(more > 0)) return [];
  const out: Array<{ slot: string; r: { candidates: Array<Record<string, unknown>>; link?: string } }> = [];
  // the slots that roll flat accuracy (rings and amulets to 480, gloves and helmets to 600 in the game's mod pool), the trade category of each
  const SLOTS: Array<[string, string]> = [['Ring 1', 'accessory.ring'], ['Ring 2', 'accessory.ring'], ['Amulet', 'accessory.amulet'], ['Gloves', 'armour.gloves'], ['Helmet', 'armour.helmet']];
  for (const [slot, category] of SLOTS) {
    const worn = slotItemText(xml, slot);
    if (!worn || skip.has(slot) || /^Rarity: (UNIQUE|RELIC)/m.test(worn)) continue;
    const r = (await run('searchTrade', { category, mods: [{ text: '+# to Accuracy Rating', min: Math.ceil(more / 2) }, ...keepFilters(worn)], limit: 2 }).catch(() => null)) as { listings?: Array<Record<string, unknown>>; link?: string } | null;
    const candidates = (r?.listings ?? []).filter((l) => typeof l.chaos === 'number').slice(0, 2).map((l) => ({ ...l, itemText: listingItemText(l as never) }));
    if (candidates.length) out.push({ slot, r: { candidates, ...(r?.link ? { link: r.link } : {}) } });
  }
  return out;
}

async function compute(ctx: ToolContext, buildId: string, xml: string, started: number): Promise<Plan> {
  const audit = await auditBuild(ctx, buildId, xml);
  // the ring search is network-bound: start it now, it runs while the engine works through the fixes
  const wantBuy = audit.findings.some((f) => /enough Accuracy for/i.test(f.shown));
  const GEAR_SLOTS = ['Ring 1']; // a second slot (amulet) added 6 s to the plan and led the model to unreal crafts; keep one slot
  const buyP: Promise<Array<{ slot: string; r: { candidates?: Array<Record<string, unknown>>; link?: string } | null }>> = wantBuy
    ? Promise.all(GEAR_SLOTS.map(async (slot) => ({ slot, r: (await Promise.resolve(runner ? runner('upgradeCandidates', { slot, rank: 'dps' }) : null).catch((e) => { planLog('buy.error', { slot, message: String(e instanceof Error ? e.message : e) }); return null; })) as { candidates?: Array<Record<string, unknown>>; link?: string } | null })))
    : Promise.resolve([]);
  // rings that carry the accuracy the keystone is short of, with the worn ring's own life and resistances, so the buy turns it on (471 accuracy
  // was +37% damage while the budget went on ~1% rings)
  const short0 = audit.findings.find((f) => /enough Accuracy for/i.test(f.shown));
  // a slot a fix rewrites (the chaos craft on Ring 2) is not bought over: the buy would throw the fix away (-10% effective HP)
  const fixSlots = new Set(audit.findings.flatMap((f) => ((f.edits ?? []) as Array<{ kind: string; slot?: string }>).filter((e) => (e.kind === 'setItem' || e.kind === 'setSlotItem') && e.slot).map((e) => e.slot!)));
  const accP = short0 && runner ? accuracyRings(xml, short0.fix ?? '', runner, fixSlots).catch(() => []) : Promise.resolve([]);
  const tried: Array<{ id: string; fatal: boolean; deltas: Array<{ statId: string; before: unknown; after: unknown }>; f: (typeof audit.findings)[number]; changes: unknown; costs: string | null }> = [];
  for (const f of audit.findings.filter((x) => x.edits?.length).slice(0, 8)) {
    try {
      const t = await trial(ctx, f.edits as ToolEdit[]);
      tried.push({ id: f.id, fatal: f.fatal, deltas: t.deltas, f, changes: changeRows(pickChanges(t.deltas, 6)), costs: costsLine(costRows(t.deltas)) });
    } catch {
      // a fix the engine refuses is left out
    }
  }
  // a flat-accuracy suffix on an open affix of owned gear: the engine rates only the accuracy mods of each slot's pool, so it is a few previews
  if (wantBuy) {
    const c = await craftOption(ctx, buildId, xml, started).catch(() => null);
    if (c) tried.push(c as never);
  }
  const split = splitFixes(tried);
  const asFix = (x: (typeof tried)[number]): Plan => ({ id: x.id, fatal: x.fatal, line: `${x.f.shown}${x.f.fix ? `. ${x.f.fix}` : ''}`, edits: x.f.edits, changes: x.changes, costs: x.costs });
  const fixes: Plan[] = split.apply.map(asFix);
  // over the cap: not applied; offered as a one-tap card with its numbers (fatal fixes follow the same cap)
  // the why rides in costs too: the answer quotes costs, and a card must say why it was not applied (Walrus without it)
  const offers: Plan[] = split.offer.map((x) => { const why = overCap(x.deltas) ?? (/^pantheonSwap:/.test(x.id) ? 'not applied: it replaces the major god you chose, so it is your call' : ROLLED_SWAP.test(x.id) ? 'not applied: the suffix is already rolled on your flask, so buy one with it or reroll that flask' : null); const costs = x.costs ?? costsLine(costRows(x.deltas as never)); return { ...asFix(x), costs: [costs, why].filter(Boolean).join(", "), why }; });
  // tree routes for an accuracy shortfall: the notables that give accuracy, each as takeNode would take it
  const routes: Plan[] = [];
  const routeOffers: Plan[] = [];
  const routeNotes: string[] = [];
  let anointOffer: AnointOffer | null = null;
  const short = audit.findings.find((f) => /enough Accuracy for/i.test(f.shown));
  planLog('audit', { findings: audit.findings.map((f) => f.id), accuracyShort: !!short, fixes: fixes.length });
  if (short) {
    const take = RANK_TOOLS.find((t) => t.name === 'takeNode')!;
    const { tree } = await ctx.engine.send('treeState', { buildId });
    const have = new Set(tree.allocated);
    const nodes = (await ctx.tree.search(tree.treeVersion, 'accuracy', 14).catch(() => [])).filter((n) => !have.has(n.id) && (n.type === 'Notable' || n.type === 'Normal') && !n.ascendancy && n.stats.some((s) => /accuracy rating/i.test(s)));
    // the routes have a budget of their own: the audit and the fixes before them already used the plan's first seconds
    const routesFrom = Date.now();
    planLog('routes.start', { nodes: nodes.map((x) => x.name).slice(0, 6), elapsed: Date.now() - started });
    // cheaper than tree points: a higher Precision level (its extra mana reservation checked) and the fixes the step applies anyway,
    // on before any node is chosen, so passives (and the life they cost) are only taken for what is still missing
    let include: ToolEdit[] = [];
    let includeLabel = '';
    for (const g of readSkills(xml)) {
      for (const x of g.enabled ? g.gems : []) {
        if (!/^Precision$/i.test(x.name) || !x.enabled || (x.level ?? 20) >= 20 || include.length) continue;
        const edits: ToolEdit[] = [{ kind: 'setGem', group: g.index, gem: x.index, attr: 'level', value: 20 }];
        const t = await trial(ctx, edits).catch(() => null);
        const mana = t?.deltas.find((d) => d.statId === 'ManaUnreserved');
        if (t && !(typeof mana?.before === 'number' && mana.before >= 0 && typeof mana.after === 'number' && mana.after < 0)) { include = edits; includeLabel = `Precision level ${x.level} to 20`; }
      }
    }
    // several nodes together, paid for with the cheapest refunds, measured with the keystone on (one node alone often reaches nothing)
    const pre = fixes.flatMap((f) => (f.edits as ToolEdit[] | undefined) ?? []) as never;
    const multi = await thresholdRoute(ctx, buildId, ACCURACY_OVER_LIFE, { pre, include: include as never, includeLabel }).catch(() => null);
    // an anoint on the amulet the build wears: oils instead of passive points, so no life is given up for it
    const anoint = await bestAnoint(ctx, buildId, ACCURACY_OVER_LIFE).catch(() => null);
    planLog('anoint', { found: !!anoint, name: anoint?.name, alone: anoint?.alone, lost: anoint?.lost });
    const anointed = anoint ? await thresholdRoute(ctx, buildId, ACCURACY_OVER_LIFE, { pre, include: [...include, anoint.edit] as never, includeLabel: [includeLabel, anoint.label].filter(Boolean).join(', then '), noCushion: true }).catch(() => null) : null;
    const entryOf = (m: NonNullable<typeof multi>) => ({ node: m.node, why: short.fix, pathPoints: m.pathPoints, nodes: m.nodes, dropped: m.dropped, changes: m.changes, edits: m.edits, line: m.line });
    for (const m of [multi, anointed]) {
      if (!m) continue;
      const entry = entryOf(m);
      const lostLayer = m.switchedOff?.find((o) => /suppression/i.test(o));
      let verdict = lostLayer ? 'drop' : classifyRoute({ changes: m.changes, maxHits: m.maxHits }, m.bigLoss);
      // an anoint that holds back a defence layer is never applied: it is offered as a card when it beats the tree route on net gain
      if (m === anointed && lostLayer && !m.bigLoss.some((b) => /suppression/i.test(b)) && (!multi || netGain(entry) > netGain(entryOf(multi)))) verdict = 'offer';
      if (m === anointed && lostLayer && anoint) routeNotes.push(`The ${anoint.name} anoint would reach it too, but costs ${lostLayer}${verdict === 'offer' && anoint.alone ? ': it gains more than the tree route, so the app offers it as a card' : ''}`);
      // the app makes this card itself after the route goes in (service.applyLive), so it never depends on the model
      if (m === anointed && lostLayer && verdict === 'offer' && anoint?.alone) {
        anointOffer = { edit: anoint.edit, title: `Anoint ${anoint.name} instead of the passive swap`, summary: `it undoes the passive swap and costs ${lostLayer}, which was already far from the 100% cap.` };
        continue;
      }
      planLog('route', { node: m.node, points: m.pathPoints, verdict, gain: dpsGain(entry), multi: true, anoint: m === anointed });
      if (verdict === 'offer') routeOffers.push({ ...entry, id: `route:${m.node}`, costs: lostLayer ?? null });
      else if (verdict === 'apply') routes.push(entry);
    }
    for (const n of multi || anointed ? [] : nodes.slice(0, 4)) {
      if (Date.now() - routesFrom > 8000) break;
      try {
        const r = (await take.run({ nodeId: n.id }, ctx)) as Record<string, unknown>;
        const off = (r.switchedOff as string[] | undefined) ?? [];
        const entry = { node: n.name, why: short.fix, pathPoints: r.pathPoints, dropped: r.dropped, changes: r.changes, edits: r.edits };
        const verdict = off.some((o) => /suppression/i.test(o)) ? 'drop' : classifyRoute({ changes: r.changes as never, maxHits: r.maxHits as never }, (r.bigLoss as string[] | undefined) ?? []);
        planLog('route', { node: n.name, points: r.pathPoints, verdict, gain: dpsGain(entry) });
        // over the cap: offered (never applied) when what it unlocks is worth far more than it costs
        if (verdict === 'offer') routeOffers.push({ ...entry, id: `route:${n.name}`, line: `Take ${n.name} for the accuracy (${r.pathPoints} points, giving up the nodes in dropped)`, costs: null });
        else if (verdict === 'apply') routes.push(entry);
      } catch (e) {
        planLog('route.error', { node: n.name, message: String(e instanceof Error ? e.message : e).slice(0, 120) });
      }
    }
    routes.sort((a, b) => netGain(b) - netGain(a));
  }
  // accuracy from a gem is cheaper than from the tree: raise Precision (or any accuracy aura) to its natural top level
  if (short) {
    const groups = readSkills(xml);
    for (const g of groups) {
      if (!g.enabled) continue;
      for (const x of g.gems) {
        if (!/^Precision$/i.test(x.name) || !x.enabled || (x.level ?? 20) >= 20) continue;
        const edits: ToolEdit[] = [{ kind: 'setGem', group: g.index, gem: x.index, attr: 'level', value: 20 }];
        if (routes.some((r) => (r.edits as ToolEdit[] | undefined)?.some((e) => JSON.stringify(e) === JSON.stringify(edits[0])))) continue;
        try {
          const t = await trial(ctx, edits);
          routes.push({ node: `Precision level ${x.level} to 20`, why: short.fix, pathPoints: 0, changes: changeRows(pickChanges(t.deltas, 6)), edits, gem: true });
        } catch { /* not possible */ }
      }
    }
    // the way to the accuracy is picked by the engine's net gain: damage, less what the route costs in life and effective HP
    routes.sort((a, b) => netGain(b) - netGain(a));
  }
  const mana = await manaFix(ctx, buildId, xml, started);
  const quality = await qualityOption(ctx, buildId, xml).catch(() => null);
  // a ring that brings the accuracy (gear is the cheap fix): the best listing within the player's budget, priced, as an option
  const buys: Plan[] = [];
  let buyError = '';
  if (short) {
    const found = await buyP;
    // a few listings per slot, then the engine picks the set (one item, or two that only unlock the keystone together) with the fixes on
    const fixEdits = fixes.flatMap((f) => (f.edits as ToolEdit[] | undefined) ?? []);
    type Cand = { slot: string; name: string; itemText: string; accuracy: number; chaos: unknown; divine: unknown; ageMinutes: unknown; online: unknown; link?: string; gain: unknown };
    const cands: Cand[] = [...(await accP), ...found].flatMap(({ slot, r }) => (r?.candidates ?? []).filter((x) => typeof x.itemText === 'string').slice(0, 3).map((x) => ({ slot, name: String(x.name), itemText: String(x.itemText), accuracy: Number(/\+(\d+) to Accuracy Rating/.exec(String(x.itemText))?.[1] ?? 0), chaos: x.chaos, divine: x.divine, ageMinutes: x.ageMinutes, online: x.online, ...(r?.link ? { link: r.link } : {}), gain: x.gain })));
    planLog('buy.result', { candidates: cands.map((c) => [c.slot, c.name, c.accuracy]) });
    const dpsOf = async (set: Cand[]) => {
      // nothing to try on: the build's own number (a trial with no edits is not a thing the engine does)
      if (!set.length && !fixEdits.length) { const st = await statMap(ctx, buildId); return typeof st.FullDPS === 'number' && st.FullDPS > 0 ? st.FullDPS : Number(st.CombinedDPS ?? 0); }
      const t = await trial(ctx, [...fixEdits, ...set.map((c) => ({ kind: 'setItem', slot: c.slot, itemText: c.itemText }) as ToolEdit)]);
      const d = t.deltas.find((x) => x.statId === 'FullDPS' && typeof x.before === 'number' && x.before > 0) ?? t.deltas.find((x) => x.statId === 'CombinedDPS');
      return typeof d?.after === 'number' ? d.after : 0;
    };
    try {
      const base0 = fixEdits.length ? await dpsOf([]) : await dpsOf([]);
      const best = await chooseGear(cands, dpsOf, 2);
      planLog('buy.best', { set: best.set.map((c) => [c.slot, c.name]), gain: Math.round(best.dps - base0) });
      if (best.set.length && best.dps > base0) {
        const t = await trial(ctx, [...fixEdits, ...best.set.map((c) => ({ kind: 'setItem', slot: c.slot, itemText: c.itemText }) as ToolEdit)]);
        for (const c of best.set) buys.push({ slot: c.slot, name: c.name, price: { chaos: c.chaos, divine: c.divine }, priceShown: typeof c.divine === 'number' && c.divine > 0 ? `${Math.round(c.divine * 100) / 100} div` : typeof c.chaos === 'number' ? `${Math.round(c.chaos)}c` : null, ageMinutes: c.ageMinutes, ...(typeof c.ageMinutes === 'number' ? { listed: agoText(c.ageMinutes) } : {}), online: c.online, link: c.link, gain: c.gain, edits: [{ kind: 'setItem', slot: c.slot, itemText: c.itemText }], ...(dearDeltas(t.deltas) ? { overCap: true } : {}) });
      }
    } catch (e) { buyError = e instanceof Error ? e.message : String(e); planLog('buy.error', { message: buyError }); }
    // accuracy from the item the plan is buying anyway costs no life: when that item alone (with the fixes on) takes the line, the passive
    // route that gives up life nodes goes to an offer card instead of being applied (a gem level, which costs nothing, stays)
    const buyEdits = buys.flatMap((b) => (b.edits as ToolEdit[] | undefined) ?? []);
    // (only an item that carries accuracy can do it: otherwise the check is skipped and costs no plan time)
    if (buyEdits.length && cands.some((c) => c.accuracy > 0 && buys.some((b) => b.name === c.name)) && routes.some((r) => Number(r.pathPoints) > 0)) {
      const viaItem = await thresholdRoute(ctx, buildId, ACCURACY_OVER_LIFE, { pre: fixEdits as never, include: buyEdits as never, includeLabel: 'the bought item' }).catch(() => null);
      planLog('buy.accuracy', { alone: !!viaItem && viaItem.pathPoints === 0 && !viaItem.dropped.length });
      if (viaItem && viaItem.pathPoints === 0 && !viaItem.dropped.length) {
        for (const r of routes.filter((x) => Number(x.pathPoints) > 0)) routeOffers.push({ ...r, id: `route:${String(r.node)}`, costs: null });
        routes.splice(0, routes.length, ...routes.filter((x) => !(Number(x.pathPoints) > 0)));
      }
    }
  }
  // the priced Enlighten fix stands for the audit's own over-reservation fix (the same swap, or an aura off)
  const notMana = (f: Plan) => !(mana && f.id === 'manaUnreserved');
  const allFixes = [...fixes.filter(notMana), ...(mana ? [mana] : []), ...(quality && !quality.offer ? [quality.plan] : [])].map((f) => ({ ...f, use: `fix:${String(f.id)}` }));
  const allRoutes = routes.map((r, i) => ({ ...r, use: `route:${i + 1}` }));
  const allBuys = buys.map((b, i) => ({ ...b, use: `buy:${i + 1}` }));
  const allOffers = [...offers.filter(notMana), ...routeOffers, ...(quality?.offer ? [quality.plan] : []), ].map((o) => ({ ...o, use: `offer:${String(o.id)}` }));
  planLog('done', { ms: Date.now() - started, fixes: allFixes.length, offers: allOffers.length, routes: allRoutes.length, buys: allBuys.length });
  return { fixes: allFixes, offers: allOffers, routes: allRoutes, buy: allBuys, ...(buyError ? { buyError } : {}), ...(routeNotes.length ? { routeNotes } : {}), ...(anointOffer ? { anointOffer } : {}), note: 'Ready-made, engine-checked options. Apply the fixes, the best route and the buy option together in ONE proposeEdit; each offers entry (a fix over the five percent cap, with its numbers in costs) is NOT applied: say its cost and its why in one line and make it a separate proposeEdit with offer: true and planIds [its use id]. Pass the use ids as planIds: pass their use ids as planIds (the edits are added for you; do not write them out). A route line names every node it takes and every node it gives up: say all of them, each by its name and stat line as the line gives it. The app writes the nodes, the anoint with its oils and price, and the accuracy margin under the answer as its Details line: your own words on the accuracy are one short clause at most, and never repeat what that line says. When passives are given up, say in one clause why those: they are the end nodes whose loss the engine found cheapest in damage and effective HP. The guards are already applied: no route here loses spell suppression or drops a stat more than 15%. Say how old a price or listing is with its priced or listed field as it is ("priced just now"), never ageMinutes followed by your own word.' };
}

function netGain(p: Plan): number {
  const rows = (p.changes as Array<{ stat: string; percent: number | null }> | undefined) ?? [];
  return dpsGain(p) + rows.filter((r) => /^(Life|TotalEHP)$/.test(r.stat)).reduce((a, r) => a + Math.min(0, num(r.percent)), 0);
}

function dpsGain(p: Plan): number {
  const rows = (p.changes as Array<{ stat: string; percent: number | null }> | undefined) ?? [];
  return num(rows.find((r) => /DPS$/.test(r.stat))?.percent);
}

export const PLAN_TOOLS: ToolDef[] = [
  {
    name: 'planBudget',
    chip: 'Plan budget',
    description:
      'For "what should I spend my currency on" once the player has said a budget: the best buys for it (several slots searched on the trade site, each put on the build by the engine, best gain per chaos first, never over the budget), each with its price, its own engine change and its trade link, and the total against the budget. The app already put each on a one-tap card. Name each item by its shown line.',
    shape: {},
    async run(_args, ctx) {
      const r = await budgetSpend(ctx);
      if (!r) return { untrustedData: true, buildChanged: false, spend: null, note: 'No listing within the budget beats what the build has, or no budget is stated. Say so plainly; do not invent a buy.' };
      return { untrustedData: true, buildChanged: false, spend: r.spend, note: 'Name each spend.items entry as its placeholder ({{ref:spend.items[i].shown}}) with its link ({{ref:spend.items[i].link}}), and its costs ({{ref:spend.items[i].costs}}) right after it when present, then say spend.totalShown the same way. When spend.levelNote is present, say it ({{ref:spend.levelNote}}) and never call the numbers a level 100 plan or provisional. Never write a Costs line of your own or from another result: the costs of a buy belong to its own entry, and only what went in is a cost of the change. Each is already a one-tap card. Do not add numbers of your own. The fixes already in are named in the app first line: give their gain in one sentence and never list them again one by one. Keep the answer to the gain of what went in, the buys, the total and at most one caveat. Never advise a fix that is already in ("prioritize the mana fix" after it went in): it is done. spend.items go biggest gain first: write every entry as its own placeholder line, the first one first and never folded into your own words ("buy the rings as a pair" with no names, prices or numbers), and only the first one may be called the biggest gain.' + (r.spend.weak ? ' No single buy adds more than 3% damage or effective HP: say plainly that this budget buys only small gains, and that the real fixes are the ones already in (never call a bought fix free).' : '') };
    },
  },
  {
    name: 'planUpgrade',
    chip: 'Plan upgrade',
    description:
      'For "what should I upgrade next" and similar open-ended advice: one call that returns the audit fixes with their edits and engine before/after, and tree routes for what is short (accuracy), already checked against the guards. The app starts it when the question arrives, so it is usually ready at once. Pass the edits you choose to proposeEdit, all in one call.',
    shape: { draftId: z.string().max(20).optional() },
    async run(_args, ctx) {
      const fromApp = appCall;
      appCall = false;
      const mine = fromApp ? undefined : auto.get(need(ctx).buildKey);
      if (mine) {
        const applied = await Promise.race([mine.applied, new Promise<null>((res) => setTimeout(() => res(null), 25_000))]).catch(() => null);
        // what is applied or turned into a card by the app is not handed over as edits to carry out: the model has only the words left to write
        const slim = (xs: unknown) => (Array.isArray(xs) ? xs.map(({ edits: _e, deltas: _d, ...rest }: Record<string, unknown>) => rest) : xs);
        const offers = ((mine.plan.offers as Array<Record<string, unknown>> | undefined) ?? []);
        const cards = applied ? offers.filter((o) => !o.fatal) : [];
        return {
          untrustedData: true,
          buildChanged: false,
          ...mine.plan,
          ...(applied ? { fixes: slim(mine.plan.fixes), routes: slim(mine.plan.routes), buy: slim(mine.plan.buy), offers: slim(offers.filter((o) => o.fatal)), offerCards: slim(cards), anointOffer: undefined } : {}),
          ...(applied ? { alreadyApplied: applied, ...(Array.isArray(applied.treeNotes) ? { treeNotes: applied.treeNotes } : {}), alreadyAppliedNote: `The app already applied ${mine.used.join(', ')} to the open build as one Undo step (alreadyApplied is its result, with the numbers) and has put each one-tap option (offerCards: flask suffixes and the like, with their costs) on a card itself, plus the anoint card when routeNotes says so: word the answer from alreadyApplied and offerCards, and call no proposeEdit at all.` } : {}),
        };
      }
      return { untrustedData: true, buildChanged: false, ...(await plan(ctx)) };
    },
  },
];

const ROLLED_SWAP = /^(flaskImmunity|pantheonSwap):/;

/** Where a bought fix with no price line comes from: the player still needs a way to get it (Enlighten 3, "price unknown"). */
const UNPRICED = 'no price on poe.ninja: buy it from another player on the trade site';

/** More than about five percent off life, effective HP or armour: too much for a fix the player did not ask for. */
export function dearRows(changes: unknown, maxHits: unknown): boolean {
  const rows = [...((changes as Array<{ stat: string; percent: number | null }> | undefined) ?? []), ...((maxHits as Array<{ stat: string; percent: number | null }> | undefined) ?? [])];
  return rows.some((r) => /^(Life|TotalEHP|Armour|PhysicalMaximumHitTaken|EffectiveMovementSpeedMod)$/.test(r.stat) && (r.percent ?? 0) < -5);
}

const ENLIGHTEN = 'Metadata/Items/Gems/SkillGemSupportEnlighten';
const AURAS = /Determination|Grace|Haste|Hatred|Anger|Wrath|Pride|Zealotry|Discipline|Clarity|Purity|Vitality|Precision|Malevolence|Herald|Arrogance|Blood Magic/i;

/** Unreserved mana below zero: Enlighten in place of one support of an aura group (the engine picks the support), with its price. */
async function manaFix(ctx: ToolContext, buildId: string, xml: string, started: number): Promise<Plan | null> {
  const stats = await statMap(ctx, buildId);
  if (!(typeof stats.ManaUnreserved === 'number' && stats.ManaUnreserved < 0)) return null;
  let best: { edits: ToolEdit[]; where: string; old: string; after: number; loss: number; changes: unknown; costs: string | null } | null = null;
  for (const g of readSkills(xml)) {
    if (!g.enabled || !g.gems.some((x) => !x.support && AURAS.test(x.name))) continue;
    for (const x of g.gems) {
      if (!x.support || Date.now() - started > BUDGET_MS * 2) continue;
      const edits: ToolEdit[] = [{ kind: 'setGemSkill', group: g.index, gem: x.index, gemId: ENLIGHTEN }, { kind: 'setGem', group: g.index, gem: x.index, attr: 'level', value: 3 }];
      try {
        const t = await trial(ctx, edits);
        const d = (id: string) => t.deltas.find((r) => r.statId === id);
        const after = Number(d('ManaUnreserved')?.after ?? NaN);
        if (!(after >= 0)) continue;
        const rel = (id: string) => { const r = d(id); return typeof r?.before === 'number' && typeof r.after === 'number' && r.before ? (r.after - r.before) / Math.abs(r.before) : 0; };
        const loss = -(Math.min(0, rel('CombinedDPS')) + Math.min(0, rel('TotalEHP')));
        if (!best || loss < best.loss) best = { edits, where: g.label || g.gems.find((y) => !y.support)?.name || `group ${g.index}`, old: x.name, after, loss, changes: changeRows(pickChanges(t.deltas, 6)), costs: costsLine(costRows(t.deltas)) };
      } catch { /* this swap is not possible */ }
    }
  }
  if (!best) return null;
  let price: unknown = null;
  try {
    const lookup = TOOLS.find((t) => t.name === 'lookupPrice');
    if (lookup && ctx.prices) price = await lookup.run({ names: ['Enlighten Support'], gemLevel: 3 }, ctx);
  } catch { /* no price: the answer says it is not priced */ }
  return { id: 'mana:enlighten', fatal: true, line: `Unreserved mana is ${Math.round(Number(stats.ManaUnreserved))}: Enlighten level 3 in place of ${best.old} in the ${best.where} group fixes it (unreserved mana ${Math.round(best.after)})`, edits: best.edits, changes: best.changes, costs: best.costs, buy: { gem: 'Enlighten Support level 3', price } };
}

/**
 * The gem at 0% quality whose 20% gains the most damage plus effective HP (Boneshatter, Pride and Precision at
 * 0%): 20 Gemcutter's Prisms, +1% quality each (poewiki.net/wiki/Gemcutter's_Prism), priced. A fix when the player's stated budget
 * covers it, else an offer that says why.
 */
export async function qualityOption(ctx: ToolContext, buildId: string, xml: string): Promise<{ plan: Plan; offer: boolean } | null> {
  const s = await statMap(ctx, buildId);
  const dps = num(s.FullDPS) > 0 ? 'FullDPS' : 'CombinedDPS';
  const seen = new Set<string>();
  let best: { name: string; edit: ToolEdit; score: number } | null = null;
  for (const g of readSkills(xml)) {
    for (const x of g.enabled ? g.gems : []) {
      if (!x.enabled || (x.quality ?? 0) > 0 || seen.has(x.name) || seen.size >= 16) continue;
      seen.add(x.name);
      const edit: ToolEdit = { kind: 'setGem', group: g.index, gem: x.index, attr: 'quality', value: 20 };
      const r = await ctx.engine.send('previewEdit', { buildId, edit: toBuildEdit(edit), full: dps === 'FullDPS' }).catch(() => null);
      if (!r || r.blocked) continue;
      const rel = (id: string) => { const c = r.statDiff.changed.find((y) => y.statId === id); return c && typeof c.after === 'number' && num(s[id]) > 0 ? (c.after - num(s[id])) / num(s[id]) : 0; };
      const score = rel(dps) + rel('TotalEHP');
      if (score > 0 && (!best || score > best.score)) best = { name: x.name, edit, score };
    }
  }
  if (!best) return null;
  const t = await trial(ctx, [best.edit]);
  const r = await ctx.prices?.lookup(["Gemcutter's Prism"]).catch(() => null);
  const each = r?.lines[0]?.find((l) => l.name === "Gemcutter's Prism")?.chaos;
  const chaos = each !== undefined ? Math.round(each * 20) : null;
  const said = ctx.profiles ? (await ctx.profiles.get(need(ctx).buildKey))?.budget : undefined;
  const budget = budgetChaos(said, r?.chaosPerDivine ?? 0);
  const fits = chaos !== null && budget !== null && chaos <= budget;
  const why = fits ? null : chaos === null ? "not applied: no price for Gemcutter's Prism" : budget === null ? 'not applied: no budget stated' : `not applied: ${chaos}c is over the budget`;
  return {
    offer: !fits,
    plan: { id: `quality:${best.name}`, fatal: false, line: `${best.name} is at 0% quality: 20% quality is the best of ${seen.size} gems at 0%, 20 Gemcutter's Prisms (+1% each)${chaos !== null ? `, about ${chaos}c` : ''}`, edits: [best.edit], changes: changeRows(pickChanges(t.deltas, 6)), costs: costsLine(costRows(t.deltas)), buy: { gem: "20 Gemcutter's Prisms", price: chaos !== null ? { chaos, chaosPerDivine: r?.chaosPerDivine ?? 0 } : null }, ...(why ? { why } : {}) },
  };
}

/** The edits of the plan options with these use ids (the plan is the one cached for the open build). */
export async function planEdits(ctx: ToolContext, ids: string[]): Promise<ToolEdit[]> {
  const mine = auto.get(need(ctx).buildKey);
  const p = ((mine?.plan ?? (await plan(ctx))) as { fixes?: Array<{ use: string; edits?: ToolEdit[] }>; routes?: Array<{ use: string; edits?: ToolEdit[] }>; buy?: Array<{ use: string; edits?: ToolEdit[] }>; offers?: Array<{ use: string; edits?: ToolEdit[] }> });
  const all = [...(p.fixes ?? []), ...(p.routes ?? []), ...(p.buy ?? []), ...(p.offers ?? [])];
  const out: ToolEdit[] = [];
  for (const id of ids) {
    const hit = all.find((x) => x.use === id);
    if (!hit) throw new Error(`No planUpgrade option ${id}. Options: ${all.map((x) => x.use).join(', ')}.`);
    // already applied by the app: its tree edits are clicks, so a second time would take the nodes back out
    if (mine?.used.includes(id)) continue;
    out.push(...(hit.edits ?? []));
  }
  return out;
}

/** The same cap on a whole before/after diff. */
export function dearDeltas(deltas: Array<{ statId: string; before: unknown; after: unknown }>): boolean {
  return !!overCap(deltas);
}

/** Why a fix is a card and not applied: the first stat it lowers past the 5% cap, with its numbers (Walrus, movement speed -5.5%). */
export function overCap(deltas: Array<{ statId: string; before: unknown; after: unknown }>): string | null {
  // a new ailment immunity is judged on what the armour loss does (effective HP, the physical max hit), not on the armour number
  const immune = deltas.some((x) => /^(Freeze|Chill|Shock|Ignite|Poison|Bleed|Stun)AvoidChance$/.test(x.statId) && typeof x.before === 'number' && typeof x.after === 'number' && x.before < 100 && x.after >= 100);
  const d = deltas.find((x) => (immune ? /^(Life|TotalEHP|PhysicalMaximumHitTaken|EffectiveMovementSpeedMod)$/ : /^(Life|TotalEHP|Armour|PhysicalMaximumHitTaken|EffectiveMovementSpeedMod)$/).test(x.statId) && typeof x.before === 'number' && typeof x.after === 'number' && x.before > 0 && (x.after - x.before) / x.before < -0.05);
  if (!d) return null;
  const [b, a] = [d.before as number, d.after as number];
  return `not applied: ${statMeta(d.statId).label} ${formatStat(d.statId, b)} to ${formatStat(d.statId, a)} (${Math.round(((a - b) / b) * 1000) / 10}%) is over the 5% cap`;
}

/** The price of a plan option in divines, from whatever the price result holds (a `divine` number, or chaos over chaosPerDivine). */
function divinesOf(price: unknown): number {
  let div = 0;
  let chaos = 0;
  let per = 0;
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === 'number') {
        if (/^divine$/i.test(k) && !div) div = x;
        else if (/^chaos$/i.test(k) && !chaos) chaos = x;
        else if (/chaosPerDivine/i.test(k) && !per) per = x;
      } else walk(x, depth + 1);
    }
  };
  walk(price, 0);
  return div || (chaos && per ? chaos / per : 0);
}

/** "Total spend: 3.2 div" for the plan options taken (their prices in one unit), or null when none is priced. */
export async function planSpend(ctx: ToolContext, ids: string[]): Promise<string | null> {
  // the turn's cached plan: a fresh plan() loads scratch copies that push the model's own trial out of the engine ("unknown build id")
  const p = (auto.get(need(ctx).buildKey)?.plan ?? (await plan(ctx))) as { fixes?: Array<{ use: string; buy?: { gem?: string; price?: unknown } }>; buy?: Array<{ use: string; price?: unknown }> };
  let total = 0;
  const unknown: string[] = [];
  for (const id of ids) {
    const f = p.fixes?.find((x) => x.use === id);
    const b = p.buy?.find((x) => x.use === id);
    const d = divinesOf(f?.buy?.price ?? b?.price);
    total += d;
    // something that has to be bought but has no price: said, never left out of the total (0.9 div without Enlighten)
    if (!d && f?.buy) unknown.push(`${f.buy.gem ?? 'a bought item'} (${UNPRICED})`);
  }
  const rest = unknown.length ? `${total > 0 ? ' plus ' : ' '}${unknown.join(' and ')}` : '';
  return total > 0 || unknown.length ? `Total spend:${total > 0 ? ` ${Math.round(total * 10) / 10} div` : ''}${rest}` : null;
}

/** What the plan says about the route that was not applied (for the app-written Tree line), when a route is among these ids. */
export async function planRouteNotes(ctx: ToolContext, ids: string[]): Promise<string[]> {
  if (!ids.some((id) => /^route:/.test(id))) return [];
  return ((auto.get(need(ctx).buildKey)?.plan ?? (await plan(ctx))) as { routeNotes?: string[] }).routeNotes ?? [];
}

/** The listing the engine says gains most with it equipped (its own before/after, so an unlocked keystone shows), or null when none gains. */
export function pickBuy(candidates: Array<Record<string, unknown>>): Record<string, unknown> | null {
  const gain = (x: Record<string, unknown>) => (x.gain as { percent?: number | null } | null)?.percent ?? 0;
  return [...candidates].filter((x) => typeof x.itemText === 'string' && gain(x) > 0).sort((a, b) => gain(b) - gain(a))[0] ?? null;
}


/** What a stated budget buys: listings of several slots priced and put on the build by the engine, the best per chaos picked, each a card's worth of data. */
export interface SpendResult { spend: { items: Array<{ slot: string; name: string; shown: string; link: string | null; chaos: number; costs?: string }>; totalShown: string; budgetChaos: number; weak: boolean; levelNote?: string }; offers: Array<{ title: string; edits: ToolEdit[] }> }
const spendJobs = new Map<string, { at: number; text: string; result: Promise<SpendResult | null> }>();

export function budgetSpend(ctx: ToolContext): Promise<SpendResult | null> {
  const open = need(ctx);
  const hit = spendJobs.get(open.buildKey);
  if (hit && hit.text === turnAsk.text && Date.now() - hit.at < 120_000) return hit.result;
  const result = computeSpend(ctx).catch((e) => { planLog('spend.error', { message: String(e instanceof Error ? e.message : e) }); return null; });
  spendJobs.set(open.buildKey, { at: Date.now(), text: turnAsk.text, result });
  return result;
}

async function computeSpend(ctx: ToolContext): Promise<SpendResult | null> {
  if (!runner) return null;
  const slots = ['Ring 1', 'Amulet', 'Belt'];
  // what the engine says the build needs most decides how the listings are ranked: a resistance under its cap is a defence problem (effective HP), else damage
  const now = await statMap(ctx, need(ctx).buildId).catch(() => ({} as Record<string, number | string | boolean | null>));
  const underCap = ['Cold', 'Fire', 'Lightning', 'Chaos'].some((e) => typeof now[`${e}Resist`] === 'number' && typeof now[`${e}ResistMax`] === 'number' && (now[`${e}Resist`] as number) < (now[`${e}ResistMax`] as number) - 1 && (e !== 'Chaos' || (now.ChaosResist as number) < 60));
  const rank = underCap ? 'ehp' : 'dps';
  planLog('spend.rank', { rank });
  const found = await Promise.race([
    Promise.all(slots.map(async (slot) => ({ slot, r: (await Promise.resolve(runner!('upgradeCandidates', { slot, rank })).catch(() => null)) as { candidates?: Array<Record<string, unknown>>; link?: string; chaosPerDivine?: number } | null }))),
    new Promise<Array<{ slot: string; r: null }>>((res) => setTimeout(() => res([]), 14_000)),
  ]);
  const cpd = found.map((f) => Number(f.r?.chaosPerDivine ?? 0)).find((x) => x > 0) ?? 0;
  const said = ctx.profiles ? (await ctx.profiles.get(need(ctx).buildKey))?.budget : undefined;
  const budget = budgetChaos(said, cpd) ?? budgetChaos(turnAsk.text, cpd);
  const cands = found.flatMap(({ slot, r }) => (r?.candidates ?? []).filter((x) => typeof x.itemText === 'string' && typeof x.chaos === 'number').map((x) => ({ slot, name: String(x.name), itemText: String(x.itemText), chaos: x.chaos as number, divine: x.divine, gain: x.gain, link: r?.link })));
  planLog('spend.candidates', { budget, cpd, n: cands.length });
  if (!budget || budget <= 0 || !cands.length) return null;
  // the fixes the app already put in that are bought (prisms, an Enlighten) come out of the same budget, an unpriced one said as such
  // (178c of prisms and Enlighten 3 were left out of "2.04 div of your 5 div")
  const mine = auto.get(need(ctx).buildKey);
  await mine?.applied.catch(() => null);
  const bought = ((mine?.plan as { fixes?: Array<{ use: string; buy?: { gem?: string; price?: unknown } }> } | undefined)?.fixes ?? []).filter((f) => mine!.used.includes(f.use) && f.buy);
  // a gem the price book had not loaded at plan time (the gem category comes last) is priced again now, at its level (Enlighten 3 unpriced)
  const lookup = TOOLS.find((t) => t.name === 'lookupPrice');
  for (const f of bought) {
    const m = /^(.+?) level (\d+)$/.exec(f.buy!.gem ?? '');
    if (divinesOf(f.buy!.price) > 0 || !m || !lookup) continue;
    const pr = await lookup.run({ names: [m[1]], gemLevel: Number(m[2]) }, ctx).catch(() => null);
    if (divinesOf(pr) > 0) f.buy!.price = pr;
  }
  const fixChaos = bought.reduce((a, f) => a + divinesOf(f.buy!.price) * cpd, 0);
  const unpriced = bought.filter((f) => !(divinesOf(f.buy!.price) > 0)).map((f) => f.buy!.gem ?? 'a bought item');
  // the plan's accuracy buy (the set that turns the keystone on, +37% damage) is spent on first, before any ~1% gear
  const accSet = ((mine?.plan as { buy?: Array<{ slot: string; name: string; price?: { chaos?: unknown; divine?: unknown }; edits?: ToolEdit[]; link?: string }> } | undefined)?.buy ?? []).filter((x) => typeof x.price?.chaos === 'number' && x.edits?.length);
  const accChaos = accSet.reduce((a, x) => a + (x.price!.chaos as number), 0);
  const takeAcc = accSet.length > 0 && accChaos <= budget - fixChaos;
  planLog('spend.acc', { set: accSet.map((x) => [x.slot, x.name, x.price?.chaos]), all: ((mine?.plan as { buy?: unknown[] } | undefined)?.buy ?? []).length, accChaos, room: budget - fixChaos, takeAcc });
  const picks = pickBudgetBuys(cands.filter((c) => !takeAcc || !accSet.some((x) => x.slot === c.slot)), Math.max(0, budget - fixChaos - (takeAcc ? accChaos : 0)), takeAcc ? Math.max(1, 3 - accSet.length) : 3);

  const shownPrice = (c: { chaos: number; divine: unknown }) => `${typeof c.divine === 'number' && c.divine >= 0.1 ? `${Math.round(c.divine * 100) / 100} div` : `${Math.round(c.chaos)}c`} (${Math.round(c.chaos)}c)`;
  const items: SpendResult['spend']['items'] = [];
  const offers: SpendResult['offers'] = [];
  let best = 0;
  // the buys are compared at the level the player says the character is ("I'm level 92" read against the level-100 file)
  const lvl = askedLevel(turnAsk.text);
  const lvEdits: ToolEdit[] = lvl ? [{ kind: 'setLevel', level: lvl } as ToolEdit] : [];
  const base = lvl ? await trial(ctx, lvEdits).catch(() => null) : null;
  const atLevel = async (edits: ToolEdit[]) => {
    const t = await trial(ctx, [...lvEdits, ...edits]);
    return base ? { ...t, deltas: rebaseDeltas(t.deltas, base.deltas) } : t;
  };
  if (takeAcc) {
    const edits = accSet.flatMap((x) => x.edits!);
    const t = await atLevel(edits).catch(() => null);
    if (t) {
      const rows = changeRows(pickChanges(t.deltas, 8)).filter((r) => /DPS$|^TotalEHP$|^Life$/.test(r.stat));
      // a buy's costs ride on its own line: a bare "Costs:" read as the cost of what went in (suppression 47% to 35% from the unbought helmet)
      const costs = costsLine(costRows(t.deltas))?.replace(/^Costs: /, 'It costs ');
      const pctOf = (id: string) => { const d = t.deltas.find((x) => x.statId === id && typeof x.before === 'number' && typeof x.after === 'number' && x.before > 0); return d ? ((d.after as number) - (d.before as number)) / (d.before as number) : 0; };
      best = Math.max(best, pctOf('FullDPS') || pctOf('CombinedDPS'), pctOf('TotalEHP'));
      // one line and one card for the set: the offers and the lines go by index (offerSpendCards)
      const names = accSet.map((x) => `${buyName(String((x.edits![0] as { itemText?: string }).itemText ?? ''), x.name)} for ${x.slot}, ${shownPrice({ chaos: x.price!.chaos as number, divine: x.price!.divine })}`);
      items.push({ slot: accSet[0]!.slot, name: accSet.map((x) => x.name).join(' and '), shown: `${names.join(' and ')}: the accuracy ${accSet.length > 1 ? 'they give together' : 'it gives'} takes ${rows.slice(0, 2).map((r) => `${r.label} ${r.before} to ${r.after}`).join(', ')}${accuracyLine(t.deltas) ? `; ${accuracyLine(t.deltas)}` : ''}`.slice(0, 600), ...(costs ? { costs } : {}), link: accSet[0]!.link ?? null, chaos: accChaos });
      offers.push({ title: `Buy ${accSet.map((x) => buyName(String((x.edits![0] as { itemText?: string }).itemText ?? ''), x.name)).join(' and ')} for the accuracy`.slice(0, 80), edits });
    }
  }
  for (const c of picks.items) {
    const edit = { kind: 'setItem', slot: c.slot, itemText: c.itemText } as ToolEdit;
    const t = await atLevel([edit]).catch(() => null);
    if (!t) continue;
    const rows = changeRows(pickChanges(t.deltas, 8)).filter((r) => /DPS$|^TotalEHP$|^Life$/.test(r.stat));
    const shown = `${buyName(c.itemText, c.name)} for ${c.slot}, ${shownPrice(c)}: ${rows.slice(0, 3).map((r) => `${r.label} ${r.before} to ${r.after}`).join(', ')}`.slice(0, 190);
    const pctOf = (id: string) => { const d = t.deltas.find((x) => x.statId === id && typeof x.before === 'number' && typeof x.after === 'number' && x.before > 0); return d ? ((d.after as number) - (d.before as number)) / (d.before as number) : 0; };
    best = Math.max(best, pctOf('FullDPS') || pctOf('CombinedDPS'), pctOf('TotalEHP'));
    const costs = costsLine(costRows(t.deltas))?.replace(/^Costs: /, 'It costs ');
    items.push({ slot: c.slot, name: c.name, shown, ...(costs ? { costs } : {}), link: c.link ?? null, chaos: c.chaos });
    offers.push({ title: `Buy ${buyName(c.itemText, c.name)} for ${c.slot}`.slice(0, 80), edits: [edit] });
  }
  if (!items.length) return null;
  const total = items.reduce((a, x) => a + x.chaos, 0) + fixChaos;
  const div = (n: number) => (cpd > 0 ? `${Math.round((n / cpd) * 100) / 100} div (${Math.round(n)}c)` : `${Math.round(n)}c`);
  const extra = [fixChaos > 0 ? `with the ${bought.filter((f) => divinesOf(f.buy!.price) > 0).map((f) => f.buy!.gem).join(' and ')} already in` : '', unpriced.length ? `plus ${unpriced.join(' and ')} (${UNPRICED})` : ''].filter(Boolean).join(', ');
  return { spend: { items, totalShown: `Total ${div(total)} of your ${div(budget)} budget${extra ? `, ${extra}` : ''}`, budgetChaos: budget, weak: best < 0.03, ...(lvl ? { levelNote: `Every buy is compared at your level ${lvl}, not at the file's level` } : {}) }, offers };
}

/** A buy by its base type: a rare "Bone Loop" reads as a ring whatever it is, so the line says "a rare Heavy Belt (\"Bone Loop\")". */
export function buyName(itemText: string, name: string): string {
  const rows = itemText.split(/\r?\n/);
  const rarity = /^Rarity:\s*(\w+)/i.exec(rows[0] ?? '')?.[1]?.toLowerCase();
  const base = (rows[2] ?? '').trim();
  if (!rarity || !base || /^[A-Za-z ]+: /.test(base)) return name;
  return rarity === 'unique' ? `${name} (${base})` : `a ${rarity} ${base} ("${name}")`;
}

/**
 * The buys that spend a stated budget best: the engine's gain per chaos, one item per slot, the total never over the budget.
 * An item that loses damage, has no price or costs more than the whole budget is not a buy.
 */
export function pickBudgetBuys<T extends { slot: string; name: string; chaos: unknown; gain: unknown }>(cands: T[], budgetChaos: number, max = 3): { items: T[]; totalChaos: number } {
  const pct = (x: T) => (x.gain as { percent?: number | null } | null)?.percent ?? 0;
  const cost = (x: T) => (typeof x.chaos === 'number' ? x.chaos : 0);
  const ranked = cands.filter((x) => cost(x) > 0 && cost(x) <= budgetChaos && pct(x) > 0).sort((p, q) => pct(q) / cost(q) - pct(p) / cost(p));
  const items: T[] = [];
  let total = 0;
  for (const x of ranked) {
    if (items.length >= max || items.some((y) => y.slot === x.slot) || total + cost(x) > budgetChaos) continue;
    items.push(x);
    total += cost(x);
  }
  return { items, totalChaos: total };
}

/** Fixes over the five percent cap (fatal or not) are offered, never applied; the others apply. */
export function splitFixes<T extends { deltas: Array<{ statId: string; before: unknown; after: unknown }> }>(fixes: T[]): { apply: T[]; offer: T[] } {
  // a flask suffix swapped on the player's own flask cannot be done in game (a rolled mod): never applied, always a card
  const offer = fixes.filter((f) => dearDeltas(f.deltas) || ROLLED_SWAP.test(String((f as { id?: unknown }).id ?? '')));
  return { apply: fixes.filter((f) => !offer.includes(f)), offer };
}

/** The set of up to `max` items (different slots) with the highest engine DPS: every single, then the pairs of the best singles. */
export async function chooseGear<T extends { slot: string }>(items: T[], dpsOf: (set: T[]) => Promise<number>, max = 2): Promise<{ set: T[]; dps: number }> {
  let best = { set: [] as T[], dps: -Infinity };
  const singles: Array<{ it: T; dps: number }> = [];
  for (const it of items.slice(0, 8)) {
    const dps = await dpsOf([it]);
    singles.push({ it, dps });
    if (dps > best.dps) best = { set: [it], dps };
  }
  if (max >= 2) {
    const top = [...singles].sort((a, b) => b.dps - a.dps).slice(0, 4).map((x) => x.it);
    // an item with the most of what is missing is a better partner than a slightly better single
    const rest = items.filter((x) => !top.includes(x)).slice(0, 2);
    const pool = [...top, ...rest];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (pool[i]!.slot === pool[j]!.slot) continue;
        const dps = await dpsOf([pool[i]!, pool[j]!]);
        if (dps > best.dps) best = { set: [pool[i]!, pool[j]!], dps };
      }
    }
  }
  return best;
}

/** The accuracy bench craft on owned rares with an open suffix: each slot's best real bench roll, alone or two slots together; the engine picks. */
async function craftOption(ctx: ToolContext, buildId: string, xml: string, started: number): Promise<unknown | null> {
  const stats = await statMap(ctx, buildId);
  const stat = typeof stats.FullDPS === 'number' && stats.FullDPS > 0 ? 'FullDPS' : 'CombinedDPS';
  const start = Number(stats[stat] ?? 0);
  const found: Array<{ slot: string; name: string | null; text: string; line: string; value: number }> = [];
  for (const slot of ['Gloves', 'Helmet', 'Amulet', 'Ring 2']) {
    if (Date.now() - started > BUDGET_MS) break;
    const text = slotItemText(xml, slot);
    if (!text) continue;
    const info = (await ctx.engine.send('itemInfo', { itemText: text })).item;
    if (!info.valid) continue;
    const kept: KeptItem = { text, lines: [], lost: [], created: info.rarity !== 'UNIQUE' && info.rarity !== 'RELIC' && !info.corrupted && !info.mirrored, info, oldName: info.name ?? null };
    const r = await benchAccuracy(ctx, buildId, slot, kept, stat, start).catch(() => null);
    if (r) found.push({ slot, name: info.name ?? null, ...r });
  }
  planLog('craft', { found: found.map((f) => [f.slot, f.line, Math.round(f.value - start)]) });
  if (!found.length) return null;
  found.sort((a, b) => b.value - a.value);
  // two crafts together can reach what one cannot: the engine rates the pair
  let set = [found[0]!];
  if (found.length > 1) {
    try {
      const both = [found[0]!, found[1]!];
      const t = await trial(ctx, both.map((f) => ({ kind: 'setItem', slot: f.slot, itemText: f.text }) as ToolEdit));
      const d = t.deltas.find((x) => x.statId === stat);
      if (typeof d?.after === 'number' && d.after > found[0]!.value) set = both;
    } catch { /* one craft */ }
  }
  if (set[0]!.value <= start * 1.02) return null;
  const edits: ToolEdit[] = set.map((f) => ({ kind: 'setItem', slot: f.slot, itemText: f.text }) as ToolEdit);
  const t = await trial(ctx, edits);
  const line = `Bench-craft ${set.map((f) => `${f.line} on your ${f.name ?? f.slot} (${f.slot}, open suffix)`).join(' and ')}`;
  return { id: 'craft:accuracy', fatal: false, deltas: t.deltas, f: { id: 'craft:accuracy', shown: line, fix: '', edits }, changes: changeRows(pickChanges(t.deltas, 6)), costs: costsLine(costRows(t.deltas)) };
}

/** A tree route for the accuracy: applied when it fits the cap, offered when it breaks it for a gain of 15% or more, dropped otherwise. */
export function classifyRoute(r: { changes?: Array<{ stat: string; percent: number | null }>; maxHits?: Array<{ stat: string; percent: number | null }> }, bigLoss: string[]): 'apply' | 'offer' | 'drop' {
  if (bigLoss.some((b) => /suppression/i.test(b))) return 'drop';
  const dear = bigLoss.length > 0 || dearRows(r.changes, r.maxHits);
  if (!dear) return 'apply';
  return dpsGain({ changes: r.changes }) >= 15 ? 'offer' : 'drop';
}

/** Resolves when the newest plan has finished or failed. */
export async function planSettled(): Promise<void> {
  const hit = [...cache.values()].sort((a, b) => b.at - a.at)[0];
  if (hit && Date.now() - hit.at < 120_000) await hit.result.catch(() => undefined);
}

/** The free tree route the plan found (applied or offered), as one line with its engine numbers, or null: the app's answer to "fix my accuracy" leads with it. */
export async function freeRouteLine(): Promise<string | null> {
  const hit = [...cache.values()].sort((a, b) => b.at - a.at)[0];
  if (!hit || Date.now() - hit.at > 120_000) return null;
  const p = (await hit.result) as { routes?: Array<Record<string, unknown>>; offers?: Array<Record<string, unknown>> };
  const r = [...(p.routes ?? []), ...(p.offers ?? []).filter((o) => String(o.id ?? '').startsWith('route:'))][0];
  if (!r) return null;
  const rows = (r.changes as Array<{ stat?: string; label?: string; before?: unknown; after?: unknown }> | undefined) ?? [];
  const dps = rows.find((x) => /DPS$/.test(String(x.stat ?? '')) && x.before !== x.after) ?? rows.find((x) => /DPS$/.test(String(x.stat ?? '')));
  // raw engine numbers (2082972.46) are written the way the sidebar writes them (2.08M)
  const word = (id: string, v: unknown) => (typeof v === 'number' ? formatStat(id, v) : String(v));
  return `${String(r.line ?? `Take ${String(r.node)} on the tree`)}${dps ? `: ${dps.label ?? statMeta(String(dps.stat)).label} ${word(String(dps.stat), dps.before)} to ${word(String(dps.stat), dps.after)}` : ''}, no trade needed`;
}

/** The character level the player says ("I'm level 92"), or null; 100 or more is the file's own level anyway. */
export function askedLevel(text: string): number | null {
  const m = /\b(?:level|lvl)\s*(\d{1,3})\b/i.exec(text) ?? /\b(\d{1,3})\s*(?:level|lvl)\b/i.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 99 ? n : null;
}

/** A change's deltas measured from another starting point (the build at the player's level), not from the open file. */
export function rebaseDeltas<T extends { statId: string; before: unknown; after: unknown }>(deltas: T[], base: Array<{ statId: string; after: unknown }>): T[] {
  return deltas.map((d) => { const b = base.find((x) => x.statId === d.statId); return b ? { ...d, before: b.after } : d; });
}

/**
 * What a buy does to accuracy, in numbers: accuracy and hit chance before and after, and Precise Technique turning on when accuracy
 * passes maximum life (the accuracy pair was the biggest gain and the answer never said why).
 */
export function accuracyLine(deltas: Array<{ statId: string; before: unknown; after: unknown }>): string {
  const get = (id: string) => deltas.find((d) => d.statId === id && typeof d.before === 'number' && typeof d.after === 'number') as { before: number; after: number } | undefined;
  const acc = get('Accuracy');
  if (!acc || acc.after <= acc.before) return '';
  const hit = get('HitChance');
  const life = get('Life');
  const n = (x: number) => Math.round(x).toLocaleString('en-US');
  const on = life && acc.before <= life.before && acc.after > life.after;
  return `accuracy ${n(acc.before)} to ${n(acc.after)}${hit && hit.after !== hit.before ? `, hit chance ${Math.round(hit.before)}% to ${Math.round(hit.after)}%` : ''}${on ? `: above your ${n(life!.after)} life, so Precise Technique turns on (its more damage is in the Combined DPS above)` : ''}`;
}

/** The answer with the first buy's own line in it (after the first line) when it cites the spend result but left that line out. */
export function withFirstBuy(text: string, sp: { id: string; data: unknown } | undefined): string {
  const items = (sp?.data as { spend?: { items?: Array<{ costs?: string }> } } | undefined)?.spend?.items;
  if (!sp || !items?.length || !text.includes(`${sp.id}:`) || text.includes(`${sp.id}:spend.items[0].shown`)) return text;
  const line = `{{${sp.id}:spend.items[0].shown}}${items[0]!.costs ? ` {{${sp.id}:spend.items[0].costs}}.` : ''}`;
  const lines = text.split('\n');
  lines.splice(Math.min(1, lines.length), 0, line);
  return lines.join('\n');
}
