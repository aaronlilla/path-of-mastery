import type { SolveGoal, SolveResultSummary, SolveSnapshot, SolveWealth } from '@pom/protocol';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AssessedCandidate, KeptLadder, Proposal, SolveCpu, SolveDetails, SolveItemRules, SolveState } from '../../shared/assistant/types.js';
import { keptGaps } from '../../shared/assistant/keptGap.js';
import { CLASSES } from '../../shared/buildXml.js';
import { answerQuestion, preselect, solveQuestions, standing, followLevel, type AskEvidence } from '../../shared/assistant/solveQuestions.js';
import { tileGap } from '../../shared/dpsTile.js';
import { compactNumber } from '../format';
import { useGameInfo } from '../gameData';
import type { OpenBuild } from '../types';
import { Icon, Segmented, Select, Switch, useToast } from '../ui';
import { ChangeCard, StatTable } from './blocks';
import { setTreePreview, useTreePreview } from './bus';
import type { Assistant } from './useAssistant';
import { label, tr } from '../i18n';

// ---- the goal form (decision #39) -------------------------------------------------------------------------------

const METRICS: Array<{ value: string; label: string }> = [
  { value: 'dps', label: tr('h_c_Solve.dps_single') },
  { value: 'hit', label: label('Hit DPS') },
  { value: 'dot', label: label('DoT DPS') },
  { value: 'boss', label: tr('h_c_Solve.dps_boss') },
  { value: 'full', label: label('Full DPS') },
  { value: 'minion', label: tr('h_c_Solve.minion_dps') },
  { value: 'ehp', label: tr('assistant_SolvePanel.ehp_ref') },
  { value: 'maxhit:physical', label: tr('h_c_Solve.max_phys') },
  { value: 'maxhit:fire', label: tr('h_c_Solve.max_fire') },
  { value: 'maxhit:cold', label: tr('h_c_Solve.max_cold') },
  { value: 'maxhit:lightning', label: tr('h_c_Solve.max_lightning') },
  { value: 'maxhit:chaos', label: tr('h_c_Solve.max_chaos') },
  { value: 'pool', label: tr('h_c_Solve.life_es_pool') },
  { value: 'life', label: label('Life') },
  { value: 'es', label: label('Energy shield') },
  { value: 'resist:chaos', label: label('Chaos resistance') },
];

const RARITIES: SolveItemRules['rarities'] = ['normal', 'magic', 'rare', 'unique'];
const SLOTS = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt'];
const BUDGETS = [
  { value: '0', label: tr('h_c_Solve.until_done') },
  { value: '30000', label: tr('h_c_Solve.sec30') },
  { value: '60000', label: tr('h_c_Solve.min1') },
  { value: '120000', label: tr('h_c_Solve.min2') },
  { value: '300000', label: tr('h_c_Solve.min5') },
  { value: '600000', label: tr('h_c_Solve.min10') },
  { value: '1200000', label: tr('h_c_Solve.min20') },
];

const WEALTH: Array<{ value: SolveWealth; label: string }> = [
  { value: 'league-start', label: tr('h_c_Solve.w_league_start') },
  { value: 'mid-league', label: tr('h_c_Solve.w_mid_league') },
  { value: 'rich', label: tr('h_c_Solve.w_rich') },
  { value: 'mirror', label: tr('h_c_Solve.w_mirror') },
];
// (the solver's wealth-tier life floors, engine-data/wealth_tiers.json poolFloor)
const POOL_FLOOR: Record<SolveWealth, number> = { 'league-start': 3500, 'mid-league': 4500, rich: 5500, mirror: 6000 };
const MODES: { value: 'mapping' | 'bossing' | 'both'; label: string }[] = [{ value: 'mapping', label: tr('h_c_Solve.m_mapping') }, { value: 'bossing', label: tr('h_c_Solve.m_bossing') }, { value: 'both', label: tr('h_c_Solve.m_both') }];
const MODE_HINT = {
  mapping: tr('h_c_Solve.hint_mapping'),
  bossing: tr('h_c_Solve.hint_bossing'),
  both: tr('h_c_Solve.hint_both'),
} as const;
const SITS = { all: 'assistant_SolvePanel.sits_all', p90: 'assistant_SolvePanel.sits_p90', p50: 'assistant_SolvePanel.sits_p50', p10: 'assistant_SolvePanel.sits_p10', low: 'assistant_SolvePanel.sits_low' } as const;
const WEALTH_HINT: Record<SolveWealth, string> = {
  'league-start': tr('h_c_Solve.hint_league_start'),
  'mid-league': tr('h_c_Solve.hint_mid_league'),
  rich: tr('h_c_Solve.hint_rich'),
  mirror: tr('h_c_Solve.hint_mirror'),
};

interface Form {
  skill: string;
  className: string;
  ascendancy: string;
  level: number;
  /** The level is the open build's, the player's or a goal's. False (blank build, nothing typed): it follows the wealth tier. */
  levelOwn: boolean;
  targets: Array<{ name: string; metric: string; value: string }>;
  resistsOn: boolean;
  resists: number;
  poolOn: boolean;
  pool: number | '';
  attributes: boolean;
  reservation: boolean;
  warnings: boolean;
  cost: boolean;
  items: SolveItemRules;
  assume: boolean;
  /** Mapping, bossing or both: asked every time ('' = not picked yet, Run stays off). */
  playMode: 'mapping' | 'bossing' | 'both' | '';
  /** The goal as loaded: fields the form has no box for (gem bans, bandit, point overrides, extra limits, weights) ride along on Run. */
  base: SolveGoal | null;
  configOn: string[];
  rolls: 'typical' | 'perfect';
  /** No default: the player picks it every time. */
  wealth: SolveWealth | '';
  timeBudgetMs: number;
  cpu: SolveCpu;
}

function defaultForm(build: OpenBuild): Form {
  return {
    skill: build.info.mainSkill,
    className: '',
    ascendancy: '',
    level: build.info.level >= 2 ? build.info.level : 90,
    levelOwn: build.info.level >= 2,
    targets: [
      { name: 'DPS', metric: 'dps', value: '' },
      { name: 'EHP', metric: 'ehp', value: '' },
    ],
    resistsOn: true,
    resists: 75,
    poolOn: true,
    pool: '',
    attributes: true,
    reservation: true,
    warnings: true,
    cost: true,
    items: { rarities: [...RARITIES], mustUse: [], neverUse: [], lockSlots: [], slotRarities: {} },
    assume: true,
    playMode: '',
    base: null,
    configOn: [],
    rolls: 'typical',
    wealth: '',
    timeBudgetMs: 0,
    cpu: 'normal',
  };
}

/** Picking wealth moves a level the player never set to the tier's usual one (league start 88, else 95). */
export function withWealth(f: Form, wealth: SolveWealth | ''): Form {
  return { ...f, wealth, level: f.levelOwn ? f.level : followLevel(f.levelOwn, f.level, { skill: f.skill, ...(wealth ? { wealth } : {}) }) };
}

/** "1.5M", "50k", "1,200,000" -> a number. */
export function parseAmount(text: string): number | undefined {
  const m = /^\s*([\d.,]+)\s*([kmb])?\s*$/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, '')) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase() as 'k'] ?? 1);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Why Run is off, or '' when it can run. Wealth and the play focus have no default. */
export function runBlockFor(f: Form): string {
  return !f.skill.trim() ? tr('assistant_SolvePanel.pick_a_main_skill_to_run') : !f.wealth ? tr('assistant_SolvePanel.pick_wealth_to_run') : !f.playMode ? tr('assistant_SolvePanel.pick_mapping_bossing_or_both_to') : '';
}

export function toGoal(f: Form): SolveGoal {
  const items: SolveItemRules = f.items;
  const { wealth: _w, className: _c, ascendancy: _a, ...kept } = f.base ?? ({} as SolveGoal);
  const ba = f.base?.assume;
  // The play focus is asked every time: a loaded goal's playMode never carries over (only one the player just said in chat). flaskUptime follows the pick.
  const { playMode: _pm, flaskUptime: _fu, ...baKept } = ba ?? {};
  const flaskUptime = f.playMode === 'mapping' ? 'mapping' : 'bossing';
  return {
    ...kept,
    skill: f.skill.trim(),
    ...(f.className ? { className: f.className } : {}),
    ...(f.ascendancy ? { ascendancy: f.ascendancy } : {}),
    level: f.level,
    targets: f.targets.map((t) => ({ ...f.base?.targets?.find((b) => b.name === t.name && (b.metric ?? 'dps') === t.metric && b.weight !== undefined), name: t.name.trim() || METRICS.find((m) => m.value === t.metric)?.label || t.metric, metric: t.metric, ...(parseAmount(t.value) ? { value: parseAmount(t.value)! } : {}) })),
    limits: { ...kept.limits, resists: f.resistsOn ? f.resists : null, pool: f.poolOn ? (f.pool === '' ? undefined : f.pool) : null, attributes: f.attributes, reservation: f.reservation, warnings: f.warnings, cost: f.cost },
    items: { ...(kept.items as object), ...items },
    rolls: f.rolls,
    ...(f.wealth ? { wealth: f.wealth } : {}),
    assume: { ...baKept, ...(f.assume ? { flasks: true, ailments: true, charges: true, flaskUptime } : { flasks: false, ailments: false, charges: false }), ...(f.playMode ? { playMode: f.playMode } : {}), ...(f.configOn.length ? { configOn: f.configOn } : { configOn: undefined }) },
  };
}

export function fromGoal(g: SolveGoal, st: SolveState, base: Form): Form {
  const items = (g.items ?? {}) as Partial<SolveItemRules>;
  const a = g.assume;
  return {
    ...base,
    skill: g.skill,
    className: g.className ?? '',
    ascendancy: g.ascendancy ?? '',
    level: g.level ?? followLevel(!!base.levelOwn, base.level, g),
    levelOwn: !!base.levelOwn || (g.level != null && g.level !== base.level), // the form's own level echoed back by main is not the player's
    targets: g.targets?.length ? g.targets.map((t) => ({ name: t.name, metric: t.metric ?? 'dps', value: t.value ? compactNumber(t.value) : '' })) : base.targets,
    resistsOn: g.limits?.resists !== null,
    resists: g.limits?.resists ?? 75,
    poolOn: g.limits?.pool !== null,
    pool: g.limits?.pool && g.limits.pool > 0 ? g.limits.pool : '',
    attributes: g.limits?.attributes ?? true,
    reservation: g.limits?.reservation ?? true,
    warnings: g.limits?.warnings ?? true,
    cost: g.limits?.cost ?? true,
    items: { rarities: items.rarities?.length ? items.rarities : [...RARITIES], mustUse: items.mustUse ?? [], neverUse: items.neverUse ?? [], lockSlots: items.lockSlots ?? [], slotRarities: items.slotRarities ?? {} },
    assume: !a || a.flasks !== false || a.ailments !== false,
    playMode: st.modeStated ? (a?.playMode ?? '') : '',
    base: g,
    configOn: a?.configOn ?? [],
    rolls: g.rolls ?? 'typical',
    wealth: g.wealth ?? '',
    timeBudgetMs: st.timeBudgetMs,
    cpu: st.cpu,
  };
}

const splitNames = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- the shared solve, as main keeps it ---------------------------------------------------------------------------

function useSolve(): SolveState | null {
  const [st, setSt] = useState<SolveState | null>(null);
  useEffect(() => {
    let live = true;
    void window.pom.assistant.solveState().then((r) => live && r.ok && setSt(r.value));
    const off = window.pom.assistant.onPush((p) => p.kind === 'solve' && setSt(p.state));
    return () => {
      live = false;
      off();
    };
  }, []);
  return st;
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The best row's weakest target as a percent of the ask (100 when every target is met); null when no target has a number. */
export function askPercent(r: SolveResultSummary | undefined): number | null {
  const ps = (r?.targets ?? []).filter((t) => t.target !== null && t.target > 0).map((t) => Math.min(1, Math.max(0, (t.shown ?? t.value) / t.target!)));
  return ps.length ? Math.floor(Math.min(...ps) * 100) : null;
}
const bestOf = (snap: SolveSnapshot | null): SolveResultSummary | undefined => (snap?.results ?? [])[snap?.picks?.[0] ?? 0];

/** The line for a solve that is not running. */
function progressLine(st: SolveState, snap: SolveSnapshot | null): string {
  if (st.status === 'error') return st.error ?? tr('assistant_SolvePanel.the_solver_stopped_with_an_error');
  if (st.status === 'shortlisting') return tr('assistant_SolvePanel.shortlisting_candidates');
  if (st.status === 'stalled') return tr('assistant_SolvePanel.every_lead_stalled_short_of_the');
  if (!snap) return '';
  const leads = snap.leads ?? [];
  const kept = (snap.picks ?? []).length;
  if (st.status === 'done' && leads.length && kept) return tr('assistant_SolvePanel.done_directions_tried_kept', { leads: leads.length, kept: kept });
  const word = st.status === 'done' ? tr('assistant_SolvePanel.done') : tr('assistant_SolvePanel.stopped');
  const pct = askPercent(bestOf(snap));
  return [...((st.round ?? 1) > 1 ? [tr('assistant_SolvePanel.round', { round: st.round })] : []), word, elapsed(snap.elapsedMs), tr('assistant_SolvePanel.evaluations', { US: snap.evaluations.toLocaleString('en-US') }), ...(pct === null ? [] : [tr('assistant_SolvePanel.solve_best_so_far', { pct })])].join(' · ');
}

/** The running line: it ticks every second on the panel's own clock, so the text changes even inside a stage that sends nothing. */
export function StatusLine({ st, snap }: { st: SolveState; snap: SolveSnapshot | null }) {
  const [now, setNow] = useState(() => Date.now());
  const arrived = useRef(now);
  const gain = useRef({ id: '', score: -Infinity, at: now });
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  // a push arrived: remember when, and whether the best build got better
  useEffect(() => {
    const t = Date.now();
    arrived.current = t;
    const score = bestOf(snap)?.score ?? -Infinity;
    const id = `${snap?.solveId ?? ''}:${st.block ?? 1}`;
    const g = gain.current;
    if (g.id !== id) gain.current = { id, score, at: t };
    else if (score > g.score) gain.current = { id, score, at: t };
    setNow(t);
  }, [snap, st.block]);
  if (!snap) return <>{tr('assistant_SolvePanel.starting')}</>;
  const ms = snap.elapsedMs + Math.max(0, now - arrived.current);
  const pct = askPercent(bestOf(snap));
  const leads = snap.leads ?? [];
  const bits = [...((st.round ?? 1) > 1 ? [tr('assistant_SolvePanel.round', { round: st.round })] : []), ...((st.block ?? 1) > 1 ? [tr('assistant_SolvePanel.solve_block_n', { n: st.block })] : []), tr('assistant_SolvePanel.running'), elapsed(ms)];
  if (pct !== null) bits.push(tr('assistant_SolvePanel.solve_best_so_far', { pct }), tr('assistant_SolvePanel.solve_last_gain', { s: Math.max(0, Math.floor((now - gain.current.at) / 1000)) }));
  const n = snap.evaluations;
  bits.push(tr('assistant_SolvePanel.evaluations', { US: n.toLocaleString('en-US') }));
  if (leads.length) {
    const left = leads.filter((l) => l.status !== 'dropped').length;
    bits.push((snap.picks ?? []).length ? tr(left === 1 ? 'h_c_Solve.direction_left' : 'h_c_Solve.directions_left', { left }) : tr('assistant_SolvePanel.trying_directions', { leads: leads.length }));
  }
  return <>{bits.join(' · ')}</>;
}

// ---- the AI's plan (the AI plans, the solver tests) ------------------------------------------------

type PlanLead = { name: string; className?: string; ascendancy?: string; uniques?: string[]; supports?: string[]; keystones?: string[]; why?: string; replaces?: string };
const ROW_WORD = { running: tr('assistant_SolvePanel.testing'), met: tr('h_c_Solve.w_met'), stalled: tr('assistant_SolvePanel.stalled'), error: tr('h_c_Solve.w_could_not_run'), stopped: tr('assistant_SolvePanel.stopped') } as const;
type EndLead = { name: string; values: Array<{ name: string; value: number; need: number }>; limiting?: string; moreTimeHelps?: boolean };
const planLeads = (g: SolveGoal | null): PlanLead[] => (g as (SolveGoal & { plan?: { leads?: PlanLead[] } }) | null)?.plan?.leads ?? [];
const ENGINE_WORD = { live: tr('assistant_SolvePanel.testing'), reserve: tr('h_c_Solve.w_in_reserve'), dropped: tr('h_c_Solve.w_dropped'), stalled: tr('assistant_SolvePanel.stalled'), final: tr('h_c_Solve.w_finalist') } as const;
const same = (a: string, b: string) => a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());

/** The plan's leads with where each stands: the engine's lead status while it runs ("Stalled · <limit>" the moment one
 *  stalls), its best against the need after a stall; a lead the assistant swapped in sits under the one it replaces. */
export function PlanList({ st, snap }: { st: SolveState; snap: SolveSnapshot | null }) {
  const leads = planLeads(st.goal);
  if (!leads.length) return null;
  const ended = (snap as (SolveSnapshot & { end?: { leads?: EndLead[] } }) | null)?.end?.leads ?? [];
  const live = st.status === 'running' || st.status === 'shortlisting';
  const one = (l: PlanLead, sub: boolean, k: number) => {
    const row = snap?.plan?.leads?.filter((x) => x.name === l.name).pop();
    const stall = row?.status === 'stalled' ? snap?.stalls?.find((x) => x.id === row.id) : undefined;
    const e = ended.find((x) => same(x.name, l.name));
    const g = snap?.leads?.find((x) => same(x.label, l.name));
    const word = stall ? tr('assistant_SolvePanel.stalled') : e ? (e.moreTimeHelps ? tr('assistant_SolvePanel.short_more_time_helps') : tr('assistant_SolvePanel.short')) : row ? ROW_WORD[row.status] : g ? ENGINE_WORD[g.status] : live ? tr('assistant_SolvePanel.testing') : st.status === 'ready' ? tr('assistant_SolvePanel.waiting') : '';
    const who = [l.ascendancy ?? l.className, ...(l.uniques ?? [])].filter(Boolean).join(' · ');
    return (
      <div className={'sv-plan' + (sub ? ' sub' : '')} key={`${l.name}:${k}`}>
        <div className="sv-plan-h">
          <b>{l.name}</b>
          {word && <span className={'sv-plan-s' + (e || stall || g?.status === 'dropped' || row?.status === 'error' ? ' dn' : '')}>{word}</span>}
        </div>
        {who && <div className="sv-diff">{who}</div>}
        {stall ? (
          <div className="sv-diff sv-stall">{stall.limiting ?? stall.values.map((v) => tr('assistant_SolvePanel.of', { name: v.name, value: compactNumber(v.value), need: compactNumber(v.need) })).join(', ')}</div>
        ) : e ? (
          <div className="sv-diff">
            {e.values.map((v) => `${v.name} ${compactNumber(v.value)} / ${compactNumber(v.need)}`).join(' · ')}
            {e.limiting ? tr('assistant_SolvePanel.limited_by', { limiting: e.limiting }) : ''}
          </div>
        ) : (
          l.why && <div className="sv-diff">{l.why}</div>
        )}
      </div>
    );
  };
  // each lead, then the leads that replace it (and theirs), under it
  const tree = (l: PlanLead, depth: number, k: number): ReactNode[] => [one(l, depth > 0, k), ...(depth < 4 ? leads.flatMap((r, j) => (r.replaces === l.name ? tree(r, depth + 1, j) : [])) : [])];
  return (
    <section className="sv-sec" aria-label={tr('assistant_SolvePanel.plan')}>
      <h4>{(st.round ?? 1) > 1 ? tr('assistant_SolvePanel.plan_round', { round: st.round }) : tr('assistant_SolvePanel.plan')}</h4>
      {leads.flatMap((l, k) => (l.replaces && leads.some((x) => x.name === l.replaces) ? [] : tree(l, 0, k)))}
    </section>
  );
}

/** One word of the goal sentence: gold when set, dashed when left to the solver; a click opens its editor. */
function SvTok({ id, on = true, cur, set, children }: { id: string; on?: boolean; cur: string | null; set: (v: string | null) => void; children: ReactNode }) {
  return (
    <button type="button" className={'sv-tok ' + (on ? tr('assistant_SolvePanel.gold') : 'pick')} aria-expanded={cur === id} onClick={() => set(cur === id ? null : id)}>
      {children}
    </button>
  );
}

// ---- the panel ---------------------------------------------------------------------------------------------------

export function SolvePanel({ a, build }: { a: Assistant; build: OpenBuild }) {
  const st = useSolve();
  const toast = useToast();
  const info = useGameInfo();
  const [form, setForm] = useState<Form>(() => defaultForm(build));
  const untouched = useRef(form);
  // The assistant set a goal (goalRev), or the panel opened on a solve already in the form: load it.
  const [loadedRev, setLoadedRev] = useState(-1);
  // The goal as a sentence is the default view; "Edit everything" opens the full form. `tok` is the sentence word being edited.
  const [full, setFull] = useState(false);
  const [tok, setTok] = useState<string | null>(null);
  useEffect(() => {
    if (!st?.goal || st.goalRev === loadedRev) return;
    setLoadedRev(st.goalRev);
    setTok(null);
    // a solve in progress keeps the focus it runs with
    const running = st.status === 'running' || st.status === 'shortlisting';
    setForm((f) => {
      const n = fromGoal(st.goal!, st, f);
      return (synced.current = running ? { ...n, playMode: f.playMode } : n);
    });
  }, [st, loadedRev]);
  // "go" in chat runs main's stored goal: keep it equal to the form on screen. Skips the form just loaded from main.
  const synced = useRef<Form | null>(null);
  const idle = !st || (st.status !== 'running' && st.status !== 'shortlisting');
  useEffect(() => {
    if (!idle || form === synced.current || form === untouched.current) return;
    const t = setTimeout(() => void window.pom.assistant.solveGoal(toGoal(form), { timeBudgetMs: form.timeBudgetMs, cpu: form.cpu }), 300);
    return () => clearTimeout(t);
  }, [form, idle]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const running = st?.status === 'running';
  const shortlisting = st?.status === 'shortlisting';
  const stalled = st?.status === 'stalled';
  const opts = { timeBudgetMs: form.timeBudgetMs, cpu: form.cpu };

  const skills = useMemo(() => {
    const own = [...build.xml.matchAll(/<Gem\b[^>]*\bnameSpec="([^"]+)"/g)].map((m) => m[1]!);
    const all = info ? Object.entries(info.gems).filter(([, g]) => !g.support).map(([n]) => n) : [];
    return [...new Set([...own.filter((n) => !info?.gems[n]?.support), ...all.sort()])];
  }, [build.xml, info]);

  const runBlock = runBlockFor(form);
  const run = () => {
    if (runBlock) return toast({ text: `${runBlock}.`, kind: 'error' });
    void window.pom.assistant.solveRun(toGoal(form), opts).then((r) => !r.ok && toast({ text: r.error, kind: 'error' }));
  };
  // Stop also ends the AI's re-plan turn when the run is waiting on it.
  const stop = () => {
    if (st?.status === 'stalled' && a.turn) a.stop();
    void window.pom.assistant.solveStop();
  };

  const [editing, setEditing] = useState(false);
  const started = !!st && st.buildKey === build.id && (st.status === 'shortlisting' || st.status === 'running' || st.status === 'stalled' || st.status === 'done' || st.status === 'stopped' || st.status === 'error');
  useEffect(() => {
    if (st?.status === 'running' || st?.status === 'shortlisting') setEditing(false);
  }, [st?.status]);
  const showForm = !started || editing;
  // The real-builds pack's reading for the typed skill (ascendancies, gem versions, where the ask sits); nothing until it answers.
  const [evRead, setEvRead] = useState<{ skill: string; ev: AskEvidence | null }>({ skill: '', ev: null });
  const skillKey = form.skill.trim();
  useEffect(() => {
    if (!skillKey) return;
    let live = true;
    const t = setTimeout(() => void Promise.resolve(window.pom.assistant.solveEvidence?.(skillKey)).then((r) => live && setEvRead({ skill: skillKey, ev: r?.ok ? r.value : null }), () => live && setEvRead({ skill: skillKey, ev: null })), 250);
    return () => { live = false; clearTimeout(t); };
  }, [skillKey]);
  const ev = evRead.skill === skillKey ? evRead.ev : null;
  // The ascendancy question stays on screen after the app picked one for this skill (the model hides it once the goal holds one).
  // `cls`: the class the player had named when the question was answered ('' when the class came from the answer), so the options stay as they were.
  const [ascAsked, setAscAsked] = useState<{ skill: string; cls: string }>({ skill: '', cls: '' });
  const asked = ascAsked.skill === skillKey;
  const { ascendancy: _own, className: _cls, ...goalNoAsc } = toGoal(form);
  const qGoal = asked ? { ...goalNoAsc, ...(ascAsked.cls ? { className: ascAsked.cls } : {}) } : toGoal(form);
  const qs = solveQuestions(qGoal, ev ?? undefined);
  // Once per skill, when the goal names no class: the open build's own class (not blank), else on a blank build the most played ascendancy, shown picked; one tap picks another (never again overridden).
  const autoAsc = useRef('');
  const suggestedAsc = qs.find((q) => q.id === 'ascendancy')?.suggested;
  useEffect(() => {
    if (started || autoAsc.current === skillKey) return;
    const p = preselect(toGoal(form), { ...build.info, xml: build.xml }, suggestedAsc);
    if (!p) return;
    autoAsc.current = skillKey;
    if (p.picked) setAscAsked({ skill: skillKey, cls: '' });
    setForm((f) => (f.className || f.ascendancy ? f : { ...f, className: p.className, ascendancy: p.ascendancy }));
  }, [suggestedAsc, started, skillKey]);
  const snap = st && st.buildKey === build.id ? st.snapshot : null;
  const results = snap?.results ?? [];
  const mine = !!st && st.buildKey === build.id;
  const line = mine && st.status !== 'running' ? progressLine(st, snap) : '';
  const missed = mine && (st.status === 'done' || st.status === 'stopped') && !!bestOf(snap) && (bestOf(snap)!.targets.some((t) => t.target !== null && !t.met));
  const keepImproving = () => void Promise.resolve(window.pom.assistant.solveContinue?.()).then((r) => r && !r.ok && toast({ text: r.error, kind: 'error' }), () => toast({ text: tr('assistant_SolvePanel.solve_keep_failed'), kind: 'error' }));
  const cores = typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency || 0;
  const cpuSeg = (
    <Segmented
      ariaLabel={tr('assistant_SolvePanel.cpu_use')}
      value={form.cpu}
      onChange={(v) => set('cpu', v)}
      options={[
        { value: 'normal', label: tr('assistant_SolvePanel.normal') },
        { value: 'gentle', label: tr('assistant_SolvePanel.gentle') },
      ]}
    />
  );
  const cpuLine = cores > 0 && <span className="sv-sub sv-cpu">{tr(form.cpu === 'gentle' ? 'assistant_SolvePanel.solve_threads_gentle' : 'assistant_SolvePanel.solve_threads', { n: form.cpu === 'gentle' ? Math.max(1, Math.floor(cores / 4)) : Math.max(1, cores - 2), g: form.cpu === 'gentle' ? Math.max(1, cores - 2) : Math.max(1, Math.floor(cores / 4)), cores })}</span>;
  // The solver's best leads that differ (lead search); without them the plain results list shows.
  const picks = (snap?.picks ?? []).filter((x) => results[x]).slice(0, 3);
  const others = results.flatMap((r, i): Array<[SolveResultSummary, number]> => (picks.includes(i) ? [] : [[r, i]]));
  // A run started from a kept build: its row is whole and checked, so it stays first with Apply while the searched rows are still in progress.
  const keptI = running && st?.startFrom ? results.findIndex((r) => r.start) : -1;
  const keptLabel = st?.startFrom?.label;
  const picked = picks.filter((p) => p !== keptI);
  const rest = others.filter(([, i]) => i !== keptI);
  const toggleOffer = (k: string) => set('configOn', form.configOn.includes(k) ? form.configOn.filter((x) => x !== k) : [...form.configOn, k]);

  const setTarget = (i: number, patch: Partial<Form['targets'][number]>) => set('targets', form.targets.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const targetRow = (i: number) => {
    const t = form.targets[i]!;
    return (
      <div className="sv-target" key={i}>
        <input className="input" value={t.name} onChange={(e) => setTarget(i, { name: e.target.value })} aria-label={tr('assistant_SolvePanel.target_name', { i: i + 1 })} placeholder={tr('assistant_SolvePanel.name')} />
        <Select ariaLabel={tr('assistant_SolvePanel.target_metric', { i: i + 1 })} width="100%" value={t.metric} options={METRICS} onChange={(v) => setTarget(i, { metric: v })} />
        <input className="input" value={t.value} onChange={(e) => setTarget(i, { value: e.target.value })} aria-label={tr('assistant_SolvePanel.target_value', { i: i + 1 })} placeholder={tr('assistant_SolvePanel.max')} title={tr('assistant_SolvePanel.the_number_to_reach_e_g')} />
        <button type="button" className="ib" aria-label={tr('assistant_SolvePanel.remove_target', { i: i + 1 })} onClick={() => { set('targets', form.targets.filter((_, j) => j !== i)); setTok(null); }} disabled={form.targets.length <= 1}>
          <Icon name="x" size={14} />
        </button>
      </div>
    );
  };
  const uniqueSlots = (
    <div className="sv-chips" role="group" aria-label={tr('assistant_SolvePanel.slots_that_must_be_unique')}>
      {SLOTS.map((s) => {
        const on = form.items.slotRarities?.[s]?.join() === 'unique';
        return (
          <button key={s} type="button" className="sv-chip rar-unique" aria-pressed={on} onClick={() => set('items', { ...form.items, slotRarities: Object.fromEntries([...Object.entries(form.items.slotRarities ?? {}).filter(([k]) => k !== s), ...(on ? [] : [[s, ['unique']]])]) })}>
            {label(s)}
          </button>
        );
      })}
    </div>
  );
  const wealthRow = (
    <div className={'sv-q' + (form.wealth ? '' : ' need')}>
      <b>{tr('assistant_SolvePanel.wealth')} <small>{tr('assistant_SolvePanel.required')}</small></b>
      <Segmented ariaLabel={tr('assistant_SolvePanel.wealth')} value={form.wealth} onChange={(v) => setForm((f) => withWealth(f, v))} options={WEALTH} />
      <span className="sv-sub">{form.wealth ? WEALTH_HINT[form.wealth] : tr('assistant_SolvePanel.pick_one_nothing_is_chosen_for')}</span>
    </div>
  );
  const modeRow = (
    <div className={'sv-q' + (form.playMode ? '' : ' need')}>
      <b>{tr('assistant_SolvePanel.used_for')} <small>{tr('assistant_SolvePanel.required')}</small></b>
      <Segmented ariaLabel={tr('assistant_SolvePanel.used_for')} value={form.playMode} onChange={(v) => set('playMode', v)} options={MODES} />
      <span className="sv-sub">{form.playMode ? MODE_HINT[form.playMode] : tr('assistant_SolvePanel.pick_one_nothing_is_chosen_for')}</span>
    </div>
  );
  const uniques = Object.entries(form.items.slotRarities ?? {}).filter(([, r]) => r.join() === 'unique').map(([k]) => (() => { const b = k.replace(/ \d$/, ''), w = label(b); return tr('h_c_Solve.unique_slot', { slot: w === b ? b.toLowerCase() : w }); })());
  const itemWords = [...uniques, ...form.items.mustUse];
  const pctOf = (note?: string) => note?.match(/\d+%/)?.[0] ?? '';
  const extraRows = qs.filter((q) => q.id === 'ascendancy' || q.id === 'gem').map((q) => {
    const top = q.options.find((o) => o.note);
    const cur = q.id === 'gem' ? q.answer ?? '' : form.ascendancy;
    return (
      <div className="sv-q" key={q.id}>
        <b>{tr(q.id === 'gem' ? 'assistant_SolvePanel.q_gem' : 'assistant_SolvePanel.q_ascendancy')}</b>
        <Segmented ariaLabel={tr(q.id === 'gem' ? 'assistant_SolvePanel.q_gem' : 'assistant_SolvePanel.q_ascendancy')} value={cur} onChange={(v) => { if (q.id === 'ascendancy') setAscAsked({ skill: skillKey, cls: qGoal.className ?? '' }); setForm((f) => { const g = answerQuestion(toGoal(f), q.id, v); return q.id === 'gem' ? { ...f, skill: g.skill } : { ...f, ascendancy: g.ascendancy ?? '', className: g.className ?? f.className }; }); }} options={q.options.map((o) => ({ value: o.value, label: o.label }))} />
        {top && <span className="sv-sub">{tr(q.id === 'gem' ? 'assistant_SolvePanel.q_gem_note' : 'assistant_SolvePanel.q_asc_note', { name: top.label, pct: pctOf(top.note), skill: form.skill.trim() })}</span>}
        {q.elsewhere && <span className="sv-sub">{tr('assistant_SolvePanel.q_asc_elsewhere', { name: q.elsewhere.name, pct: `${Math.round(q.elsewhere.share * 100)}%`, skill: form.skill.trim(), cls: form.className })}</span>}
      </div>
    );
  });
  // Where the ask sits among the real builds of this skill: information only, nothing when the pack has none.
  const sitsParts = form.targets.flatMap((t) => {
    const v = parseAmount(t.value);
    const where = v && ev?.sits ? standing(v, DPS_METRICS.includes(t.metric) ? ev.sits.dps : t.metric === 'ehp' ? ev.sits.ehp : undefined) : null;
    return where ? [`${compactNumber(v!)} ${t.name || t.metric} ${tr(SITS[where])}`] : [];
  });
  const sitsLine = ev?.sits && sitsParts.length > 0 && (
    <span className="sv-sub sv-sits" title={tr('assistant_SolvePanel.sits_caveat')}>
      {tr('assistant_SolvePanel.sits_line', { parts: sitsParts.join('; '), n: ev.sits.builds, skill: form.skill.trim(), league: ev.sits.league ?? '' })}
    </span>
  );
  const tokenEditor = (() => {
    if (!tok) return null;
    if (tok === 'class') return <Select ariaLabel={tr('assistant_SolvePanel.class')} width="100%" value={form.className} onChange={(v) => set('className', v)} options={[{ value: '', label: tr('assistant_SolvePanel.solver_picks') }, ...CLASSES.map((c) => ({ value: c.name, label: c.name }))]} />;
    if (tok === 'asc') return <Select ariaLabel={tr('assistant_SolvePanel.ascendancy_2')} width="100%" value={form.ascendancy} onChange={(v) => set('ascendancy', v)} options={[{ value: '', label: tr('assistant_SolvePanel.solver_picks') }, ...CLASSES.flatMap((c) => c.ascendancies.map((x) => ({ value: x, label: x, hint: c.name })))]} />;
    if (tok === 'skill') return <input className="input" list="sv-skills" value={form.skill} onChange={(e) => set('skill', e.target.value)} placeholder={tr('assistant_SolvePanel.any_active_skill_gem')} aria-label={tr('assistant_SolvePanel.main_skill')} autoFocus />;
    if (tok === 'level') return <input className="input" type="number" min={1} max={100} value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: Math.max(1, Math.min(100, Number(e.target.value) || 1)), levelOwn: true }))} aria-label={tr('assistant_SolvePanel.level')} autoFocus />;
    if (tok === 'items') {
      return (
        <>
          <span className="sv-sub">{tr('assistant_SolvePanel.only_a_unique_in_these_slots')}</span>
          {uniqueSlots}
          <input className="input" value={form.items.mustUse.join(', ')} onChange={(e) => set('items', { ...form.items, mustUse: splitNames(e.target.value) })} placeholder={tr('assistant_SolvePanel.uniques_it_must_use_comma_separated')} aria-label={tr('assistant_SolvePanel.uniques_the_build_must_use')} />
        </>
      );
    }
    if (tok === 'wealth') return wealthRow;
    if (tok === 'mode') return modeRow;
    return targetRow(Number(tok.slice(1)));
  })();
  const targetWord = (t: Form['targets'][number]) => `${t.value ? t.value + ' ' : ''}${t.name || METRICS.find((m) => m.value === t.metric)?.label || t.metric}`;

  return (
    <div className="sv">
      <div className="sv-body scroll-y">
        {st?.from === 'assistant' && st.status === 'ready' && (
          <div className="sv-note" role="status">
            <Icon name="sparkles" size={14} />
            {tr('assistant_SolvePanel.goal_set_up_check_wealth')}
          </div>
        )}
        {!showForm && (
          <div className="sv-sum">
            <span>
              <b>{form.skill}</b>  {tr('assistant_SolvePanel.level_2')} {form.level}
              {form.className ? ` · ${form.className}` : ''}
              {form.ascendancy ? ` · ${form.ascendancy}` : ''}
              {form.wealth ? ` · ${WEALTH.find((w) => w.value === form.wealth)?.label}` : ''} · {form.targets.map((t) => `${t.name || t.metric}${t.value ? ` ${t.value}` : ''}`).join(', ')}
            </span>
            <button type="button" className="abtn quiet" onClick={() => setEditing(true)} disabled={running} title={running ? tr('assistant_SolvePanel.stop_the_solve_to_change_the') : tr('assistant_SolvePanel.change_the_goal')}>
              <Icon name="edit" size={13} />
              
              {tr('assistant_SolvePanel.edit_goal')}
            </button>
          </div>
        )}
        {showForm && !full && (<>
        <section className="sv-sec" aria-label={tr('assistant_SolvePanel.what_i_understood')}>
          <h4>{tr('assistant_SolvePanel.here_is_what_i_understood')}</h4>
          <div className="sv-sentence">
            
            {tr('assistant_SolvePanel.build_a')} <SvTok cur={tok} set={setTok} id="class" on={!!form.className}>{form.className || tr('assistant_SolvePanel.i_pick')}</SvTok>  {tr('assistant_SolvePanel.around')} <SvTok cur={tok} set={setTok} id="skill" on={!!form.skill.trim()}>{form.skill.trim() || tr('assistant_SolvePanel.i_pick')}</SvTok>
            {' '}{tr('assistant_SolvePanel.with')} <SvTok cur={tok} set={setTok} id="items" on={itemWords.length > 0}>{itemWords.length ? itemWords.join(', ') : tr('assistant_SolvePanel.any_gear')}</SvTok>{tr('assistant_SolvePanel.reaching')}{' '}
            {form.targets.map((t, i) => (
              <span key={i}>
                {i > 0 && (i === form.targets.length - 1 ? ` ${tr('h_c_Solve.and_sep')} ` : ', ')}
                <SvTok cur={tok} set={setTok} id={'t' + i} on={!!t.value}>{t.value ? targetWord(t) : tr('assistant_SolvePanel.max_2', { t: targetWord(t) })}</SvTok>
              </span>
            ))}
            {form.targets.length < 6 && (
              <button type="button" className="sv-tok pick" aria-label={tr('assistant_SolvePanel.add_target')} onClick={() => { set('targets', [...form.targets, { name: '', metric: 'life', value: '' }]); setTok('t' + form.targets.length); }}>
                {form.targets.length ? '+' : tr('assistant_SolvePanel.a_target')}
              </button>
            )}
            {tr('assistant_SolvePanel.ascendancy')} <SvTok cur={tok} set={setTok} id="asc" on={!!form.ascendancy}>{form.ascendancy || tr('assistant_SolvePanel.i_pick')}</SvTok>{tr('assistant_SolvePanel.level_3')} <span style={{ whiteSpace: 'nowrap' }}><SvTok cur={tok} set={setTok} id="level">{String(form.level)}</SvTok>.</span>
          </div>
          <datalist id="sv-skills">
            {skills.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          {tokenEditor && <div className="sv-tokedit">{tokenEditor}</div>}
          <span className="sv-sub">
            <span className="sv-tok gold static">{tr('assistant_SolvePanel.gold')}</span>  {tr('assistant_SolvePanel.is_set')} <span className="sv-tok pick static">{tr('assistant_SolvePanel.dashed')}</span>  {tr('assistant_SolvePanel.is_left_to_the_solver_click')}
          </span>
        </section>
        {st?.from === 'assistant' && st.status === 'ready' && st.notes?.map((n) => (
          <div className="sv-note warn" role="alert" key={n}>
            <Icon name="warning" size={14} />
            {n}
          </div>
        ))}
        <section className="sv-sec" aria-label={tr('assistant_SolvePanel.questions')}>
          <h4>{tr('assistant_SolvePanel.questions')}</h4>
          {wealthRow}
          {modeRow}
          {extraRows}
          {sitsLine}
          <div className="sv-row">
            <span>{tr('assistant_SolvePanel.cpu')}</span>
            {cpuSeg}
          </div>
          {cpuLine}
        </section>
        <button type="button" className="abtn quiet sv-add" onClick={() => setFull(true)}>
          <Icon name="edit" size={13} />
          
          {tr('assistant_SolvePanel.edit_everything')}
        </button>
        </>)}
        {showForm && full && (
          <button type="button" className="abtn quiet sv-add" onClick={() => setFull(false)}>
            
            {tr('assistant_SolvePanel.back_to_the_sentence')}
          </button>
        )}
        {showForm && full && (<>
        <section className="sv-sec" aria-label={tr('assistant_SolvePanel.goal')}>
          <h4>{tr('assistant_SolvePanel.goal')}</h4>
          <div className={'sv-row sv-wealth' + (form.wealth ? '' : ' need')}>
            <span>{tr('assistant_SolvePanel.how_rich_are_you')}</span>
            <Segmented ariaLabel={tr('assistant_SolvePanel.how_rich_are_you_2')} value={form.wealth} onChange={(v) => setForm((f) => withWealth(f, v))} options={WEALTH} />
            <span className="sv-sub">{form.wealth ? WEALTH_HINT[form.wealth] : tr('assistant_SolvePanel.required_sets_which_gear_the_solver')}</span>
          </div>
          <label className="sv-row">
            <span>{tr('assistant_SolvePanel.main_skill')}</span>
            <input className="input" list="sv-skills" value={form.skill} onChange={(e) => set('skill', e.target.value)} placeholder={tr('assistant_SolvePanel.any_active_skill_gem')} aria-label={tr('assistant_SolvePanel.main_skill')} />
            <datalist id="sv-skills">
              {skills.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <div className="sv-two">
            <label className="sv-row">
              <span>{tr('assistant_SolvePanel.class')}</span>
              <Select ariaLabel={tr('assistant_SolvePanel.class')} width="100%" value={form.className} onChange={(v) => set('className', v)} options={[{ value: '', label: tr('assistant_SolvePanel.solver_picks') }, ...CLASSES.map((c) => ({ value: c.name, label: c.name }))]} />
            </label>
            <label className="sv-row">
              <span>{tr('assistant_SolvePanel.ascendancy_2')}</span>
              <Select
                ariaLabel={tr('assistant_SolvePanel.ascendancy_2')}
                width="100%"
                value={form.ascendancy}
                onChange={(v) => set('ascendancy', v)}
                options={[{ value: '', label: tr('assistant_SolvePanel.solver_picks') }, ...CLASSES.flatMap((c) => c.ascendancies.map((x) => ({ value: x, label: x, hint: c.name })))]}
              />
            </label>
            <label className="sv-row">
              <span>{tr('assistant_SolvePanel.level')}</span>
              <input className="input" type="number" min={1} max={100} value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: Math.max(1, Math.min(100, Number(e.target.value) || 1)), levelOwn: true }))} aria-label={tr('assistant_SolvePanel.level')} />
            </label>
          </div>
        </section>

        <section className="sv-sec" aria-label={tr('assistant_SolvePanel.targets')}>
          <h4>{tr('assistant_SolvePanel.targets')}</h4>
          {form.targets.map((_, i) => targetRow(i))}
          {form.targets.length < 6 && (
            <button type="button" className="abtn quiet sv-add" onClick={() => set('targets', [...form.targets, { name: '', metric: 'life', value: '' }])}>
              <Icon name="plus" size={13} />
              
              {tr('assistant_SolvePanel.add_target')}
            </button>
          )}
        </section>

        <section className="sv-sec" aria-label={tr('assistant_SolvePanel.hard_limits')}>
          <h4>{tr('assistant_SolvePanel.hard_limits')}</h4>
          <div className="sv-sw">
            <Switch checked={form.resistsOn} onChange={(v) => set('resistsOn', v)} label={tr('assistant_SolvePanel.elemental_resistances')} />
            <span>{tr('assistant_SolvePanel.elemental_resistances_at_least')}</span>
            <input className="input sv-num" type="number" min={0} max={90} value={form.resists} disabled={!form.resistsOn} onChange={(e) => set('resists', Math.max(0, Math.min(90, Number(e.target.value) || 0)))} aria-label={tr('assistant_SolvePanel.resistance_limit')} />
            <span>%</span>
          </div>
          <div className="sv-sw">
            <Switch checked={form.poolOn} onChange={(v) => set('poolOn', v)} label={tr('assistant_SolvePanel.life_and_energy_shield')} />
            <span>{tr('assistant_SolvePanel.life_and_energy_shield_at_least')}</span>
            <input className="input sv-num wide" type="number" min={0} max={100000} step={500} value={form.pool} placeholder={form.wealth ? tr('assistant_SolvePanel.auto', { wealth: POOL_FLOOR[form.wealth] }) : 'auto'} disabled={!form.poolOn} onChange={(e) => set('pool', e.target.value === '' ? '' : Math.max(0, Math.min(100000, Number(e.target.value) || 0)))} aria-label={tr('assistant_SolvePanel.life_and_energy_shield_limit')} />
          </div>
          {(
            [
              ['attributes', tr('assistant_SolvePanel.attribute_and_level_requirements_met')],
              ['reservation', tr('assistant_SolvePanel.reservation_fits')],
              ['warnings', tr('assistant_SolvePanel.no_build_warnings')],
              ['cost', tr('assistant_SolvePanel.skill_cost_sustainable')],
            ] as const
          ).map(([k, label]) => (
            <div className="sv-sw" key={k}>
              <Switch checked={form[k]} onChange={(v) => set(k, v)} label={label} />
              <span>{label}</span>
            </div>
          ))}
        </section>

        <section className="sv-sec" aria-label={tr('h_c_Solve.item_rules')}>
          <h4>{tr('assistant_SolvePanel.items')}</h4>
          <div className="sv-chips" role="group" aria-label={tr('assistant_SolvePanel.allowed_rarities')}>
            {RARITIES.map((r) => (
              <button key={r} type="button" className={`sv-chip rar-${r}`} aria-pressed={form.items.rarities.includes(r)} onClick={() => set('items', { ...form.items, rarities: form.items.rarities.includes(r) ? form.items.rarities.filter((x) => x !== r) : [...form.items.rarities, r] })}>
                {cap(r)}
              </button>
            ))}
          </div>
          <label className="sv-row">
            <span>{tr('assistant_SolvePanel.must_use')}</span>
            <input className="input" value={form.items.mustUse.join(', ')} onChange={(e) => set('items', { ...form.items, mustUse: splitNames(e.target.value) })} placeholder={tr('assistant_SolvePanel.uniques_comma_separated')} aria-label={tr('assistant_SolvePanel.uniques_the_build_must_use')} />
          </label>
          <label className="sv-row">
            <span>{tr('assistant_SolvePanel.never_use')}</span>
            <input className="input" value={form.items.neverUse.join(', ')} onChange={(e) => set('items', { ...form.items, neverUse: splitNames(e.target.value) })} placeholder={tr('assistant_SolvePanel.uniques_comma_separated')} aria-label={tr('assistant_SolvePanel.uniques_the_build_must_never_use')} />
          </label>
          <div className="sv-row">
            <span>{tr('assistant_SolvePanel.crafted_rares')}</span>
            <Segmented
              ariaLabel={tr('assistant_SolvePanel.crafted_rare_rolls')}
              value={form.rolls}
              onChange={(v) => set('rolls', v)}
              options={[
                { value: 'typical', label: tr('assistant_SolvePanel.typical_rolls') },
                { value: 'perfect', label: tr('assistant_SolvePanel.perfect_rolls') },
              ]}
            />
          </div>
          <span className="sv-sub">{tr('assistant_SolvePanel.only_a_unique_in_these_slots')}</span>
          {uniqueSlots}
          <span className="sv-sub">{tr('assistant_SolvePanel.keep_these_slots_as_they_are')}</span>
          <div className="sv-chips" role="group" aria-label={tr('assistant_SolvePanel.slots_to_keep')}>
            {SLOTS.map((s) => (
              <button key={s} type="button" className="sv-chip" aria-pressed={form.items.lockSlots.includes(s)} onClick={() => set('items', { ...form.items, lockSlots: form.items.lockSlots.includes(s) ? form.items.lockSlots.filter((x) => x !== s) : [...form.items.lockSlots, s] })}>
                {form.items.lockSlots.includes(s) && <Icon name="lock" size={11} />}
                {label(s)}
              </button>
            ))}
          </div>
        </section>

        <section className="sv-sec" aria-label={tr('assistant_SolvePanel.run_settings')}>
          <div className="sv-sw">
            <Switch checked={form.assume} onChange={(v) => set('assume', v)} label={tr('assistant_SolvePanel.config_assumptions')} />
            <span>{tr('assistant_SolvePanel.assume_normal_uptime_flasks_charges_ailments')}</span>
          </div>
          <div className="sv-two">
            <label className="sv-row">
              <span>{tr('assistant_SolvePanel.time')}</span>
              <Select ariaLabel={tr('assistant_SolvePanel.time_budget')} width="100%" value={String(form.timeBudgetMs)} options={BUDGETS} onChange={(v) => set('timeBudgetMs', Number(v))} />
            </label>
            <div className="sv-row">
              <span>{tr('assistant_SolvePanel.cpu')}</span>
              {cpuSeg}
            </div>
          </div>
          {cpuLine}
        </section>
        </>)}

        {st && st.buildKey === build.id && <PlanList st={st} snap={snap} />}
        {st?.verdict && st.buildKey === build.id && (
          <div className="sv-note warn sv-verdict" role="status">
            <b>{tr('assistant_SolvePanel.not_reached_in_this_search')}</b>
            <span>{st.verdict.why}</span>
            {st.verdict.gaps.length > 0 && <span>{tr('assistant_SolvePanel.best_found')} {st.verdict.gaps.join(' · ')}</span>}
          </div>
        )}
        {(running || line || results.length > 0) && (
          <section className="sv-sec" aria-label={tr('assistant_SolvePanel.results')}>
            <h4>{tr('assistant_SolvePanel.results')}</h4>
            <div className={'sv-prog' + (st?.status === 'error' ? ' bad' : '')} role="status">
              {(running || shortlisting || stalled) && <span className="spin" />}
              {running && st ? <StatusLine st={st} snap={snap} /> : line}
            </div>
            {missed && (
              <button type="button" className="abtn sv-keep" onClick={keepImproving} title={tr('assistant_SolvePanel.solve_keep_tip')}>
                <Icon name="play" size={13} />
                {tr('assistant_SolvePanel.solve_keep_improving')}
              </button>
            )}
            {keptI >= 0 && <ResultRow key={`kept-${keptI}`} r={results[keptI]!} i={keptI} n={1} best={picks[0] === keptI} keptLabel={keptLabel} ladder={st?.startFrom?.ladder} a={a} configOn={form.configOn} onOffer={toggleOffer} />}
            {picked.length > 0 && (
              <>
                <ResultRow key={`p0-${picked[0]}`} r={results[picked[0]!]!} i={picked[0]!} n={keptI >= 0 ? 2 : 1} best={picks[0] !== keptI} running={running} keptLabel={keptLabel} ladder={st?.startFrom?.ladder} a={a} configOn={form.configOn} onOffer={toggleOffer} />
                {picked.length > 1 && <h4 className="sv-sub-h">{tr('assistant_SolvePanel.other_directions_compared_with_1')}</h4>}
                {picked.slice(1).map((pi, k) => (
                  <AltRow key={`p${k + 1}-${pi}`} r={results[pi]!} i={pi} n={k + (keptI >= 0 ? 3 : 2)} best={results[picked[0]!]!} tag={tagOf(results[pi]!, picked.map((x) => results[x]!))} running={running} a={a} configOn={form.configOn} onOffer={toggleOffer} />
                ))}
              </>
            )}
            {picks.length > 0 && rest.length > 0 && (
              <details className="sv-more">
                <summary>{tr('assistant_SolvePanel.other_results')}{rest.length})</summary>
                {rest.map(([r, i]) => (
                  <ResultRow key={`${i}-${r.label}-${r.score}`} r={r} i={i} lazy running={running} a={a} configOn={form.configOn} onOffer={toggleOffer} />
                ))}
              </details>
            )}
            {picks.length === 0 && results.map((r, i) => i === keptI ? null : (
              <ResultRow key={`${i}-${r.label}-${r.score}`} r={r} i={i} lazy={i > 0} running={running} keptLabel={keptLabel} ladder={st?.startFrom?.ladder} a={a} configOn={form.configOn} onOffer={toggleOffer} />
            ))}
            {snap?.assumptions && snap.assumptions.length > 0 && <div className="sv-assume">{tr('assistant_SolvePanel.assumed')} {snap.assumptions.join(' · ')}</div>}
          </section>
        )}
      </div>
      <div className="sv-foot">
        {!running && runBlock && (
          <span className="sv-why" role="status">
            {runBlock}
          </span>
        )}
        {running || stalled ? (
          <button type="button" className="abtn sv-run" onClick={stop}>
            <span className="stopglyph" />
            
            {tr('assistant_SolvePanel.stop')}
          </button>
        ) : (
          <button type="button" className="abtn primary sv-run" onClick={run} disabled={!!runBlock || shortlisting || !build.engine || build.engine.state !== 'ready'} title={runBlock || undefined}>
            <Icon name="play" size={14} />
            
            {tr('assistant_SolvePanel.run')}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- one trade-off build ------------------------------------------------------------------------------------------

/** The target metrics the sidebar's first tile stands for (not boss or clear DPS). */
const TILE_METRICS = ['dps', 'combined', 'hit', 'full'];
const DPS_METRICS = ['dps', 'combined', 'hit', 'dot', 'boss', 'full', 'minion', 'clear', 'bossdps'];
const val = (t: SolveResultSummary['targets'][number]) => t.shown ?? t.value;
const dpsOf = (r: SolveResultSummary) => { const t = r.targets.find((x) => DPS_METRICS.includes(x.metric)); return t ? val(t) : undefined; };
const ehpOf = (r: SolveResultSummary) => { const t = r.targets.find((x) => x.metric === 'ehp' || x.metric === 'pool'); return t ? val(t) : undefined; };

/** "-52% DPS" / "8.5x EHP": a ratio against #1, in x from double up. `good`: higher is better. */
function ratioDelta(v: number | undefined, base: number | undefined, word: string): { text: string; up: boolean } | null {
  if (v === undefined || base === undefined || !(base > 0)) return null;
  const q = v / base;
  if (Math.abs(q - 1) < 0.005) return { text: tr('assistant_SolvePanel.same', { word: word }), up: true };
  return { text: q >= 2 ? `${q.toFixed(1)}x ${word}` : `${q > 1 ? '+' : '-'}${Math.round(Math.abs(q - 1) * 100)}% ${word}`, up: q > 1 };
}

/** What the other directions give up or gain against #1, in the order DPS, EHP, cost. */
function deltasVs(r: SolveResultSummary, best: SolveResultSummary): Array<{ text: string; up: boolean }> {
  const out = [ratioDelta(dpsOf(r), dpsOf(best), 'DPS'), ratioDelta(ehpOf(r), ehpOf(best), 'EHP')];
  if (r.costDivines !== undefined && best.costDivines !== undefined) {
    const d = Math.round((r.costDivines - best.costDivines) * 10) / 10;
    out.push(d === 0 ? { text: tr('assistant_SolvePanel.same_cost'), up: true } : { text: tr(d < 0 ? 'h_c_Solve.div_cheaper' : 'h_c_Solve.div_dearer', { n: Math.abs(d) }), up: d < 0 });
  }
  return out.filter((x): x is { text: string; up: boolean } => !!x);
}

/** A short tag when this pick is the extreme of the shown picks on one thing. */
function tagOf(r: SolveResultSummary, picks: SolveResultSummary[]): string | null {
  const top = (f: (x: SolveResultSummary) => number | undefined, sign: 1 | -1) => {
    const vs = picks.map((p) => f(p)).filter((v): v is number => v !== undefined);
    const v = f(r);
    return v !== undefined && vs.length > 1 && vs.every((o) => sign * v >= sign * o) && vs.some((o) => o !== v);
  };
  if (top(ehpOf, 1)) return tr('assistant_SolvePanel.tankiest');
  if (top(dpsOf, 1)) return tr('assistant_SolvePanel.hits_hardest');
  if (top((x) => x.costDivines, -1)) return tr('assistant_SolvePanel.cheapest');
  return null;
}

const money = (d: number) => `${Math.round(d * 10) / 10} div`;

function LeadLine({ r }: { r: SolveResultSummary }) {
  const l = r.lead;
  if (!l) return null;
  return (
    <>
      <div className="sv-lead">
        <b>{l.weapon?.name ?? l.label}</b>{l.damage ? `, ${l.damage}` : ''}{l.crit ? ` ${tr('h_c_Solve.crit_suffix')}` : ''}
      </div>
      {(l.similar || (l.differs?.length ?? 0) > 0) && <div className="sv-diff">{[...(l.similar ? [tr('assistant_SolvePanel.close_to_1')] : []), ...(l.differs ?? [])].join(' · ')}</div>}
    </>
  );
}

/** One of the other directions: one line of numbers, the delta against #1, and Show full for the whole card. */
function AltRow({ r, i, n, best, tag, running, a, configOn, onOffer }: { r: SolveResultSummary; i: number; n: number; best: SolveResultSummary; tag: string | null; running: boolean; a: Assistant; configOn: string[]; onOffer: (key: string) => void }) {
  const [full, setFull] = useState(false);
  if (full) {
    return (
      <>
        <ResultRow r={r} i={i} n={n} running={running} a={a} configOn={configOn} onOffer={onOffer} />
        <button type="button" className="abtn quiet sv-add" onClick={() => setFull(false)}>{tr('assistant_SolvePanel.show_less')}</button>
      </>
    );
  }
  const dps = dpsOf(r), ehp = ehpOf(r);
  const nums = [dps !== undefined && `${compactNumber(dps)} DPS`, ehp !== undefined && `${compactNumber(ehp)} EHP`, r.costDivines !== undefined && money(r.costDivines)].filter(Boolean) as string[];
  const deltas = deltasVs(r, best);
  return (
    <div className="card sv-res sv-alt">
      <div className="sv-rh">
        <b>{n}</b>
        <span className="sv-who">
          {r.ascendancy ?? r.className}
          <i>{r.lead?.weapon?.name ?? r.label}</i>
        </span>
        <button type="button" className="abtn sm" onClick={() => setFull(true)} title={tr('assistant_SolvePanel.show_this_direction_in_full')}>{tr('assistant_SolvePanel.show_full')}</button>
      </div>
      <div className="sv-st">
        {nums.map((x) => <span key={x}>{x}</span>)}
        {tag && <u>{tag}</u>}
      </div>
      {deltas.length > 0 && (
        <div className="sv-tr">
          {deltas.map((d, k) => (
            <span key={k}>
              {k > 0 && ', '}
              <span className={d.up ? 'up' : 'dn'}>{d.text}</span>
            </span>
          ))}
        </div>
      )}
      {(r.lead?.similar || (r.lead?.differs?.length ?? 0) > 0) && <div className="sv-diff">{[...(r.lead?.similar ? [tr('assistant_SolvePanel.close_to_1')] : []), ...(r.lead?.differs ?? [])].join(' · ')}</div>}
    </div>
  );
}

const CHECK_ORDER = { hard: 0, soft: 1, chip: 2 } as const;
const CHECK_SHOWN = 5;
/** The soft items players keep track of; the result's badge counts these and every hard miss, the chips list them all. */

/** The basics a seasoned player expects that this result misses: hard ones first, the rest muted. Nothing shows when all are met. */
function CheckChips({ r }: { r: SolveResultSummary }) {
  const un = (r.checks ?? []).filter((c) => c.status === 'unmet').sort((a, b) => CHECK_ORDER[a.level] - CHECK_ORDER[b.level]);
  if (!un.length) return null;
  const shown = un.slice(0, CHECK_SHOWN);
  const rest = un.slice(CHECK_SHOWN);
  const tip = (c: (typeof un)[number]) => `${c.reason ?? c.label}${c.shown ? ` (${c.shown})` : ''}`;
  return (
    <div className="sv-chips sv-chk" role="list" aria-label={tr('assistant_SolvePanel.basics_this_build_misses')}>
      <span className="sv-chk-h">{tr('assistant_SolvePanel.missing')}</span>
      {shown.map((c) => (
        <span key={c.id} role="listitem" className={'sv-chip chk ' + c.level} title={tip(c)}>
          {c.level === 'hard' && <Icon name="error" size={11} />}
          {c.missing ?? c.label}
          {c.note && <small>{c.note}</small>}
        </span>
      ))}
      {rest.length > 0 && (
        <span role="listitem" className="sv-chip chk more" title={rest.map(tip).join('\n')}>
          +{rest.length}  {tr('assistant_SolvePanel.more')}
        </span>
      )}
    </div>
  );
}

const verdictOf = (v: AssessedCandidate['verdict']): { tone: 'ok' | 'warn' | 'bad'; text: string } =>
  ({
    ready: { tone: 'ok', text: tr('assistant_SolvePanel.verdict_ready') },
    fix: { tone: 'warn', text: tr('assistant_SolvePanel.verdict_fix') },
    objections: { tone: 'warn', text: tr('assistant_SolvePanel.verdict_needs_fixes') },
    notReady: { tone: 'bad', text: tr('assistant_SolvePanel.verdict_not_ready') },
    unresolved: { tone: 'warn', text: tr('assistant_SolvePanel.verdict_unresolved') },
  } as Record<AssessedCandidate['verdict'], { tone: 'ok' | 'warn' | 'bad'; text: string }>)[v];

/** The sidebar tile's name by its stat, in the app language (the shared rule's own labels are English fallbacks). */
const tileName = (stat: string, fallback: string): string =>
  ({ FullDPS: tr('assistant_SolvePanel.tile_full'), CombinedDPS: tr('assistant_SolvePanel.tile_combined'), TotalDPS: tr('assistant_SolvePanel.tile_hit'), 'Minion.CombinedDPS': tr('assistant_SolvePanel.tile_minion_combined'), 'Minion.TotalDPS': tr('assistant_SolvePanel.tile_minion_hit') } as Record<string, string>)[stat] ?? fallback;

/** Why the tile figure is above the tested single-target one, in words. '' when they match. */
function gapNote(g: ReturnType<typeof tileGap>): string {
  if (!g) return '';
  const parts = [g.cull ? tr('assistant_SolvePanel.gap_cull', { pct: g.cull }) : '', g.extraSkills ? tr('assistant_SolvePanel.gap_extra') : ''].filter(Boolean);
  return tr('assistant_SolvePanel.gap_higher', { parts: parts.join(tr('assistant_SolvePanel.gap_and')) });
}

/** The assessed record's verdict, what it needs, and the price of the kit (uniques only: crafted rares have no market price). Three states a player reads at a glance: ready, needs fixes (listed, Apply stays), not ready (the reason, no Apply). */
function AssessLine({ a }: { a: AssessedCandidate | undefined }) {
  if (!a) return <div className="sv-block">{tr('assistant_SolvePanel.checking_this_build')}</div>;
  const v = verdictOf(a.verdict);
  const { divines, coverage, unpriced } = a.price;
  const items = a.verdict === 'ready' ? [] : (a.verdict === 'notReady' ? a.findings.filter((f) => f.hard && !f.fix) : a.findings).map((f) => f.text);
  return (
    <>
      <div className="sv-block" data-verdict={a.verdict}>
        <span className={'sv-lim ' + v.tone}>
          <Icon name={v.tone === 'ok' ? 'check-circle' : 'warning'} size={12} />
          {v.text}
        </span>{' '}
        {a.verdict !== 'ready' && !items.length && a.why}
      </div>
      {items.slice(0, 6).map((t, k) => (
        <div key={k} className="sv-block sv-item">{t}</div>
      ))}
      {items.length > 6 && <div className="sv-block">{tr('assistant_SolvePanel.solve_and_more', { n: items.length - 6 })}</div>}
      {a.fixes.map((f) => (
        <div key={f.what} className="sv-block">{tr('assistant_SolvePanel.fix_line', { what: f.what })}{f.delta ? ` (${f.delta})` : ''}</div>
      ))}
      {a.notices?.map((t) => (
        <div key={t} className="sv-block sv-notice" data-notice>{tr('assistant_SolvePanel.notice_label')} {t}</div>
      ))}
      {coverage !== null && divines !== null && (
        <div className="sv-block" data-price>
          {tr('assistant_SolvePanel.price_line', { cost: divines < 0.1 ? tr('assistant_SolvePanel.price_under') : tr(divines === 1 ? 'assistant_SolvePanel.price_divine' : 'assistant_SolvePanel.price_divines', { value: divines }), pct: Math.round(coverage * 100), rest: unpriced.length ? tr('assistant_SolvePanel.price_none_for', { names: unpriced.join(', ') }) : '' })}
        </div>
      )}
    </>
  );
}

/** `running`: the solve is still going, so the row is a work in progress: no assessment, no Apply. `lazy`: not the top pick, assessed when the player opens it. */
export function ResultRow({ r, i, n, best = false, running = false, lazy = false, keptLabel, ladder, a, configOn = [], onOffer }: { r: SolveResultSummary; i: number; n?: number; best?: boolean; running?: boolean; lazy?: boolean; keptLabel?: string; ladder?: KeptLadder; a: Assistant; configOn?: string[]; onOffer?: (key: string) => void }) {
  const toast = useToast();
  const [details, setDetails] = useState<SolveDetails | null>(null);
  const [show, setShow] = useState<'open' | 'compare' | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useTreePreview();
  const previewId = `solve-${i}`;

  const load = async (): Promise<SolveDetails | null> => {
    if (details) return details;
    setBusy(true);
    const res = await window.pom.assistant.solveDetails(i);
    setBusy(false);
    if (!res.ok) {
      toast({ text: res.error, kind: 'error' });
      return null;
    }
    setDetails(res.value);
    return res.value;
  };
  // the headline is the sidebar's tile, so read it once the solve has ended, for the top pick (an assessment is dozens of engine calls)
  useEffect(() => {
    if (running || lazy) return;
    let live = true;
    const t = window.setTimeout(() => void window.pom.assistant.solveDetails(i).then((res) => { if (live && res.ok) setDetails(res.value); }), 600);
    return () => { live = false; window.clearTimeout(t); };
  }, [i, r.score, running, lazy]);
  const toggle = async (what: 'open' | 'compare') => {
    if (show === what) {
      setShow(null);
      if (what === 'open' && preview?.proposalId === previewId) setTreePreview(null);
      return;
    }
    const d = await load();
    if (!d) return;
    setShow(what);
    if (what === 'open' && (d.addedIds.length || d.removedIds.length)) {
      setTreePreview({ proposalId: previewId, title: tr('assistant_SolvePanel.result', { i: i + 1 }), removed: d.removedIds, added: d.addedIds });
      a.goTab('tree');
    }
  };
  const apply = async () => {
    // Apply takes the record the card was drawn from, never the list position (a re-sort moves it)
    const d = details ?? (await load());
    if (!d?.assessed) return;
    if (d.assessed.verdict === 'notReady') return toast({ text: d.assessed.why, kind: 'error' });
    setBusy(true);
    const res = await window.pom.assistant.solveCard(d.assessed.id);
    setBusy(false);
    if (!res.ok) return toast({ text: res.error, kind: 'error' });
    if (preview?.proposalId === previewId) setTreePreview(null);
    setCardId(res.value.id);
    a.apply(res.value.id);
  };

  // The card lives in the assistant thread; the row shows the same one, with its receipt and Undo.
  const msgs = a.thread.messages;
  const card: Proposal | undefined = cardId ? (msgs.find((m) => m.role === 'proposal' && m.proposal?.id === cardId)?.proposal ?? a.turn?.proposals.find((p) => p.id === cardId)) : undefined;
  const receipt = cardId ? msgs.find((m) => m.role === 'receipt' && m.proposal?.id === cardId) : undefined;
  const who = r.ascendancy ? `${r.ascendancy}` : r.className;
  const basicsMissing = (r.checks ?? []).filter((c) => c.status === 'unmet').length;
  const block = r.blocking ? (r.blocking.kind === 'limit' ? tr('assistant_SolvePanel.blocked_by', { name: r.blocking.name }) : tr('assistant_SolvePanel.short_of', { name: r.blocking.name })) : null;
  const below = r.belowStart ? r.targets.filter((t) => t.startValue != null && t.value < t.startValue).map((t) => tr('assistant_SolvePanel.yours', { name: t.name, value: compactNumber(t.value), startValue: compactNumber(t.startValue!) })) : [];

  return (
    <div className={'card sv-res' + (best ? ' best' : '')} data-lg="tile">
      <div className="sv-rh">
        <b>{n ?? i + 1}</b>
        <span className="sv-who">
          {r.start ? (keptLabel ?? tr('assistant_SolvePanel.your_build')) : who}
          {r.start ? <i>{who}</i> : r.ascendancy && <i>{r.className}</i>}
        </span>
        {best && <span className="sv-tag">{tr('assistant_SolvePanel.best')}</span>}
        <span className={'sv-lim ' + (!r.limitsMet ? 'bad' : basicsMissing ? 'warn' : 'ok')} title={r.limits.map((l) => `${l.name}: ${compactNumber(l.value)} / ${compactNumber(l.need)}${l.met ? '' : ` ${tr('h_c_Solve.not_met_suffix')}`}`).join('\n')}>
          <Icon name={r.limitsMet ? 'check-circle' : 'error'} size={12} />
          {r.limitsMet ? (basicsMissing ? tr(basicsMissing === 1 ? 'h_c_Solve.limits_met_basics' : 'h_c_Solve.limits_met_basics_n', { n: basicsMissing }) : tr('h_c_Solve.limits_met')) : tr(r.limits.filter((l) => !l.met).length === 1 ? 'h_c_Solve.limit_not_met' : 'h_c_Solve.limits_not_met', { n: r.limits.filter((l) => !l.met).length })}
        </span>
      </div>
      <LeadLine r={r} />
      <div className="sv-tg">
        {r.targets.map((t) => {
          const tested = t.shown ?? t.value;
          const tile = details?.tile && TILE_METRICS.includes(t.metric) && details.tile.value > 0 ? details.tile : null;
          const note = tile ? gapNote(tileGap(tile, tested)) : '';
          const tName = tile ? tileName(tile.stat, tile.label) : '';
          const moved = !tile && t.shown !== undefined && Math.abs(t.shown - t.value) > Math.max(1, Math.abs(t.value) * 0.005);
          return (
            <span
              key={t.name}
              className={t.met ? 'met' : ''}
              title={tile ? tr('assistant_SolvePanel.tile_tip', { label: tName, value: compactNumber(tile.value), tested: compactNumber(tested), note: note ? ' ' + note : '' }) : moved ? tr('assistant_SolvePanel.the_sidebar_shows_once_applied_the', { shown: compactNumber(t.shown!), value: compactNumber(t.value) }) : undefined}
            >
              <em>{tile ? tName : t.name}</em>
              {compactNumber(tile ? tile.value : tested)}
              {t.target !== null && <small> / {compactNumber(t.target)}</small>}
              {tile && note && <small> · {tr('assistant_SolvePanel.tile_tested', { value: compactNumber(tested) })} {note}</small>}
            </span>
          );
        })}
        {r.lead && r.costDivines !== undefined && !r.start && (
          <span>
            <em>{tr('assistant_SolvePanel.cost')}</em>
            {money(r.costDivines)}
          </span>
        )}
      </div>
      {block &&<div className="sv-block">{block}</div>}
      {r.start && keptGaps(ladder, r.targets).map((g) => <div key={g.name} className="sv-block">{tr('assistant_SolvePanel.kept_gap', { count: g.count, asked: compactNumber(g.asked), name: g.name, median: compactNumber(g.median), best: compactNumber(g.best) })}</div>)}
      {below.length > 0 && <div className="sv-block">{tr('assistant_SolvePanel.below_your_build')} {below.join(', ')}</div>}
      {r.honest?.flagged && <div className="sv-block">{r.honest.text}</div>}
      {running ? <div className="sv-block sv-wip" data-verdict="running">{askPercent(r) === null ? tr('assistant_SolvePanel.solve_in_progress') : tr('assistant_SolvePanel.solve_in_progress_pct', { pct: askPercent(r) })}</div> : (details?.assessed || !lazy) && <AssessLine a={details?.assessed} />}
      <CheckChips r={r} />
      {((r.configOn?.length ?? 0) > 0 || (r.offers?.length ?? 0) > 0 || (r.bossChips?.length ?? 0) > 0) && (
        <div className="sv-chips sv-cfg" role="group" aria-label={tr('assistant_SolvePanel.config_switches_of_result', { i: i + 1 })}>
          {r.bossChips?.map((c) => (
            <span key={c} className="sv-chip on boss-oneshot" title={r.bossBreakdown ?? undefined}>
              <Icon name="warning" size={11} />
              {c}
            </span>
          ))}
          {r.configOn?.map((c) => (
            <span key={c.key} className="sv-chip on" title={c.reason}>
              <Icon name="check" size={11} />
              {c.label}
            </span>
          ))}
          {r.offers?.map((o) => {
            const taken = configOn.includes(o.key);
            return (
              <button key={o.key} type="button" className="sv-chip offer" aria-pressed={taken} disabled={!onOffer} onClick={() => onOffer?.(o.key)} title={taken ? tr('assistant_SolvePanel.on_for_the_next_run_tap') : tr('assistant_SolvePanel.left_off_tap_to_turn_it', { reason: o.reason })}>
                {taken && <Icon name="check" size={11} />}
                {o.label}
                <small>{o.text}</small>
              </button>
            );
          })}
        </div>
      )}
      {!card && show === 'open' && details && (
        <div className="sv-layers">
          {details.layers.length ? details.layers.map((l) => <div key={l.layer}>{l.text}</div>) : <div>{tr('assistant_SolvePanel.same_build_as_the_open_one')}</div>}
        </div>
      )}
      {!card && show === 'compare' && details && <StatTable changes={details.changes} />}
      {card ? (
        <ChangeCard
          p={card}
          {...(receipt ? { receipt } : {})}
          canUndo={a.undoable.includes(card.id)}
          lost={a.lost.includes(card.id)}
          applying={a.applying === card.id}
          busy={a.busy}
          onApply={() => a.apply(card.id)}
          onUndo={() => a.undo(card.id)}
          onView={() => a.goTab('tree')}
        />
      ) : (
        <div className="actions">
          <button type="button" className="abtn" aria-pressed={show === 'open'} disabled={busy} onClick={() => void toggle('open')} title={tr('assistant_SolvePanel.what_this_build_changes_per_layer')}>
            <Icon name="eye" size={13} />
            
            {tr('assistant_SolvePanel.open')}
          </button>
          <button type="button" className="abtn" aria-pressed={show === 'compare'} disabled={busy} onClick={() => void toggle('compare')} title={tr('assistant_SolvePanel.stat_changes_against_the_open_build')}>
            <Icon name="compare" size={13} />
            
            {tr('assistant_SolvePanel.compare')}
          </button>
          {!running && details?.assessed?.verdict !== 'notReady' && <button type="button" className="abtn primary" disabled={busy || a.applying !== null} onClick={() => void apply()} title={tr('assistant_SolvePanel.puts_this_whole_build_on_the')}>
            {busy ? <span className="spin" style={{ width: 12, height: 12 }} /> : <Icon name="check" size={13} />}
            {r.lead ? tr('assistant_SolvePanel.apply_to_build') : tr('assistant_SolvePanel.apply')}
          </button>}
        </div>
      )}
    </div>
  );
}
