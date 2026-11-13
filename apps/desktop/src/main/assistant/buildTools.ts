// The assistant's tools for everything else a player can do: point budget, path cost, node power, masteries, classes,
// the full config list, build warnings, gem / unique / item mod search, new builds, import and export, and drafts (a
// scratch build the assistant edits freely and evaluates in batches, which ends as one apply/undo card).
import { randomUUID } from 'node:crypto';
import type { BuildEdit, GemInfo, NodePower, StatValue } from '@pom/protocol';
import { z } from 'zod';
import { blankBuildXml, CLASSES } from '../../shared/buildXml.js';
import { skillIdOf } from '../../shared/skillsLogic.js';
import { withSpecClassNames } from '../../renderer/buildSkills.js';
import { APP_TOOLS } from './appTools.js';
import { PATTERN_TOOLS } from './buildPatterns.js';
import { KEPT_TOOLS } from './keptTools.js';
import { KB_TOOLS } from './kbTools.js';
import { countedTattoos, label as tattooLabel, tattooEligible, tattoosFor } from '../../renderer/tree/tattoos.js';
import { encodeBuildCode } from '../library/buildCode.js';
import { importFromText } from '../library/importer.js';
import { fetchRealBuilds, type Stage } from './realBuilds.js';
import type { Proposal } from '../../shared/assistant/types.js';
import type { LibraryListing } from '../../shared/library.js';
import { readBuildMeta, readEquipped, readSkills, xmlHash } from './buildReaders.js';
import { SOLVE_TOOLS } from './solve.js';
import { SLOT_BILL_TOOLS } from './slotBill.js';
import { playerSaysLevel, pointBudget, RANK_TOOLS } from './rankTools.js';
import { PLAN_TOOLS } from './planTools.js';
import { buildWarnings, fixManaShortfall, fixOldShortfalls, fixRequirements } from './playerSense.js';
import { unmetGems } from './gemFit.js';
import { checkChange, isPureQuestion, namedByPlayer } from './gate.js';
import { respecCost } from './wealthPrices.js';
import { DIAGNOSE_TOOLS } from './diagnose.js';
import { auditBuild, auditChange, auditForAnswer, mainCount, withScaledCount } from './audit.js';
import { playerObjections } from './objections.js';
import {
  changeRows,
  deltasOf,
  describeEdit,
  KEY_STATS,
  keyRows,
  EditSchema,
  need,
  parseEdits,
  pickChanges,
  refusal,
  settleAfter,
  specClass,
  statMap,
  toBuildEdit,
  ToolError,
  withScratch,
  xmlOf,
  TOOLS,
  AUDIT_NOTE,
  TREE_KINDS,
  ASSUMPTION_KINDS,
  askFor,
  honestStats,
  refusalNotes,
  socketMisfits,
  validGuard,
  tipText,
  uniqueText,
  type AssistantEngine,
  type Scalar,
  type ToolContext,
  type ToolDef,
  type ToolEdit,
} from './tools.js';

// ---- drafts -------------------------------------------------------------------------------------------------

export interface Draft {
  id: string;
  /** The engine session the draft lives in. */
  buildId: string;
  name: string;
  from: 'open' | 'new' | 'import';
  /** For a copy of the open build: which build and which text it started from (a proposal must match both). */
  baseKey: string | null;
  baseHash: string | null;
  startStats: Record<string, Scalar>;
  startAllocated: number[];
  /** One plain line per edit made, for the card. */
  lines: string[];
  kinds: Set<string>;
  /** Opened from a solve row assessed "not ready" (openSolveDraft): proposeDraft applies it only once checkBuild's blocking lines are gone. */
  notReady?: string;
}

/** What still makes a draft not ready, as checkBuild reads it: blocking player checks (5, 6, 17), a blocking check that could not run, the audit's fatal findings. */
async function notReadyLeft(ctx: ToolContext, buildId: string): Promise<string[]> {
  const xml = await xmlOf(ctx, buildId);
  const o = await playerObjections(ctx, buildId, xml);
  const fatal = await auditBuild(ctx, buildId, xml).then((a) => a.findings.filter((f) => f.fatal).map((f) => f.shown), () => ['the build audit could not run']);
  const unrun = o.failed.filter((n) => n === 5 || n === 6 || n === 17).map((n) => `player check ${n} could not run`);
  return [...o.found.filter((x) => x.blocks).map((x) => x.text), ...fatal, ...unrun];
}

/** Drafts live in engine sessions; only the newest few are kept (each one holds a calculated build in memory). */
export class DraftStore {
  private readonly items = new Map<string, Draft>();

  constructor(
    private readonly engine: AssistantEngine,
    private readonly max = 4,
  ) {}

  get(id: string): Draft | undefined {
    return this.items.get(id);
  }

  async create(xml: string, info: Pick<Draft, 'name' | 'from' | 'baseKey' | 'baseHash'>, startStats?: Record<string, Scalar>): Promise<Draft> {
    const { buildId } = await this.engine.send('loadBuild', { buildXml: xml });
    const stats = startStats ?? Object.fromEntries((await this.engine.send('getStats', { buildId })).stats.filter((s: StatValue) => s.value === null || typeof s.value !== 'object').map((s: StatValue) => [s.id, s.value as Scalar]));
    const { tree } = await this.engine.send('treeState', { buildId });
    const d: Draft = { ...info, id: randomUUID().slice(0, 8), buildId, startStats: stats, startAllocated: tree.allocated, lines: [], kinds: new Set() };
    this.items.set(d.id, d);
    while (this.items.size > this.max) {
      const [oldest] = this.items.values();
      this.items.delete(oldest!.id);
      await this.engine.send('closeBuild', { buildId: oldest!.buildId }).catch(() => undefined);
    }
    return d;
  }

  async closeAll(): Promise<void> {
    for (const d of this.items.values()) await this.engine.send('closeBuild', { buildId: d.buildId }).catch(() => undefined);
    this.items.clear();
  }
}

/** The library, for saving a draft as a new build (main process only). */
export interface LibraryAccess {
  save(name: string, xml: string): Promise<{ id: string; name: string }>;
  list(): Promise<LibraryListing>;
  read(id: string): Promise<{ id: string; name: string; xml: string }>;
  rename(id: string, name: string): Promise<{ id: string; name: string; folder: string }>;
  move(id: string, folder: string): Promise<{ id: string; name: string; folder: string }>;
  /** To Recently deleted. */
  remove(id: string): Promise<{ name: string; folder: string }>;
}

function drafts(ctx: ToolContext): DraftStore {
  if (!ctx.drafts) throw new ToolError('Drafts are not available here.');
  return ctx.drafts;
}

function draftOf(ctx: ToolContext, id: unknown): Draft {
  const d = typeof id === 'string' ? drafts(ctx).get(id) : undefined;
  if (!d) throw new ToolError(`There is no draft "${String(id)}". Drafts last until the app restarts and only the newest few are kept; start a new one.`);
  return d;
}

const DRAFT_ARG = z.string().max(20).optional().describe('Work on a draft (from startDraft, newBuild or importBuild) instead of the open build.');

// ---- helpers ------------------------------------------------------------------------------------------------

/** The build text as the app saves it: `<Build className ascendClassName>` in line with the active tree. */
async function savedXml(ctx: ToolContext, buildId: string): Promise<string> {
  const xml = await xmlOf(ctx, buildId);
  const { classes } = await ctx.tree.classes((await ctx.engine.send('treeState', { buildId })).tree.treeVersion).catch(() => ({ classes: [] }));
  return withSpecClassNames(xml, Object.fromEntries(classes.map((c) => [c.classId, { name: c.name, asc: c.ascendancies.map((a) => [a.ascendClassId, a.name] as [number, string]) }])));
}

const fullDps = (s: Record<string, Scalar>) => typeof s.FullDPS === 'number' && s.FullDPS > 0;

/** The game names of what a draft sets against the open build: nodes it adds (not the path to them), items it equips, gems it adds. */
async function draftThings(ctx: ToolContext, openXml: string, xml: string, version: string, addedIds: number[]): Promise<string[][]> {
  const nodes = (await ctx.tree.nodes(version, addedIds)).filter((n) => n.type !== 'Normal').map((n) => [n.name]);
  const was = new Map(readEquipped(openXml).map((i) => [i.slot, i.text]));
  // a unique by its name only: "the best Leather Belt" names a base, not the unique the assistant picked on it
  const items = readEquipped(xml).filter((i) => was.get(i.slot) !== i.text).map((i) => (/^unique$/i.test(i.rarity) ? [i.name] : [i.name, i.base]));
  const had = new Set(readSkills(openXml).flatMap((g) => g.gems.map((x) => x.name)));
  const gems = [...new Set(readSkills(xml).flatMap((g) => g.gems.map((x) => x.name)))].filter((n) => n && !had.has(n)).map((n) => [n]);
  return [...nodes, ...items, ...gems];
}

/** Undoes everything after history depth `depth`. */
async function undoTo(ctx: ToolContext, buildId: string, depth: number): Promise<void> {
  const now = await ctx.engine.send('history', { buildId });
  for (let i = now.undo; i > depth; i--) await ctx.engine.send('undo', { buildId });
}

const words = (q: unknown) => (typeof q === 'string' ? q.toLowerCase().split(/\s+/).filter(Boolean) : []);
const hasAll = (hay: string, ws: string[]) => ws.every((w) => hay.includes(w));
const COLOUR = /\^x[0-9A-Fa-f]{6}|\^\d/g;
const plain = (s: string | undefined) => (s ?? '').replace(COLOUR, '');

/** Every `{ lines: string[] }` entry of an item pool, whatever its nesting (the pools differ per kind). */
function poolEntries(pool: unknown, out: Array<Record<string, unknown>> = [], where: string[] = []): Array<Record<string, unknown>> {
  if (Array.isArray(pool)) for (const x of pool) poolEntries(x, out, where);
  else if (pool && typeof pool === 'object') {
    const o = pool as Record<string, unknown>;
    if (Array.isArray(o.lines) && o.lines.every((l) => typeof l === 'string')) out.push({ ...o, ...(where.length ? { group: where.join(' / ') } : {}) });
    // anoints: passive notables with their stats and the oils that make them
    else if (typeof o.name === 'string' && Array.isArray(o.stats) && o.stats.every((l) => typeof l === 'string')) out.push({ ...o, lines: o.stats });
    // cluster jewels: the skills a cluster jewel can have, with the enchant lines that make them
    else if (typeof o.name === 'string' && Array.isArray(o.enchant) && o.enchant.every((l) => typeof l === 'string')) out.push({ ...o, lines: o.enchant });
    // foulborn: each unique mod that can mutate, with the line it becomes
    else if (typeof o.newModId === 'string' && Array.isArray(o.replace) && o.replace.every((l) => typeof l === 'string')) out.push({ id: o.newModId, replaces: o.modId, lines: o.replace });
    else for (const [k, v] of Object.entries(o)) poolEntries(v, out, typeof o.label === 'string' && k === 'mods' ? [...where, o.label] : typeof o.type === 'string' && k === 'groups' ? [...where, o.type] : where);
  }
  return out;
}

// ---- tools --------------------------------------------------------------------------------------------------

/** The first asked stat the build has a non-zero value for: Full DPS is 0 for most builds, and a tie on zero ranks nothing. */
export function rankStat(ids: string[], baseline: Record<string, Scalar>): string {
  return ids.find((id) => typeof baseline[id] === 'number' && baseline[id] !== 0) ?? ids[0]!;
}

export const PARITY_TOOLS: ToolDef[] = [
  {
    name: 'listClasses',
    chip: 'Read classes',
    description: 'The classes, their ascendancies and the bloodlines (secondary ascendancies) of the build\'s tree version, with the ids setClass takes.',
    shape: { draftId: DRAFT_ARG },
    async run(args, ctx) {
      const b = need(ctx, args);
      const version = (await ctx.engine.send('treeState', { buildId: b.buildId })).tree.treeVersion;
      const { classes, bloodlines } = await ctx.tree.classes(version);
      return { treeVersion: version, classes: classes.length ? classes : CLASSES.map((c) => ({ classId: c.classId, name: c.name, ascendancies: c.ascendancies.map((a, i) => ({ ascendClassId: i + 1, name: a })) })), bloodlines };
    },
  },
  {
    name: 'getPointBudget',
    chip: 'Count points',
    description: 'Passive and ascendancy points used, available and left (passive: 99 from levels + 23 from quests + extra points from the build), the character level, and the level the points spent call for.',
    shape: { draftId: DRAFT_ARG },
    async run(args, ctx) {
      const b = await pointBudget(ctx, need(ctx, args).buildId);
      // "I have 5 unspent points" at 118 of 118 was answered with "raise the build's level" instead of doing it
      return b.passive.left > 0 ? b : { ...b, note: 'No free points in the build. When the player says their character is a higher level than the build shows (it levelled up), call spendPoints with raiseLevel true and points set to the points they have: it raises the build level (up to 100) and spends them in one Undo step. A plain count of free points never changes the level: spendPoints spends the free points the build shows and tells you the difference.' };
    },
  },
  {
    name: 'pathCost',
    chip: 'Check paths',
    description:
      'For each passive node: what clicking it would do on the tree (allocate with its path, or remove it and what hangs off it), the nodes on the path, the passive and ascendancy points it costs, and why the engine would refuse it. For a mastery, lists its effects and the effect ids pickMastery takes. Calculated on a scratch copy.',
    shape: { nodeIds: z.array(z.number().int().min(0)).min(1).max(20), draftId: DRAFT_ARG },
    async run(args, ctx) {
      const b = need(ctx, args);
      const xml = await xmlOf(ctx, b.buildId);
      const ids = args.nodeIds as number[];
      return await withScratch(ctx, xml, async (scratch) => {
        const { tree } = await ctx.engine.send('treeState', { buildId: scratch });
        const version = tree.treeVersion;
        const all = await ctx.tree.all(version);
        const start = new Set(tree.allocated);
        const depth = (await ctx.engine.send('history', { buildId: scratch })).undo;
        const cost = (added: number[]) => {
          let passive = 0;
          let ascendancy = 0;
          for (const id of added) {
            const n = all.get(id);
            if (n && (n.type === 'ClassStart' || n.type === 'AscendClassStart' || n.ascendancyStart)) continue;
            if (n?.ascendancy) {
              if (!n.multipleChoiceOption) ascendancy++;
            } else passive++;
          }
          return { passive, ascendancy };
        };
        const named = (list: number[]) => list.slice(0, 40).map((id) => ({ id, name: all.get(id)?.name ?? `Node ${id}`, type: all.get(id)?.type ?? 'Normal' }));
        const out = [];
        for (const id of ids) {
          const n = all.get(id);
          const row: Record<string, unknown> = { nodeId: id, name: n?.name ?? null, type: n?.type ?? null, allocated: start.has(id), ...(n?.ascendancy ? { ascendancy: n.ascendancy } : {}) };
          if (!n) {
            out.push({ ...row, refused: 'there is no such node on this tree' });
            continue;
          }
          if (n.effects) {
            const picked = tree.masteries.find(([m]) => m === id)?.[1];
            row.masteryEffects = n.effects.map((e) => ({ effectId: e.id, stats: e.stats, ...(e.id === picked ? { picked: true } : {}) }));
          }
          let edit: BuildEdit = { kind: 'clickNode', nodeId: id };
          let r = await ctx.engine.send('edit', { buildId: scratch, edit });
          if (r.blocked === 'PickMastery' && n.effects?.length) {
            edit = { kind: 'pickMastery', nodeId: id, effectId: n.effects[0]!.id };
            r = await ctx.engine.send('edit', { buildId: scratch, edit });
            row.note = 'A mastery is allocated by picking an effect: send pickMastery with one of the effect ids.';
          }
          if (r.blocked) {
            out.push({ ...row, refused: refusal(r.blocked) });
            continue;
          }
          const after = (await ctx.engine.send('treeState', { buildId: scratch })).tree.allocated;
          const now = new Set(after);
          const added = after.filter((x) => !start.has(x));
          const removed = [...start].filter((x) => !now.has(x));
          out.push({ ...row, action: removed.length && !added.length ? 'remove' : 'allocate', cost: cost(added), path: named(added), removes: named(removed), refunds: cost(removed) });
          await undoTo(ctx, scratch, depth);
        }
        return { untrustedData: true, nodes: out, note: 'Nothing was changed. Use clickNode (or pickMastery for a mastery) in proposeEdit or editDraft to do it.' };
      });
    },
  },
  {
    name: 'listTattoos',
    chip: 'List tattoos',
    description:
      'The tattoos that fit a passive node (only attribute nodes, +30 attribute notables, keystones, a node that already has one and masteries that are not allocated take one; those take runegrafts): their keys and modifier lines, the current tattoo of the node, and the tattoo count of the tree (upstream shows it out of 50). Nothing is changed. Use setTattoo with a key in proposeEdit or editDraft to add one (tattoo null takes it off), or resetTattoos for all of them.',
    shape: { nodeId: z.number().int().min(0), showLegacy: z.boolean().optional().describe('Include the legacy tattoos upstream hides by default.'), draftId: DRAFT_ARG },
    async run(args, ctx) {
      const b = need(ctx, args);
      const { tree } = await ctx.engine.send('treeState', { buildId: b.buildId });
      const id = args.nodeId as number;
      const n = await ctx.tree.node(tree.treeVersion, id);
      const count = countedTattoos(tree.changed).length;
      const current = tree.changed.find((c) => c.id === id && (c.tattoo || c.isTattoo));
      if (!n) return { nodeId: id, refused: 'there is no such node on this tree', tattooCount: count, limit: 50 };
      const target = { name: n.name, type: n.type, firstStat: n.stats[0] ?? '', linked: n.linked ?? 0 };
      const eligible = tattooEligible({ ...target, tattooed: !!current, unallocatedMastery: !!n.effects && !tree.allocated.includes(id) });
      const list = eligible ? tattoosFor(await ctx.tree.tattoos(tree.treeVersion), target, args.showLegacy === true) : [];
      return {
        nodeId: id,
        name: n.name,
        type: n.type,
        eligible,
        ...(eligible ? {} : { why: 'only attribute nodes, +30 attribute notables, keystones, a node with a tattoo and masteries that are not allocated take a tattoo' }),
        current: current ? { name: current.name, stats: current.stats } : null,
        tattooCount: count,
        limit: 50,
        tattoos: list.map((t) => ({ key: t.key, label: tattooLabel(t), stats: t.sd, ...(t.legacy ? { legacy: true } : {}) })),
        note: 'Nothing was changed. Send { kind: "setTattoo", nodeId, tattoo: <key> } in proposeEdit or editDraft.',
      };
    },
  },
  {
    name: 'rankNodes',
    chip: 'Rank passives',
    description:
      'Node Power: every unallocated passive within reach, calculated by the engine, ranked by damage (FullDPS, or CombinedDPS when the build has no FullDPS) and by effective hit pool (TotalEHP) gained per point spent on its whole path. Optionally rank by any other stat (Life, Armour, ...). Takes a while on big trees; maxDepth limits how far from the tree to look.',
    shape: {
      by: z.enum(['dps', 'ehp', 'both']).optional(),
      stat: z.string().max(40).optional().describe('Rank by this stat id instead (for example "Life", "Armour", "BleedDPS").'),
      maxDepth: z.number().int().min(1).max(30).optional().describe('Path steps from the allocated tree (default 6).'),
      limit: z.number().int().min(1).max(40).optional(),
      draftId: DRAFT_ARG,
    },
    async run(args, ctx) {
      const b = need(ctx, args);
      const xml = await xmlOf(ctx, b.buildId);
      const stats = await statMap(ctx, b.buildId);
      const by = args.by === 'dps' || args.by === 'ehp' ? args.by : 'both';
      const runs: Array<{ key: string; stat: string }> = [];
      if (typeof args.stat === 'string') runs.push({ key: args.stat, stat: args.stat });
      else {
        if (by !== 'ehp') runs.push({ key: 'dps', stat: fullDps(stats) ? 'FullDPS' : 'CombinedDPS' });
        if (by !== 'dps') runs.push({ key: 'ehp', stat: 'TotalEHP' });
      }
      const limit = typeof args.limit === 'number' ? args.limit : 15;
      const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 6;
      return await withScratch(ctx, xml, async (scratch) => {
        const version = (await ctx.engine.send('treeState', { buildId: scratch })).tree.treeVersion;
        const all = await ctx.tree.all(version);
        const result: Record<string, unknown> = { untrustedData: true, maxDepth };
        for (const run of runs) {
          await ctx.engine.send('nodePowerStart', { buildId: scratch, maxDepth, stat: run.stat });
          const nodes = new Map<number, NodePower>();
          const deadline = Date.now() + 90_000;
          let done = false;
          while (!done && Date.now() < deadline) {
            const step = await ctx.engine.send('nodePowerStep', { buildId: scratch, budgetMs: 400 });
            for (const n of step.nodes) if (!n.allocated) nodes.set(n.id, n);
            done = step.done || !step.active;
          }
          const base = typeof stats[run.stat] === 'number' ? (stats[run.stat] as number) : null;
          const ranked = [...nodes.values()]
            .filter((n) => n.pathPower !== null && n.dist > 0)
            .map((n) => {
              const node = all.get(n.id);
              const best = n.effects?.length ? n.effects.reduce((a, e) => ((e.pathPower ?? -Infinity) > (a.pathPower ?? -Infinity) ? e : a)) : null;
              return {
                id: n.id,
                name: node?.name ?? `Node ${n.id}`,
                type: node?.type ?? 'Normal',
                points: n.dist,
                gain: Math.round((n.pathPower ?? 0) * 100) / 100,
                perPoint: Math.round(((n.pathPower ?? 0) / n.dist) * 100) / 100,
                ...(base ? { percentPerPoint: Math.round(((n.pathPower ?? 0) / n.dist / Math.abs(base)) * 10000) / 100 } : {}),
                ...(best ? { bestEffectId: best.e } : {}),
              };
            })
            .sort((a, b) => b.perPoint - a.perPoint);
          result[run.key] = { stat: run.stat, now: base, finished: done, checked: nodes.size, top: ranked.slice(0, limit) };
        }
        result.note = 'gain is the stat change for allocating the node with its whole path; perPoint divides it by the points the path costs. Use clickNode (pickMastery with bestEffectId for a mastery) to take one.';
        return result;
      });
    },
  },
  {
    name: 'getConfigOptions',
    chip: 'Read config options',
    description:
      'The Configuration tab in full: every option with its var (the key setConfig takes), label, type, current value, default, the choices of a list, whether it is shown for this build (skill-specific options show only when the skill is used), plus the config sets and custom modifiers. Filter by words or section; hidden options are left out unless asked.',
    shape: {
      search: z.string().max(60).optional(),
      section: z.string().max(60).optional(),
      includeHidden: z.boolean().optional(),
      changedOnly: z.boolean().optional(),
      draftId: DRAFT_ARG,
    },
    async run(args, ctx) {
      const b = need(ctx, args);
      const [{ catalog }, { state }] = await Promise.all([ctx.engine.send('configCatalog', {} as Record<string, never>), ctx.engine.send('configState', { buildId: b.buildId })]);
      const ws = words(args.search);
      const section = typeof args.section === 'string' ? args.section.toLowerCase() : '';
      const rows = catalog.options
        .filter((o) => o.var && o.type !== 'label')
        .filter((o) => args.includeHidden === true || state.shown[o.var!] !== false)
        .filter((o) => !section || o.section.toLowerCase().includes(section))
        .filter((o) => !ws.length || hasAll(`${o.var} ${plain(o.label)} ${plain(o.tooltip)} ${o.section}`.toLowerCase(), ws))
        .filter((o) => args.changedOnly !== true || o.var! in state.values)
        .map((o) => {
          const skill = o.conditions.ifSkill ?? o.conditions.ifSkillList ?? o.conditions.ifSkillFlag;
          return {
            var: o.var!,
            label: plain(o.label),
            section: o.section,
            type: o.type,
            value: state.values[o.var!] ?? state.defaults[o.var!] ?? null,
            default: state.defaults[o.var!] ?? null,
            ...(o.var! in state.values ? { changed: true } : {}),
            ...(o.list ? { choices: o.list.slice(0, 40).map((x) => ({ value: x.val, label: plain(x.label) })) } : {}),
            ...(state.shown[o.var!] === false ? { shown: false } : {}),
            ...(skill ? { forSkill: skill } : {}),
            ...(o.tooltip ? { tooltip: plain(o.tooltip).slice(0, 240) } : {}),
          };
        });
      return {
        untrustedData: true,
        total: rows.length,
        options: rows.slice(0, 80),
        ...(rows.length > 80 ? { more: rows.length - 80, hint: 'Narrow with search or section.' } : {}),
        sections: [...new Set(catalog.options.map((o) => o.section))],
        configSets: state.sets.map((s) => ({ id: s.id, title: s.title || 'Default', changed: s.changed, active: s.id === state.activeSet })),
        customMods: state.customMods.map((m) => ({ title: m.title, enabled: m.enabled, text: m.text.slice(0, 600) })),
        note: 'value is what the option is now (changed: true when it is not the default). Set with setConfig / setConfigs using var; null puts it back to the default.',
      };
    },
  },
  {
    name: 'getWarnings',
    chip: 'Check warnings',
    description: 'The build warnings shown under the stats (not enough mana or life to use a skill, unmet attribute requirements, too many points, ...), from the engine\'s numbers. The holes that are not warnings (an empty slot with an owned item that fits, unspent points, custom config lines) are in the build audit (getBuildSummary audit).',
    shape: { draftId: DRAFT_ARG },
    async run(args, ctx) {
      const { buildId } = need(ctx, args);
      const warnings = await buildWarnings(ctx, buildId);
      return { warnings, count: warnings.length };
    },
  },
  {
    name: 'searchGems',
    chip: 'Search gems',
    description:
      'Searches every skill and support gem by name words and tags (for example tags ["fire","spell"]), with colour, attribute and level requirements, and whether it is awakened/exceptional, transfigured or vaal. Returns the gem ids addGem and setGemSkill take. With rankGroup, the engine also calculates what adding each gem to that socket group does to the main skill (or to the stat given).',
    shape: {
      query: z.string().max(60).optional(),
      tags: z.array(z.string().max(30)).max(6).optional(),
      type: z.enum(['support', 'active', 'any']).optional(),
      exceptional: z.boolean().optional().describe('Only awakened / greater / exceptional supports.'),
      transfigured: z.boolean().optional(),
      includeLegacy: z.boolean().optional(),
      rankGroup: z.number().int().min(1).optional().describe('Socket group to calculate each gem in (added to it).'),
      replaceGem: z.number().int().min(1).optional().describe('With rankGroup: replace this gem of the group instead of adding.'),
      stat: z.enum(['FullDPS', 'CombinedDPS', 'TotalDPS', 'AverageDamage', 'TotalDot', 'BleedDPS', 'IgniteDPS', 'TotalPoisonDPS', 'TotalEHP']).optional(),
      limit: z.number().int().min(1).max(40).optional(),
      tooltipLevel: z.number().int().min(1).max(40).optional().describe('Adds the gem tooltip at this gem level (as the Skills tab shows it on hover) to the first 5 gems.'),
      draftId: DRAFT_ARG,
    },
    async run(args, ctx) {
      const { gems } = await ctx.engine.send('gemCatalog', {} as Record<string, never>);
      const ws = words(args.query);
      const tags = (Array.isArray(args.tags) ? (args.tags as string[]) : []).map((t) => t.toLowerCase());
      const hits = gems.filter(
        (g: GemInfo) =>
          (args.includeLegacy === true || !g.legacy) &&
          (args.type === 'support' ? g.support : args.type === 'active' ? !g.support : true) &&
          (args.exceptional === undefined || g.exceptional === args.exceptional) &&
          (args.transfigured === undefined || !!g.transfiguredOf === args.transfigured) &&
          hasAll(g.name.toLowerCase(), ws) &&
          tags.every((t) => g.tags.some((x) => x.toLowerCase() === t)),
      );
      const limit = typeof args.limit === 'number' ? args.limit : 25;
      let list = hits.slice(0, typeof args.rankGroup === 'number' ? 120 : limit);
      const power: Record<string, number | null> = {};
      let base: number | null = null;
      const field = typeof args.stat === 'string' ? args.stat : 'FullDPS';
      if (typeof args.rankGroup === 'number' && list.length) {
        const b = need(ctx, args);
        for (let i = 0; i < list.length; i += 20) {
          const r = await ctx.engine.send('gemPower', { buildId: b.buildId, group: args.rankGroup, field, gemIds: list.slice(i, i + 20).map((g) => g.id), ...(typeof args.replaceGem === 'number' ? { gem: args.replaceGem } : {}) });
          Object.assign(power, r.power);
          base = r.base;
        }
        list = [...list].sort((a, b) => (power[b.id] ?? -Infinity) - (power[a.id] ?? -Infinity)).slice(0, limit);
      }
      const tips = new Map<string, string[]>();
      if (typeof args.tooltipLevel === 'number') {
        const level = args.tooltipLevel;
        const buildId = ctx.open()?.buildId ?? null;
        for (const g of list.slice(0, 5)) {
          const tip = await ctx.engine.send('gemTip', { buildId, skillId: skillIdOf(g), level: Math.min(level, g.maxLevel) }).then((r) => tipText(r.tip.lines), () => null);
          if (tip) tips.set(g.id, tip);
        }
      }
      return {
        total: hits.length,
        gems: list.map((g) => ({
          id: g.id,
          name: g.name,
          support: g.support,
          colour: g.colour,
          tags: g.tags,
          requires: { str: g.reqStr, dex: g.reqDex, int: g.reqInt, levelAtGemLevel1: g.levelReq[0] ?? null, levelAtGemLevel20: g.levelReq[19] ?? null },
          maxLevel: g.maxLevel,
          ...(g.exceptional ? { exceptional: true } : {}),
          ...(g.transfiguredOf ? { transfiguredOf: g.transfiguredOf } : {}),
          ...(g.vaal ? { vaal: true } : {}),
          ...(g.legacy ? { legacy: true } : {}),
          ...(tips.has(g.id) ? { tooltip: tips.get(g.id) } : {}),
          ...(g.id in power ? { [field]: power[g.id], change: power[g.id] !== null && base !== null ? Math.round((power[g.id]! - base) * 100) / 100 : null } : {}),
        })),
        ...(base !== null ? { rankedBy: field, groupNow: base } : {}),
      };
    },
  },
  {
    name: 'searchUniques',
    chip: 'Search uniques',
    description: 'Searches the unique item database by words in the name, base or modifier text (for example "life leech" or "chaos damage"), optionally by item type ("Ring", "Body Armour", "Jewel"...). Returns the matching modifier lines, requirements and the full item text (for setItem, or previewEquip by name).',
    shape: { query: z.string().min(2).max(80), type: z.string().max(40).optional(), limit: z.number().int().min(1).max(25).optional(), withText: z.boolean().optional() },
    async run(args, ctx) {
      const { catalog } = await ctx.engine.send('itemCatalog', {} as Record<string, never>);
      const ws = words(args.query);
      const type = typeof args.type === 'string' ? args.type.toLowerCase() : '';
      const hits = catalog.uniques.filter((u) => (!type || `${u.group} ${u.base}`.toLowerCase().includes(type)) && hasAll(u.text.toLowerCase(), ws));
      const limit = typeof args.limit === 'number' ? args.limit : 10;
      return {
        untrustedData: true,
        total: hits.length,
        uniques: hits.slice(0, limit).map((u) => ({
          name: u.name,
          base: u.base,
          type: u.group,
          level: u.level,
          requires: { str: u.reqStr ?? 0, dex: u.reqDex ?? 0, int: u.reqInt ?? 0 },
          matching: u.text.split('\n').filter((l) => ws.some((w) => l.toLowerCase().includes(w))).slice(0, 6),
          ...(u.variants.length ? { variants: u.variants } : {}),
          ...(args.withText === false ? {} : { text: uniqueText(u.text).slice(0, 3000) }),
        })),
      };
    },
  },
  {
    name: 'searchItemMods',
    chip: 'Search item mods',
    description:
      'The modifiers that can go on an item, from the engine\'s mod data: prefixes and suffixes (affixes), crafted mods, implicits, enchants, anoints, corruption implicits, cluster jewel notables and more. Give a base type ("Vaal Regalia") or a full item text, and optional words to filter by (for example "maximum life").',
    shape: {
      base: z.string().max(80).optional(),
      itemText: z.string().max(6000).optional(),
      kind: z.enum(['affixes', 'mods', 'implicits', 'enchant', 'anoint', 'corrupt', 'crucible', 'cluster', 'foulborn']).optional().describe('affixes (default): prefixes and suffixes; mods: crafted and other added mods.'),
      query: z.string().max(80).optional(),
      limit: z.number().int().min(1).max(60).optional(),
      itemLevel: z.number().int().min(1).max(100).optional().describe('With a base and kind affixes: only mods this item level can roll (default 84).'),
      influences: z.array(z.enum(['shaper', 'elder', 'crusader', 'redeemer', 'hunter', 'warlord'])).max(2).optional(),
    },
    async run(args, ctx) {
      // A base with the default kind: the engine's per-base pool, with tiers (1 = best), item level, weight and source.
      if (typeof args.base === 'string' && !args.itemText && (args.kind === undefined || args.kind === 'affixes')) {
        const itemLevel = typeof args.itemLevel === 'number' ? args.itemLevel : 84;
        const influences = Array.isArray(args.influences) ? (args.influences as string[]) : [];
        const pool = await ctx.engine.send('modPool', { base: args.base, itemLevel, influences }).then(
          (r) => r.pool,
          (e: unknown) => {
            // An engine built before modPool answers below from the item editor's lists instead.
            if (e instanceof Error && /no mod pools/.test(e.message)) return null;
            throw e;
          },
        );
        if (pool) {
          const ws = words(args.query);
          const all = [...pool.prefixes, ...pool.suffixes].filter((m) => !ws.length || hasAll(m.stats.map((l) => l.text).join(' ').toLowerCase(), ws));
          // Natural rolls first, then essence, bench, veiled and delve.
          const crafted = (m: (typeof all)[number]) => (['normal', 'influence', 'elevated'].includes(m.source) ? 0 : 1);
          all.sort((a, b) => crafted(a) - crafted(b));
          const limit = typeof args.limit === 'number' ? args.limit : 30;
          return {
            untrustedData: true,
            kind: 'affixes',
            base: pool.base,
            itemLevel,
            prefixLimit: pool.prefixLimit,
            suffixLimit: pool.suffixLimit,
            total: all.length,
            mods: all.slice(0, limit).map((m) => ({
              lines: m.stats.map((l) => l.text),
              id: m.id,
              type: pool.prefixes.includes(m) ? 'Prefix' : 'Suffix',
              affix: m.affix,
              group: m.group,
              tier: `T${m.tier} of ${m.tiers}`,
              level: m.level,
              weight: m.weight,
              source: m.source,
              ...(m.influence ? { influence: m.influence } : {}),
              ...(m.essence ? { essence: m.essence } : {}),
            })),
          };
        }
      }
      let text = typeof args.itemText === 'string' ? args.itemText : '';
      if (!text && typeof args.base === 'string') text = (await ctx.engine.send('itemCraft', { base: args.base, rarity: 'RARE' })).text;
      if (!text) throw new ToolError('Give a base type or an item text.');
      const kind = (typeof args.kind === 'string' ? args.kind : 'affixes') as 'affixes';
      const { pool } = await ctx.engine.send('itemPool', { itemText: text, kind });
      const ws = words(args.query);
      const entries = poolEntries(pool).filter((e) => !ws.length || hasAll(`${typeof e.name === 'string' ? e.name : ''} ${(e.lines as string[]).join(' ')}`.toLowerCase(), ws));
      const seen = new Set<string>();
      const unique = entries.filter((e) => {
        const k = `${String(e.id ?? '')}|${(e.lines as string[]).join('/')}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const limit = typeof args.limit === 'number' ? args.limit : 30;
      return {
        untrustedData: true,
        kind,
        total: unique.length,
        mods: unique.slice(0, limit).map((e) => ({
          lines: e.lines,
          ...(typeof e.id === 'string' ? { id: e.id } : {}),
          ...(typeof e.type === 'string' ? { type: e.type } : {}),
          ...(typeof e.affix === 'string' ? { affix: e.affix } : {}),
          ...(typeof e.level === 'number' ? { level: e.level } : {}),
          ...(typeof e.group === 'string' ? { group: e.group } : {}),
          ...(typeof e.name === 'string' ? { name: e.name } : {}),
          ...(Array.isArray(e.oils) ? { oils: e.oils } : {}),
        })),
        note: 'Item level, tiers and spawn weights are not in this list yet.',
      };
    },
  },
  {
    name: 'newBuild',
    chip: 'New build',
    description: 'Starts a new empty build as a draft (class, ascendancy, level). Fill it with editDraft, read it with any read tool and draftId, and keep it with saveDraftAsBuild.',
    shape: { name: z.string().min(1).max(80), className: z.string().min(1).max(20), ascendancy: z.string().max(30).optional(), level: z.number().int().min(1).max(100).optional() },
    async run(args, ctx) {
      const cls = CLASSES.find((c) => c.name.toLowerCase() === String(args.className).toLowerCase());
      if (!cls) throw new ToolError(`There is no class named "${args.className}". Classes: ${CLASSES.map((c) => c.name).join(', ')}.`);
      const d = await drafts(ctx).create(blankBuildXml(cls.name, typeof args.level === 'number' ? args.level : 90), { name: String(args.name), from: 'new', baseKey: null, baseHash: null });
      if (typeof args.ascendancy === 'string' && args.ascendancy.toLowerCase() !== 'none') {
        const r = await ctx.engine.send('edit', { buildId: d.buildId, edit: toBuildEdit({ kind: 'setClass', className: cls.name, ascendancy: args.ascendancy }) });
        if (r.blocked) throw new ToolError(`The engine refused the ascendancy: ${refusal(r.blocked)}.`);
      }
      return { draftId: d.id, name: d.name, ...(await specClass(ctx, d.buildId).then((c) => ({ class: c.className, ascendancy: c.ascendancy }))), note: 'A draft, not saved: it is not in the library until saveDraftAsBuild.' };
    },
  },
  {
    name: 'importBuild',
    chip: 'Import build',
    description: 'Imports a Path of Building code or a build link (pobb.in, poe.ninja, pastebin, ...) as a draft, to read, compare and edit. Nothing is saved until saveDraftAsBuild.',
    shape: { code: z.string().min(8).max(200000), name: z.string().max(80).optional() },
    async run(args, ctx) {
      let got;
      try {
        got = await importFromText(String(args.code));
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      }
      const d = await drafts(ctx).create(got.xml, { name: typeof args.name === 'string' ? args.name : got.name, from: 'import', baseKey: null, baseHash: null });
      const meta = readBuildMeta(got.xml);
      return { draftId: d.id, name: d.name, class: meta.className, ascendancy: meta.ascendClassName || null, level: meta.level, mainSkill: meta.mainSkill || null };
    },
  },
  {
    name: 'realBuilds',
    chip: 'Find real builds',
    description:
      "Real characters of one skill from poe.ninja's builds for the current league, at a stage: league-start (day-3 snapshot), week-1, or mid (now). Each comes back already imported as a scratch draft (draftId) from its build code at that snapshot, with its name, level, ascendancy, life and poe.ninja's own EHP and DPS text. poe.ninja's DPS is the player's own config (buffs on), a way to pick whom to read, never the bar: score them with the draft read tools and draftId, the numbers that count are the engine's. Takes a few seconds per character.",
    shape: { skill: z.string().min(1).max(80), stage: z.enum(['league-start', 'week-1', 'mid']), ascendancy: z.string().max(30).optional(), limit: z.number().int().min(1).max(5).optional() },
    async run(args, ctx) {
      let got;
      try {
        got = await fetchRealBuilds({ skill: String(args.skill), stage: args.stage as Stage, ...(typeof args.ascendancy === 'string' ? { ascendancy: args.ascendancy } : {}), limit: typeof args.limit === 'number' ? args.limit : 3 });
      } catch (e) {
        throw new ToolError(`Could not read poe.ninja: ${e instanceof Error ? e.message : String(e)}`);
      }
      const characters = [];
      for (const c of got.characters) {
        try {
          const imp = await importFromText(c.buildCode);
          const d = await drafts(ctx).create(imp.xml, { name: c.name, from: 'import', baseKey: null, baseHash: null });
          characters.push({ draftId: d.id, name: c.name, level: c.level, class: c.className, ascendancy: c.ascendancy, life: c.life, energyShield: c.energyShield, poeNinjaEhp: c.ninjaEhp ?? null, poeNinjaDps: c.ninjaDps ?? null });
        } catch { /* a code the importer cannot read is skipped */ }
      }
      return { league: got.league, snapshot: got.snapshot, listed: got.total, source: 'poe.ninja', characters, note: 'Config in each draft is the player\'s own: turn off what the build cannot keep up (audit.fixAll) before reading its numbers. Nothing is saved.' };
    },
  },
  {
    name: 'exportBuild',
    chip: 'Export build',
    description: 'The Path of Building code of the open build or a draft, to share or paste into Path of Building.',
    shape: { draftId: DRAFT_ARG },
    async run(args, ctx) {
      const b = need(ctx, args);
      const code = await encodeBuildCode(await savedXml(ctx, b.buildId));
      return { name: b.name, code, length: code.length };
    },
  },
  {
    name: 'saveDraftAsBuild',
    chip: 'Save build',
    description: 'Saves a draft to the player\'s build library as a new build (it never overwrites a build). Only when the player asked for it.',
    shape: { draftId: z.string().max(20), name: z.string().min(1).max(80).optional() },
    async run(args, ctx) {
      const d = draftOf(ctx, args.draftId);
      if (!ctx.library) throw new ToolError('The build library is not available here.');
      const saved = await ctx.library.save(typeof args.name === 'string' ? args.name : d.name, await savedXml(ctx, d.buildId));
      return { saved: true, buildId: saved.id, name: saved.name, note: 'It is in the library now; the player can open it there.' };
    },
  },
  {
    name: 'startDraft',
    chip: 'Start draft',
    description:
      'Makes a draft: a private copy of the open build that you edit freely with editDraft (any number of edits, kept in order), read with any read tool and draftId, and compare with evaluateEdits. proposeDraft turns the whole draft into ONE change, applied at once and undone with one click. The open build is not touched.',
    shape: { name: z.string().max(80).optional() },
    async run(args, ctx) {
      const open = need(ctx);
      const xml = await xmlOf(ctx, open.buildId);
      const d = await drafts(ctx).create(xml, { name: typeof args.name === 'string' ? args.name : `Draft of ${open.name}`, from: 'open', baseKey: open.buildKey, baseHash: xmlHash(xml) }, await statMap(ctx, open.buildId));
      return { draftId: d.id, name: d.name };
    },
  },
  {
    name: 'editDraft',
    chip: 'Edit draft',
    description: 'Makes edits on a draft, in order (up to 100 per call; call again for more). Stops at an edit the engine refuses and says why. Returns what changed against the draft\'s start.',
    shape: { draftId: z.string().max(20), edits: z.array(EditSchema).min(1).max(100) },
    async run(args, ctx) {
      const d = draftOf(ctx, args.draftId);
      const edits = parseEdits(args.edits, 100);
      let done = 0;
      let refused: string | null = null;
      let settled: () => Promise<void> = async () => {};
      for (const e of edits) {
        let r;
        try {
          settled = settleAfter(ctx, d.buildId, fullDps(d.startStats));
          r = await ctx.engine.send('edit', { buildId: d.buildId, edit: toBuildEdit(e) });
        } catch (err) {
          refused = `edit ${done + 1} failed: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
        if (r.blocked) {
          refused = `edit ${done + 1} was refused: ${refusal(r.blocked)}`;
          break;
        }
        d.lines.push(describeEdit(e));
        d.kinds.add(e.kind);
        done++;
      }
      if (done) await settled();
      const now = await statMap(ctx, d.buildId);
      return {
        draftId: d.id,
        applied: done,
        ...(refused ? { refused, notApplied: edits.length - done } : {}),
        totalEdits: d.lines.length,
        changesSinceStart: changeRows(pickChanges(deltasOf(d.startStats, now), 10)),
        note: 'Numbers are from the engine, on the draft only. The open build was not changed.',
      };
    },
  },
  {
    name: 'evaluateEdits',
    chip: 'Compare options',
    description:
      'Batch what-if: calculates several options (each one or more edits) separately on a scratch copy of the open build or a draft, and ranks them by the first stat asked for that the build has a non-zero value for (rankedBy says which). Nothing is changed. Use it to compare candidate nodes, gems, items or config before proposing one.',
    shape: {
      options: z.array(z.object({ label: z.string().min(1).max(80), edits: z.array(EditSchema).min(1).max(20) })).min(1).max(30),
      stats: z.array(z.string().max(40)).max(12).optional().describe('Stat ids to report and rank by (default FullDPS, CombinedDPS, TotalEHP, Life, EnergyShield).'),
      draftId: DRAFT_ARG,
    },
    async run(args, ctx) {
      const b = need(ctx, args);
      const xml = await xmlOf(ctx, b.buildId);
      const baseline = await statMap(ctx, b.buildId);
      const count = mainCount((await ctx.engine.send('skillsState', { buildId: b.buildId })).state);
      const ids = Array.isArray(args.stats) && args.stats.length ? (args.stats as string[]) : KEY_STATS;
      const options = args.options as Array<{ label: string; edits: unknown }>;
      const rows = await withScratch(ctx, xml, async (scratch) => {
        const depth = (await ctx.engine.send('history', { buildId: scratch })).undo;
        const out = [];
        for (const o of options) {
          const edits = parseEdits(o.edits, 20);
          let after: Record<string, Scalar> | null = null;
          let refused: string | null = null;
          try {
            if (edits.length === 1) {
              const r = await ctx.engine.send('previewEdit', { buildId: scratch, edit: toBuildEdit(edits[0]!), full: true });
              if (r.blocked) refused = refusal(r.blocked);
              else {
                after = { ...baseline };
                for (const c of r.statDiff.changed) if (c.after === null || typeof c.after !== 'object') after[c.statId] = c.after as Scalar;
              }
            } else {
              let settled: () => Promise<void> = async () => {};
              for (const [i, e] of edits.entries()) {
                settled = settleAfter(ctx, scratch, fullDps(baseline));
                const r = await ctx.engine.send('edit', { buildId: scratch, edit: toBuildEdit(e) });
                if (r.blocked) {
                  refused = `edit ${i + 1}: ${refusal(r.blocked)}`;
                  break;
                }
              }
              if (!refused) {
                await settled();
                after = await statMap(ctx, scratch);
              }
              const undone = settleAfter(ctx, scratch, fullDps(baseline));
              await undoTo(ctx, scratch, depth);
              await undone();
            }
          } catch (err) {
            refused = err instanceof Error ? err.message.slice(0, 200) : String(err);
            await undoTo(ctx, scratch, depth).catch(() => undefined);
          }
          // a Full DPS count that stood for projectiles follows them, as proposeEdit will set it
          if (after) after = withScaledCount(baseline, after, count);
          out.push(after ? { label: o.label, key: keyRows(baseline, after, ids), changes: changeRows(pickChanges(deltasOf(baseline, after), 6)) } : { label: o.label, refused });
        }
        return out;
      });
      const first = rankStat(ids, baseline);
      const gainOf = (r: (typeof rows)[number]) => ('key' in r && r.key ? (r.key.find((k) => k.stat === first)?.change ?? -Infinity) : -Infinity);
      return { rankedBy: first, options: [...rows].sort((a, b) => gainOf(b) - gainOf(a)), note: 'Engine numbers on a scratch copy. Nothing was changed.' };
    },
  },
  {
    name: 'proposeDraft',
    chip: 'Propose draft',
    description:
      'Turns a draft made with startDraft into ONE change to the open build: it is applied at once as one Undo step, with the before and after numbers and every change shown, and the player undoes the whole draft with one click. Only for drafts of the open build, and only while the open build has not changed since startDraft.',
    shape: { draftId: z.string().max(20), title: z.string().min(3).max(80), summary: z.string().max(300).optional() },
    async run(args, ctx) {
      const d = draftOf(ctx, args.draftId);
      if (d.from !== 'open') throw new ToolError('Only a draft of the open build can be proposed. Save a new or imported build with saveDraftAsBuild instead.');
      if (!d.lines.length) throw new ToolError('The draft has no edits yet.');
      const open = need(ctx);
      if (open.buildKey !== d.baseKey) throw new ToolError('The draft was made from another build. Open that build, or start a new draft.');
      const openXml = await xmlOf(ctx, open.buildId);
      if (xmlHash(openXml) !== d.baseHash) throw new ToolError('The open build changed after the draft started, so the draft is out of date. Start a new draft.');
      // a "not ready" solve row cannot be applied, as in the panel, until the repair has cleared what blocked it
      if (d.notReady) {
        const left = await notReadyLeft(ctx, d.buildId);
        if (left.length) throw new ToolError(`This draft is not ready, so it cannot be applied: ${left[0]}${left.length > 1 ? ` (and ${left.length - 1} more)` : ''}. Repair it first: fix each blocking line with editDraft, run checkBuild with this draftId, then call proposeDraft again.`);
      }
      // the repairs a single change gets, made on the draft itself: a requirement the draft broke, then (unless the draft
      // already loses heavily, which a fold-in would hide) old shortfalls and a skill that no longer pays its mana
      const full = fullDps(d.startStats);
      const alreadyUnmet = new Set((await unmetGems(ctx, open.buildId)).map((g) => g.key));
      const fit = await fixRequirements(ctx, d.buildId, alreadyUnmet, { tree: true });
      const mid = await statMap(ctx, d.buildId);
      const losesBig = ['FullDPS', 'CombinedDPS', 'TotalEHP'].some((id) => typeof d.startStats[id] === 'number' && (d.startStats[id] as number) > 0 && Number(mid[id] ?? 0) < 0.85 * (d.startStats[id] as number));
      const repairs = [fit, ...(losesBig ? [] : [await fixOldShortfalls(ctx, d.buildId, alreadyUnmet, full, true), await fixManaShortfall(ctx, d.buildId, full)])];
      for (const r of repairs) { d.lines.push(...r.lines); for (const e of r.edits) d.kinds.add(e.kind); }
      // the same audit a single change gets: config left without a source, a stale Full DPS count, go into the draft's one step
      const auditOpen = auditBuild(ctx, open.buildId, openXml);
      const audited = await auditOpen
        .then(async (b) => auditChange(ctx, d.buildId, [], b, d.startStats, (await ctx.engine.send('configState', { buildId: open.buildId })).state, fullDps(d.startStats)))
        .catch(() => null);
      if (audited) { d.lines.push(...audited.lines); for (const e of audited.edits) d.kinds.add(e.kind); }
      const xml = await xmlOf(ctx, d.buildId);
      const now = await statMap(ctx, d.buildId);
      const { tree } = await ctx.engine.send('treeState', { buildId: d.buildId });
      const startSet = new Set(d.startAllocated);
      const endSet = new Set(tree.allocated);
      const addedIds = tree.allocated.filter((id) => !startSet.has(id));
      const removedIds = d.startAllocated.filter((id) => !endSet.has(id));
      const names = async (ids: number[]) => (await ctx.tree.nodes(tree.treeVersion, ids)).map((n) => n.name);
      // the gate a single change passes, on the draft as a whole
      const [warnBefore, warnAfter] = await Promise.all([buildWarnings(ctx, open.buildId), buildWarnings(ctx, d.buildId)]);
      const gemSlots = (x: string) => readSkills(x).flatMap((g) => (g.slot ? [g.slot] : []));
      const misfitBefore = await socketMisfits(ctx, openXml, gemSlots(openXml));
      const misfits = (await socketMisfits(ctx, xml, gemSlots(xml))).filter((l) => !misfitBefore.includes(l));
      const off = audited?.audit.findings.find((f) => f.kind === 'conditionalDefence' && f.without);
      const offBefore = off ? (await auditOpen.catch(() => null))?.findings.find((f) => f.id === off.id)?.without : undefined;
      const guard = validGuard(off?.without ? { name: off.without.name, before: offBefore?.ehp ?? Number.NaN, after: off.without.ehp } : null);
      const typed = (await ctx.engine.send('configState', { buildId: open.buildId })).state.customMods.some((m) => m.enabled && m.lineOk.some(Boolean));
      const honest = typed ? await Promise.all([honestStats(ctx, open.buildId, d.startStats, full), honestStats(ctx, d.buildId, now, full)]).then(([b, a]) => ({ before: b, after: a })).catch(() => null) : undefined;
      const said = askFor(ctx);
      const verdict = checkChange(
        { before: d.startStats, after: now, warnBefore, warnAfter, unfixed: fit.unfixed, itemLines: misfits, guard, ...(honest !== undefined ? { honest } : {}), ...(said.leadStat() ? { stat: said.leadStat() } : {}), ...([...d.kinds].every((k) => ASSUMPTION_KINDS.has(k)) ? { configOnly: true } : {}), level: { before: readBuildMeta(openXml).level, after: readBuildMeta(xml).level } },
        { named: namedByPlayer(said.text, await draftThings(ctx, openXml, xml, tree.treeVersion, addedIds)), question: isPureQuestion(said.text), suppressionWaived: said.allowsSuppressionLoss(), levelAsked: playerSaysLevel(said.text) },
      );
      const offer = verdict.outcome === 'card';
      if (offer) refusalNotes.push(`${verdict.rows[0]?.rule === 'question' ? verdict.reason : `Not applied: ${verdict.reason}`}. It is a card`);
      const costFirst = verdict.outcome === 'applyWithCost' ? `As you asked, at a cost: ${verdict.reason}` : '';
      const changes = pickChanges(deltasOf(d.startStats, now), 6);
      const lines = d.lines.length > 40 ? [...d.lines.slice(0, 40), `... and ${d.lines.length - 40} more`] : [...d.lines];
      // a support swap that takes out an extra-projectile gem (GMP, Volley): fewer projectiles slow clearing, and Full DPS counts one target
      const projectile = /Multiple Projectiles|Volley/i;
      const lostProjectiles = d.lines.flatMap((l) => {
        const m = /replaced (.+?) with (.+)$/i.exec(l);
        return m ? m[1]!.split(/, /).filter((g) => projectile.test(g) && !m[2]!.split(/, /).some((n) => n === g)) : [];
      });
      if (lostProjectiles.length) lines.push(`Takes out ${lostProjectiles.join(' and ')}: fewer projectiles, so clearing and groups get slower. Full DPS counts one target and does not show it`);
      const ascRemoved = (await ctx.tree.nodes(tree.treeVersion, removedIds)).filter((n) => 'ascendancy' in n && n.ascendancy).length;
      const respec = await respecCost(ctx.prices, removedIds.length - ascRemoved, ascRemoved);
      const kind: Proposal['kind'] = [...d.kinds].every((k) => TREE_KINDS.has(k)) ? 'tree' : 'changes';
      const p = ctx.proposals.create({
        buildId: open.buildId,
        buildKey: open.buildKey,
        removedIds,
        addedIds,
        title: String(args.title),
        ...(typeof args.summary === 'string' || costFirst || offer ? { summary: [costFirst, offer ? `Not applied: ${verdict.reason}` : '', args.summary].filter((x) => typeof x === 'string' && x).join('. ') } : {}),
        // The draft's text as one edit: one undo step, and Apply refuses it if the build changed (baseHash).
        edits: [{ kind: 'setXml', xml }],
        kind,
        removed: await names(removedIds),
        added: await names(addedIds),
        lines,
        gems: [],
        changes,
        origin: ctx.origin,
        ...(ctx.client ? { client: ctx.client } : {}),
        ...(offer ? { offer: true } : {}),
        baseHash: d.baseHash!,
      });
      return {
        proposalId: p.id,
        buildChanged: false,
        status: offer ? `not applied, held as a card with Apply (one tap): ${verdict.reason}` : 'saved as a proposal; the app applies it as one Undo step with an Undo button (buildChanged says whether it went in)',
        ...(verdict.outcome !== 'apply' ? { gate: { outcome: verdict.outcome, reason: verdict.reason, say: costFirst ? 'The player named this change: it went in. Say its cost (reason) in your first sentence.' : 'Not applied: say why in one line (reason); the app prints it in its Check line.' } } : {}),
        ...(costFirst ? { checkNotes: [costFirst] } : {}),
        edits: d.lines.length,
        changes: changeRows(changes),
        removedNodes: p.removed.length,
        addedNodes: p.added.length,
        ...(respec ? { respec } : {}),
        ...(lostProjectiles.length ? { projectilesLost: lostProjectiles, projectileNote: `Say it plainly in the answer: this takes out ${lostProjectiles.join(' and ')}, so the skill fires fewer projectiles and clear speed and groups drop; Full DPS counts one target and does not show that. Then offer the same swap with it kept: proposeEdit with offer:true.` } : {}),
        ...(audited ? { auditLines: audited.lines, auditNotes: audited.notes.map((n) => n.shown), buildAudit: auditForAnswer(audited.audit) } : {}),
        note: `Say it is applied only if buildChanged is true. Describe it briefly using only the numbers above. respec is what the refunded passives cost: say it, never call a respec free. ${AUDIT_NOTE}`,
      };
    },
  },
];

/** Every build tool the assistant has. */
export const BUILD_TOOLS: ToolDef[] =[...TOOLS, ...PARITY_TOOLS, ...RANK_TOOLS, ...PLAN_TOOLS, ...DIAGNOSE_TOOLS, ...APP_TOOLS, ...SOLVE_TOOLS, ...SLOT_BILL_TOOLS, ...KB_TOOLS, ...PATTERN_TOOLS, ...KEPT_TOOLS];
export const BUILD_TOOL_CHIP: Record<string, string> = Object.fromEntries(BUILD_TOOLS.map((t) => [t.name, t.chip]));

export type { ToolEdit };
