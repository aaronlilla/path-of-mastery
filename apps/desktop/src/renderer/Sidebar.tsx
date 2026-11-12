// The stats sidebar of the build workspace: main skill and socket group pickers, the two pinned tiles, upstream's
// display stats in the design's five sections, and the warnings pill.
import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import { useDeltas, type DeltaStore } from './deltaStore';
import { flushSync } from 'react-dom';
import { useAppSettings } from './appSettings';
import type { StatScalar } from '@pom/protocol';
import { buildSidebar, DEFAULT_NUMBER_FORMAT, formatNumSep, minionDisplayStats, normaliseOutput, sFormat, type GroupId, type NumberFormat, type SidebarRow } from './displayStats';
import type { ColorName } from './displayStatsTypes';
import type { EngineBuild } from './engineBuild';
import { PortalMenu, Icon } from './ui';
import { artFor } from './gameArt';
import { gemColour, useGameInfo } from './gameData';
import { compactNumber, railShort } from './format';
import type { SocketGroupInfo } from './buildSkills';
import type { EngineHandle } from './engineHandle';
import { SidebarSkillControls } from './SidebarSkillControls';
import { useMainSkillView } from './useMainSkillView';
import { StatExplain, type TipTarget } from './StatExplain';
import { useAltHeld } from './tipFrame';
import { moveGroup, orderedGroups, pinClick, readPins } from '../shared/statLayout.js';
import { dragSection } from './statDrag';
import { dpsTile as dpsTileOf } from '../shared/dpsTile';
import { pctChange, previewCall, usePreview, usePreviewStats } from './preview/preview';
import { previewEngine, pvWaitText } from './preview/pvResult';
import { fromMain, label, tr } from './i18n';

const COLOR_VAR: Record<ColorName, string> = {
  LIFE: 'var(--pool-life)', MANA: 'var(--pool-mana)', ES: 'var(--pool-es)', WARD: 'var(--pool-ward)', RAGE: 'var(--pool-rage)',
  STRENGTH: 'var(--attr-str)', DEXTERITY: 'var(--attr-dex)', INTELLIGENCE: 'var(--attr-int)',
  FIRE: 'var(--dmg-fire)', COLD: 'var(--dmg-cold)', LIGHTNING: 'var(--dmg-lightning)', CHAOS: 'var(--dmg-chaos)', PHYS: 'var(--dmg-physical)',
  EVASION: 'var(--stat-evasion)', RARE: 'var(--rarity-rare)', CURRENCY: 'var(--gold-currency)',
};

const GROUPS: Array<{ id: GroupId; name: string; tone: string; icon: string }> = [
  { id: 'minion', name: 'MINION', tone: 'var(--stat-dps)', icon: 'dps' },
  { id: 'off', name: 'OFFENCE', tone: 'var(--stat-dps)', icon: 'dps' },
  { id: 'attr', name: 'ATTRIBUTES', tone: 'var(--stat-neutral)', icon: 'user' },
  { id: 'hit', name: 'MAX HIT', tone: 'var(--stat-armour)', icon: 'shield' },
  { id: 'pools', name: 'POOLS & DEFENCES', tone: 'var(--pool-life)', icon: 'ehp' },
  { id: 'res', name: 'RESISTANCES', tone: 'var(--dmg-cold)', icon: 'resist' },
];

const ICONS: Array<[RegExp, string, string]> = [
  [/Fire/, 'fire', 'var(--dmg-fire)'], [/Cold/, 'cold', 'var(--dmg-cold)'], [/Lightning/, 'lightning', 'var(--dmg-lightning)'], [/Chaos/, 'chaos', 'var(--dmg-chaos)'],
  [/Phys/, 'physical', 'var(--dmg-physical)'], [/^Str/, 'attr-str', 'var(--attr-str)'], [/^Dex/, 'attr-dex', 'var(--attr-dex)'], [/^Int/, 'attr-int', 'var(--attr-int)'],
  [/Energy Shield|^ES\b/, 'energy-shield', 'var(--pool-es)'], [/Life/, 'life', 'var(--pool-life)'], [/Mana/, 'mana', 'var(--pool-mana)'], [/Ward/, 'ward', 'var(--pool-ward)'],
  [/Armour/, 'armour', 'var(--stat-armour)'], [/Evasion|Evade/, 'evasion', 'var(--stat-evasion)'], [/Block/, 'block', 'var(--stat-block)'], [/Suppress/, 'suppress', 'var(--stat-block)'],
  [/Crit/, 'crit', 'var(--stat-crit)'], [/DPS/, 'dps', 'var(--stat-dps)'], [/Rate|Speed/, 'speed', 'var(--stat-speed)'], [/Hit Chance|Accuracy/, 'accuracy', 'var(--stat-accuracy)'],
  [/Average/, 'melee', 'var(--stat-damage)'],
];

export interface SidebarProps {
  eng: EngineBuild;
  /** Why the engine cannot calculate this build at all (shown instead of the waiting note). */
  unavailable?: string;
  fmt: NumberFormat;
  /** Hover preview: stat id -> [before, after]. */
  deltas: DeltaStore;
  groups: SocketGroupInfo[];
  mainGroup: number;
  mainActive: number;
  onMainGroup(n: number): void;
  onMainActive(group: number, n: number): void;
  extraWarnings: string[];
  onOpenSkills(): void;
  /** The build text and the engine session: the main skill's part, stage, mine and minion controls edit it. */
  xml: string;
  engine: EngineHandle | null;
  /** Under 1024 px the sidebar is a 52 px rail; its stats button opens the full sidebar as a drawer. */
  drawer: boolean;
  onDrawer(open: boolean): void;
  /** The build's tabs, shown as icons on the rail. */
  nav?: { tab: string; onTab(t: string): void };
  /** The saved order of the stat sections and the two pinned stats (the settings), and how to save a change. */
  statOrder: string[];
  pinnedStats: string[];
  onPatchSettings(patch: { statOrder?: string[]; pinnedStats?: string[] }): void;
}

function deltaText(row: SidebarRow, d: [StatScalar, StatScalar] | undefined, fmt: NumberFormat): { text: string; good: boolean } | null {
  if (!d || typeof d[0] !== 'number' || typeof d[1] !== 'number') return null;
  const diff = d[1] - d[0];
  if (Math.abs(diff) < 0.001) return null;
  // Big changes read as whole numbers ("+1,163"), small ones keep one decimal, as upstream's comparison lines do.
  const places = Math.abs(diff) >= 100 || !/[.,]\d/.test(row.text.replace(/,(\d{3})/g, '$1')) ? 0 : 1;
  const body = formatNumSep(sFormat(places > 0 ? '+.1f' : '+d', diff).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), fmt);
  const better = row.lowerIsBetter ? diff < 0 : diff > 0;
  return { text: body, good: better };
}

/** A socket group's name: its main skill in the gem's attribute colour, then its supports. */
function GroupName({ g, info }: { g: SocketGroupInfo; info: ReturnType<typeof useGameInfo> }) {
  if (g.labelled || !g.activeName) return <>{g.summary || tr('Sidebar.group_index', { index: g.index })}</>;
  return (
    <>
      <span style={{ color: gemColour(info, g.activeName) }}>{g.activeName}</span>
      {g.supports > 0 && <span style={{ color: 'var(--text-3)' }}> {tr('Sidebar.supports_n', { count: g.supports })}</span>}
    </>
  );
}

/** One stat row. Memoised: an edit changes a handful of rows, and the rest keep their DOM. */
interface ExplainCtl {
  enter(row: SidebarRow, el: HTMLElement, now?: boolean): void;
  leave(): void;
  click(row: SidebarRow): void;
}

/** Preview on: the live number under a row ("3.29: 48,222.2") and the change, '' when the number is the same. */
interface PvLine { live: string; chg: string; good: boolean }

const Row = memo(function Row({ r, d, fmt, ex, pv }: { r: SidebarRow; d: [StatScalar, StatScalar] | undefined; fmt: NumberFormat; ex: ExplainCtl; pv?: PvLine }) {
  const ic = ICONS.find(([re]) => re.test(r.label));
  const dt = deltaText(r, d, fmt);
  const lc = r.warn ? 'var(--negative-text)' : r.color ? COLOR_VAR[r.color] : 'var(--text-2)';
  return (
    <div
      className="sb-row"
      role="button"
      tabIndex={0}
      title={tr('Sidebar.click_to_show_label_at', { label: label(r.label) })}
      aria-label={tr('Sidebar.label_text_suffix_press_enter', { label: label(r.label), text: r.text, suffix: r.suffix ? ' (' + label(r.suffix) + ')' : '' })}
      onMouseEnter={(e) => ex.enter(r, e.currentTarget)}
      onMouseLeave={ex.leave}
      onFocus={(e) => ex.enter(r, e.currentTarget, true)}
      onBlur={ex.leave}
      onClick={() => ex.click(r)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ex.click(r);
        }
      }}
    >
      <span className="lbl" style={{ color: lc }}>
        {ic ? <Icon name={ic[1]} size={12} style={{ color: ic[2] }} /> : <span style={{ width: 12 }} />}
        <span className="ellipsis">{label(r.label).slice(0, -3)}<span style={{ whiteSpace: 'nowrap' }}>{label(r.label).slice(-3)}:</span></span>
      </span>
      <span className="val">
        <span style={{ color: r.negative ? 'var(--negative-text)' : r.muted ? 'var(--text-faint)' : 'var(--text-strong)' }}>{r.text}</span>
        {r.suffix && <span className="suffix">({label(r.suffix)})</span>}
        {dt && <span className={'delta ' + (dt.good ? 'up' : 'down')}>{dt.text}</span>}
      </span>
      {pv && pv.chg && (
        <>
          <span className="pv-live">{pv.live}</span>
          <span className={'pv-chg ' + (pv.good ? 'up' : 'down')}>{pv.chg}</span>
        </>
      )}
      {r.sub?.map((x, i) => <span key={i} className="sub">{x.startsWith('from ') ? tr('displayStats.from', { source: x.slice(5) }) : x}</span>)}
    </div>
  );
}, (a, b) => a.d === b.d && a.fmt === b.fmt && a.r.text === b.r.text && a.r.label === b.r.label && a.r.negative === b.r.negative && a.r.muted === b.r.muted && a.r.suffix === b.r.suffix && a.r.warn === b.r.warn && a.r.group === b.r.group && a.r.stat === b.r.stat && (a.r.sub?.join('|') ?? '') === (b.r.sub?.join('|') ?? '') && a.ex === b.ex && a.pv?.live === b.pv?.live && a.pv?.chg === b.pv?.chg);

/** The tabs on the rail, in the design's order: a divider after Config and after Notes. */
const RAIL_NAV: Array<{ id: string; label: string; icon: string; key?: string; sep?: boolean }> = [
  { id: 'tree', label: tr('Sidebar.tree'), icon: 'tree', key: 'Ctrl Alt 1' },
  { id: 'skills', label: tr('Sidebar.skills'), icon: 'gem', key: 'Ctrl Alt 2' },
  { id: 'items', label: tr('Sidebar.items'), icon: 'items', key: 'Ctrl Alt 3' },
  { id: 'calcs', label: tr('Sidebar.calcs'), icon: 'Σ', key: 'Ctrl Alt 4' },
  { id: 'fight', label: tr('h_f_Tabs.fight'), icon: 'timer' },
  { id: 'config', label: tr('Sidebar.configuration'), icon: 'sliders', key: 'Ctrl Alt 5' },
  { id: 'import', label: tr('Sidebar.import_export'), icon: 'arrow-up-down', sep: true },
  { id: 'notes', label: tr('Sidebar.notes'), icon: 'note', key: 'Ctrl Alt 8' },
  { id: 'party', label: tr('Sidebar.party'), icon: 'users', key: 'Ctrl Alt 7', sep: true },
  { id: 'compare', label: tr('Sidebar.compare'), icon: 'compare', key: 'Ctrl Alt 6' },
];

/**
 * The 52 px rail the sidebar becomes in a narrow window (design: Build Tree Frame, `xs`): the tabs as icons, then the two
 * headline numbers as one button that opens the full sidebar as a drawer beside the rail.
 */
function Rail({ open, onDrawer, tiles, nav }: { open: boolean; onDrawer(o: boolean): void; tiles: Array<{ label: string; text: string; exact: string }>; nav?: SidebarProps['nav'] }) {
  return (
    <div className="sb-rail">
      {nav && (
        <div className="sb-rail-nav">
          {RAIL_NAV.map((t) => (
            <Fragment key={t.id}>
              {t.sep && <span className="sep" />}
              <button type="button" className="sb-rail-tab" aria-current={nav.tab === t.id ? 'page' : undefined} aria-label={t.label} title={t.key ? `${t.label} (${t.key})` : t.label} onClick={() => { onDrawer(false); nav.onTab(t.id); }}>
                {t.icon === 'Σ' ? <span className="sigma">{tr('Sidebar.text')}</span> : <Icon name={t.icon} size={16} />}
              </button>
            </Fragment>
          ))}
        </div>
      )}
      <button type="button" className="sb-rail-btn" aria-label={open ? tr('Sidebar.hide_the_stats') : tr('Sidebar.show_the_stats')} aria-expanded={open} title={tiles.map((t) => `${t.label}: ${t.exact}`).join(' · ') || (open ? tr('Sidebar.hide_the_stats_esc') : tr('Sidebar.show_the_stats'))} onClick={() => onDrawer(!open)}>
        {tiles.map((t, i) => (
          <span key={i} className={'sb-rail-tile' + (i === 1 ? ' alt' : '')}>
            <span className="k">{t.label.replace(/^COMBINED /, '').replace(/ DPS$/, '')}</span>
            <span className="v">{railShort(t.text)}</span>
          </span>
        ))}
      </button>
    </div>
  );
}

/** The skill's message lines (`mainSkill.infoMessage`) in upstream's custom colour, `infoMessage2` grey below them. */
function InfoLines(p: { lines?: string[]; dim?: string | null }) {
  if (!p.lines?.length) return null;
  return (
    <div className="sb-info" style={{ textAlign: 'center', fontSize: 12, lineHeight: 1.5, padding: '4px 8px' }}>
      {p.lines.map((l, i) => (
        <div key={i} style={{ color: 'var(--gold-text)' }}>{l}</div>
      ))}
      {p.dim ? <div style={{ color: 'var(--text-muted)' }}>{p.dim}</div> : null}
    </div>
  );
}

/** Upstream's "Skill disabled:" heading with the reason under it (Build.lua RefreshStatList), shown when the main skill is disabled. */
function DisabledLines(p: { reason?: string | null }) {
  if (!p.reason) return null;
  return (
    <div className="sb-disabled" style={{ textAlign: 'center', fontSize: 12, lineHeight: 1.5, padding: '4px 8px' }}>
      <div style={{ color: 'var(--text-muted)' }}>{tr('Sidebar.skill_disabled')}</div>
      <div style={{ color: 'var(--negative-text)' }}>{p.reason}</div>
    </div>
  );
}

export function Sidebar(p: SidebarProps) {
  const deltas = useDeltas(p.deltas);
  const { eng } = p;
  const info = useGameInfo();
  const showWarnings = useAppSettings().buildWarnings;
  const skillView = useMainSkillView(p.xml, eng.buildId, p.mainGroup, p.mainActive, eng.ready);
  // Next-league preview on: the preview engine's numbers are the ones shown, the live ones go under them.
  const pv = usePreview();
  const { stats: pvStats, state: pvState } = usePreviewStats(p.xml, pv.on && eng.ready);
  // Until the preview numbers for this very build are in, show a waiting note, never the live ones under the preview tag.
  const pvWait = pv.on && eng.ready && pvState !== 'ready';
  // The explain tooltips read the same engine as the numbers beside them.
  const explainEngine = useMemo(() => (p.engine && pv.on ? previewEngine(p.engine, p.xml, previewCall) : p.engine), [p.engine, p.xml, pv.on]);
  const shown = pv.on && pvStats ? pvStats : eng.stats;
  const liveModel = useMemo(() => (eng.ready && !pvWait ? buildSidebar(shown, eng.flags, p.fmt) : null), [eng.ready, pvWait, shown, eng.flags, p.fmt]);
  // While a new build loads, keep showing the last numbers instead of tearing the rows down for a few frames.
  const lastModel = useRef<typeof liveModel>(null);
  if (liveModel) lastModel.current = liveModel;
  const model = liveModel ?? (eng.error || p.unavailable || pvWait ? null : lastModel.current);
  // The skill beside those numbers is held the same way, so its name and info lines do not blank out while the build loads.
  const lastSkill = useRef<typeof eng.skill>(null);
  const lastShown = useRef(shown);
  if (liveModel) lastShown.current = shown;
  if (liveModel) lastSkill.current = eng.skill;
  const skillNow = liveModel ? eng.skill : model ? lastSkill.current : null;
  const liveBy = useMemo(() => {
    if (!eng.ready || shown === eng.stats) return null;
    const m = new Map<string, SidebarRow>();
    for (const r of buildSidebar(eng.stats, eng.flags, p.fmt).rows) if (!m.has(r.key)) m.set(r.key, r);
    return m;
  }, [eng.ready, shown, eng.stats, eng.flags, p.fmt]);
  const pvLine = (r: SidebarRow): PvLine | undefined => {
    const l = liveBy?.get(r.key);
    if (!l) return undefined;
    if (l.text === r.text) return { live: '', chg: '', good: true };
    const c = pctChange(r.value, l.value, r.lowerIsBetter);
    return { live: `${pv.live}: ${l.text}`, chg: c?.text ?? 'changed', good: c?.good ?? true };
  };
  // "Minion:" above "Player:" when the main skill is a minion skill (Build.lua RefreshStatList): the minion's output with
  // the minion list and the minion skill's flags.
  const minionModel = useMemo(() => {
    const out = shown.Minion;
    if (!eng.ready || !out || typeof out !== 'object') return null;
    const m = buildSidebar(normaliseOutput(out as Record<string, unknown>), new Set(eng.skill?.minion?.flags ?? []), p.fmt, minionDisplayStats, 'minion');
    return { ...m, rows: m.rows.map((r) => ({ ...r, key: 'minion:' + r.key })) };
  }, [eng.ready, shown, eng.skill, p.fmt]);
  const lastMinion = useRef<typeof minionModel>(null);
  if (liveModel) lastMinion.current = minionModel;
  const minionShown = liveModel ? minionModel : lastMinion.current;
  // The two pinned stats and the section order are saved with the settings; a local copy answers at once.
  const [pins, setPins] = useState<[string, string]>(() => readPins(p.pinnedStats));
  const [order, setOrder] = useState<string[]>(() => orderedGroups(p.statOrder, GROUPS.map((g) => g.id)));
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setPins(readPins(p.pinnedStats)), [p.pinnedStats]);
  useEffect(() => setOrder(orderedGroups(p.statOrder, GROUPS.map((g) => g.id))), [p.statOrder]);
  const [pinOpen, setPinOpen] = useState<0 | 1 | null>(null);
  const [pinQ, setPinQ] = useState('');
  const [skillOpen, setSkillOpen] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  // The explain tooltip: shown after a short rest on a row (at once when moving between rows) or on keyboard focus;
  // Alt, a click or Enter opens the full breakdown; Escape closes.
  const [tip, setTip] = useState<TipTarget | null>(null);
  const alt = useAltHeld(!!tip);
  const tipRef = useRef(tip);
  tipRef.current = tip;
  const altRef = useRef(false);
  altRef.current = alt;
  const timers = useRef({ enter: 0, leave: 0, last: 0 });
  const clickRef = useRef<(row: SidebarRow) => void>(() => {});
  const ex = useMemo<ExplainCtl>(() => {
    const show = (row: SidebarRow, el: HTMLElement, pinned: boolean) => {
      const card = (el.closest('.bw-side') ?? el).getBoundingClientRect();
      setTip({ row, cell: el.getBoundingClientRect(), card, pinned });
    };
    return {
      enter(row, el, now) {
        window.clearTimeout(timers.current.leave);
        if (tipRef.current?.pinned) return;
        window.clearTimeout(timers.current.enter);
        if (now || tipRef.current || Date.now() - timers.current.last < 300) show(row, el, false);
        else timers.current.enter = window.setTimeout(() => show(row, el, false), 350);
      },
      leave() {
        window.clearTimeout(timers.current.enter);
        if (tipRef.current?.pinned) return;
        // One pending hide at a time: a second call used to overwrite the handle, so moving onto the card (onKeep)
        // cancelled only the last of several timers and the full breakdown closed under the pointer.
        window.clearTimeout(timers.current.leave);
        timers.current.leave = window.setTimeout(() => {
          timers.current.leave = 0;
          timers.current.last = Date.now();
          setTip(null);
        }, 120);
      },
      click(row) {
        clickRef.current(row);
      },
    };
  }, []);
  useEffect(() => {
    // Always listening (not only while a card shows): a blur or a hidden page also cancels a card still waiting on its
    // hover delay, so none can appear afterwards without the pointer.
    const stop = () => {
      window.clearTimeout(timers.current.enter);
      window.clearTimeout(timers.current.leave);
      if (tipRef.current && !tipRef.current.pinned && !altRef.current) {
        setTip(null);
      }
    };
    const vis = () => { if (document.visibilityState === 'hidden') stop(); };
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  useEffect(() => {
    if (!tip) return;
    const kd = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setTip(null);
      }
    };
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.sb-row, [data-bd]')) hide();
    };
    // The hover card is a tooltip: it goes as soon as the pointer is anywhere but a stat row (a missed mouseleave, the
    // pointer leaving the window), when the window loses focus or is hidden, and on any click elsewhere (a tab, the top
    // bar). It used to stay up over the top bar until Escape when its mouseleave never came.
    const hide = () => {
      window.clearTimeout(timers.current.enter);
      window.clearTimeout(timers.current.leave);
      timers.current.last = Date.now();
      setTip(null);
    };
    const move = (e: PointerEvent) => {
      if (!tipRef.current || tipRef.current.pinned) return;
      if ((e.target as HTMLElement | null)?.closest?.('.sb-row, [data-bd]')) {
        window.clearTimeout(timers.current.leave);
        timers.current.leave = 0;
      } else if (!timers.current.leave) ex.leave();
    };
    // The pointer leaving the window hides the hover card, not the full breakdown Alt holds open.
    const out = (e: MouseEvent) => { if (!e.relatedTarget && !tipRef.current?.pinned && !altRef.current) hide(); };
    window.addEventListener('keydown', kd, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    document.addEventListener('mouseout', out, true);
    return () => {
      window.removeEventListener('keydown', kd, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      document.removeEventListener('mouseout', out, true);
    };
  }, [!!tip]);
  const tile0 = useRef<HTMLDivElement>(null);
  const tile1 = useRef<HTMLDivElement>(null);
  const bigRef = useRef<HTMLDivElement>(null);
  const skillBtn = useRef<HTMLDivElement>(null);
  const warnBtn = useRef<HTMLButtonElement>(null);

  if (!model) {
    return (
      <>
      <Rail open={p.drawer} onDrawer={p.onDrawer} nav={p.nav} tiles={[{ label: tr('Sidebar.dps'), text: '…', exact: '' }, { label: tr('Sidebar.ehp'), text: '…', exact: '' }]} />
      <div className="pad scroll-y sb-full" style={{ flex: 1, minHeight: 0 }}>
        <div className="big">
          <div className="stat-tile"><div className="k">{tr('Sidebar.full_dps')}</div><div className="v">…</div></div>
          <div className="stat-tile alt"><div className="k">{tr('Sidebar.ehp')}</div><div className="v">…</div></div>
        </div>
        <div className="side-note">{eng.error ? tr('Sidebar.the_engine_could_not_calculate', { error: eng.error }) : pvWait ? pvWaitText(pvState) : p.unavailable ? tr('Sidebar.this_build_cannot_be_calculated', { unavailable: p.unavailable }) : tr('Sidebar.calculating_this_build_with_the')}</div>
      </div>
      </>
    );
  }

  const by = new Map<string, SidebarRow>();
  const pinLabel = (id: string) => (id.startsWith('Minion.') ? label('MINION') + ' ' + label(minionBy.get(id.slice(7))?.label ?? id.slice(7)) : label(by.get(id)?.label ?? id)).toUpperCase();
  for (const r of model.rows) if (!by.has(r.stat)) by.set(r.stat, r);
  const minionBy = new Map<string, SidebarRow>();
  for (const r of minionShown?.rows ?? []) if (!minionBy.has(r.stat)) minionBy.set(r.stat, r);
  const stat = (id: string) => (liveModel ? shown : lastShown.current)[id] as number | undefined;
  const dpsTile = (() => {
    const t = dpsTileOf((id) => (id.startsWith('Minion.') ? minionBy.get(id.slice(7))?.value : stat(id)));
    const names: Record<string, string> = { FullDPS: tr('Sidebar.full_dps'), CombinedDPS: tr('Sidebar.combined_dps'), TotalDPS: tr('Sidebar.hit_dps'), 'Minion.CombinedDPS': tr('Sidebar.minion_combined_dps'), 'Minion.TotalDPS': tr('Sidebar.minion_hit_dps') };
    return { id: t.id, label: names[t.id] ?? t.label };
  })();
  const tiles = [
    pins[0] ? { id: pins[0], label: pinLabel(pins[0]) } : dpsTile,
    pins[1] ? { id: pins[1], label: pinLabel(pins[1]) } : { id: 'TotalEHP', label: tr('Sidebar.ehp') },
  ];
  const showFlash = (gid: string) => {
    setFlash(gid);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 900);
  };
  // Clicking a stat shows it in the right tile (a stat already in a tile only lights up its section).
  clickRef.current = (row) => {
    const id = row.key.startsWith('minion:') ? 'Minion.' + row.stat : row.stat;
    const r = pinClick(pins, [tiles[0]!.id, tiles[1]!.id], id);
    if (r.changed) {
      setPins(r.pins);
      p.onPatchSettings({ pinnedStats: r.pins });
    }
    showFlash(row.group);
  };
  const saveOrder = (ids: string[]) => {
    setOrder(ids);
    p.onPatchSettings({ statOrder: ids });
  };
  const defaultOrder = GROUPS.map((g) => g.id);
  // A tile is a headline: big numbers read compact (3.12M, 19.1k) with the exact value in its tooltip, the same for a
  // pinned stat that has no row of its own (Combined DPS when it is hidden from the list).
  const tileValue = (id: string) => {
    const minion = id.startsWith('Minion.');
    const r = minion ? minionBy.get(id.slice(7)) : by.get(id);
    const v = r ? r.value : minion ? undefined : stat(id);
    if (typeof v !== 'number' || !Number.isFinite(v)) return r ?? null;
    const exact = formatNumSep(sFormat(Math.abs(v) >= 100 ? '.0f' : '.2f', v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), p.fmt);
    const text = Math.abs(v) >= 1e4 ? formatNumSep(compactNumber(v), p.fmt) : r ? r.text : exact;
    return { ...(r ?? {}), text, value: v, exact: r ? r.text : exact } as Pick<SidebarRow, 'text' | 'value'> & { exact: string };
  };
  const savePin = (i: 0 | 1, id: string | null) => {
    const next: [string, string] = [...pins];
    next[i] = id ?? '';
    setPins(next);
    p.onPatchSettings({ pinnedStats: next });
    setPinOpen(null);
  };

  const warnings = showWarnings ? [...p.extraWarnings, ...(minionShown?.warnings ?? []), ...model.warnings].filter((w, i, all) => all.indexOf(w) === i).map((w) => fromMain('sidebar_warnings', w)) : [];
  const shownRows = minionShown ? [...minionShown.rows, ...model.rows] : model.rows;
  const grp = p.groups[p.mainGroup - 1];
  const mainName = skillNow?.name ?? grp?.activeName ?? '';
  const q = pinQ.trim().toLowerCase();
  const pinList = model.rows.filter((r) => !q || r.label.toLowerCase().includes(q));

  const railTiles = tiles.map((t) => {
    const v = tileValue(t.id);
    return { label: t.label, text: v ? ('exact' in v ? v.text : v.text) : '–', exact: v && 'exact' in v ? (v as { exact: string }).exact : v?.text ?? '' };
  });
  return (
    <>
      <Rail open={p.drawer} onDrawer={p.onDrawer} nav={p.nav} tiles={railTiles} />
      <div className="sb-full">
      <div style={{ padding: '10px 10px 0', display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }}>
        <div ref={skillBtn} className="sb-pick" role="button" tabIndex={0} title={tr('Sidebar.main_skill_and_socket_group') + (grp && grp.actives.length <= 1 && grp.actives[0]?.level ? ` · ${grp.actives[0].level}/${grp.actives[0].quality ?? 0}` : '')} onClick={() => setSkillOpen((v) => !v)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setSkillOpen((v) => !v)}>
          <span className="gem">{mainName && artFor(mainName, 'gems') ? <img src={artFor(mainName, 'gems')} alt="" /> : null}</span>
          <span className="txt">
            <span className="cap">{grp ? tr('Sidebar.main_skill_touppercase_link_l', { value: grp.slot ? label(grp.slot).toUpperCase() + ' ' : '', link: grp.link }) : tr('Sidebar.main_skill')}</span>
            <span className="nm" title={grp?.summary}>{grp ? <GroupName g={grp} info={info} /> : tr('Sidebar.no_skills_yet_add_in')}</span>
          </span>
          <Icon name="chevron-down" size={12} />
        </div>
        <PortalMenu anchor={skillBtn} open={skillOpen} onClose={() => setSkillOpen(false)} label={tr('Sidebar.socket_groups')} minWidth={280}>
          {p.groups.length === 0 && <div className="menu-empty">{tr('Sidebar.no_socket_groups_yet')}</div>}
          {p.groups.map((g) => (
            <button key={g.index} type="button" role="menuitemradio" aria-checked={g.index === p.mainGroup} className="menu-item" onClick={() => { p.onMainGroup(g.index); setSkillOpen(false); }}>
              <span className="grow ellipsis" title={g.summary}><GroupName g={g} info={info} /></span>
              <span className="meta">{tr('Sidebar.link_l', { link: g.link })}</span>
              <span className="sb-ck">{g.index === p.mainGroup && <Icon name="check" size={14} style={{ color: 'var(--gold-text)' }} />}</span>
            </button>
          ))}
          <button type="button" className="menu-item" onClick={() => { setSkillOpen(false); p.onOpenSkills(); }}>
            <Icon name="gem" size={14} />
            <span className="grow">{tr('Sidebar.edit_in_skills')}</span>
          </button>
        </PortalMenu>
        {grp && grp.actives.length > 1 && (
          <label className="sb-skill">
            <i style={{ background: gemColour(info, mainName), boxShadow: `0 0 8px ${gemColour(info, mainName)}` }} />
            <select aria-label={tr('Sidebar.active_skill_of_the_main')} value={p.mainActive} onChange={(e) => p.onMainActive(p.mainGroup, Number(e.target.value))}>
              {grp.actives.map((a) => (
                <option key={a.index} value={a.index} style={{ color: gemColour(info, a.name) }}>{a.name}{a.level ? ` (${a.level}/${a.quality ?? 0})` : ''}</option>
              ))}
            </select>
          </label>
        )}
        <SidebarSkillControls xml={p.xml} engine={p.engine} view={skillView.view} gem={skillView.gem} mainGroup={p.mainGroup} />
      </div>

      <div className="big" ref={bigRef} style={{ padding: '8px 10px 6px', position: 'relative' }}>
        {([0, 1] as const).map((i) => {
          const t = tiles[i]!;
          const v = tileValue(t.id);
          const d = v && 'stat' in v ? deltaText(v as SidebarRow, deltas?.[t.id], p.fmt) : null;
          return (
            <div key={i} ref={i === 0 ? tile0 : tile1} className={'stat-tile' + (i === 1 ? ' alt' : '')} role="button" tabIndex={0} title={tr('h_rb_Side.tile_tip', { label: t.label, value: v && 'exact' in v ? (v as { exact: string }).exact : v?.text ?? '' })} onClick={() => { setPinQ(''); setPinOpen(pinOpen === i ? null : i); }} onKeyDown={(e) => e.key === 'Enter' && setPinOpen(i)} style={{ cursor: 'pointer', position: 'relative' }}>
              <div className="k" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 0 }}>
                <span className="ellipsis">{t.label}</span>
                <Icon name="chevron-down" size={12} style={{ opacity: 0.7, transform: pinOpen === i ? 'rotate(180deg)' : undefined }} />
              </div>
              <div className="v" style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span className="ellipsis">{v ? v.text : '—'}</span>
                {d && <span className={'delta ' + (d.good ? 'up' : 'down')}>{d.text}</span>}
              </div>
              {liveBy && v && (() => {
                const lv = (t.id.startsWith('Minion.') ? undefined : eng.stats[t.id]) as number | undefined;
                if (typeof lv !== 'number') return null;
                const c = pctChange(v.value, lv, 'lowerIsBetter' in v ? (v as SidebarRow).lowerIsBetter : false);
                const was = Math.abs(lv) >= 1e4 ? formatNumSep(compactNumber(lv), p.fmt) : formatNumSep(sFormat(Math.abs(lv) >= 100 ? '.0f' : '.2f', lv).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), p.fmt);
                return c ? <span className="pv-tile"><span className={c.good ? 'up' : 'down'}>{c.text}</span> <span className="from">{tr('Sidebar.from_was', { was })}</span></span> : null;
              })()}
            </div>
          );
        })}
        <PortalMenu anchor={bigRef} open={pinOpen !== null} onClose={() => setPinOpen(null)} label={tr('Sidebar.pinned_stat')} minWidth={300}>
          <div className="pin-head">
            <button type="button" onClick={() => savePin(pinOpen ?? 0, null)}><Icon name="reset" size={13} />{tr('Sidebar.reset_to_default')}</button>
          </div>
          <div className="pin-search"><Icon name="search" size={15} /><input autoFocus value={pinQ} onChange={(e) => setPinQ(e.target.value)} placeholder={tr('Sidebar.search_stats')} aria-label={tr('Sidebar.search_stats')} /></div>
          <div className="pin-list">
            {pinList.map((r) => (
              <button key={r.key} type="button" className="menu-item" onClick={() => savePin(pinOpen ?? 0, r.stat)}>
                <span className="grow ellipsis">{label(r.label)}</span>
                <span style={{ color: 'var(--text-strong)', fontVariantNumeric: 'tabular-nums' }}>{r.text}</span>
              </button>
            ))}
            {pinList.length === 0 && <div className="menu-empty">{tr('Sidebar.no_stats_match_pinq', { pinQ })}</div>}
          </div>
        </PortalMenu>
      </div>

      {order.join() !== defaultOrder.join() && (
        <button type="button" className="sb-reset-order" onClick={() => saveOrder(defaultOrder)}>
          <Icon name="reset" size={13} style={{ opacity: 0.85 }} />{tr('Sidebar.reset_section_order')}
        </button>
      )}
      <div className="sb-list scroll-y" ref={listRef}>
        {shownRows.length === 0 && <div className="side-note">{tr('Sidebar.this_build_has_no_numbers')}</div>}
        <InfoLines lines={skillNow?.info} dim={skillNow?.info2} />
        <DisabledLines reason={skillNow?.disableReason} />
        {order.map((gid) => {
          const g = GROUPS.find((x) => x.id === gid)!;
          const rows = shownRows.filter((r) => r.group === g.id);
          if (!rows.length) return null;
          const lit = flash === g.id;
          return (
            <div key={g.id} className="sb-group" data-gid={g.id} style={{ background: `color-mix(in oklab, ${g.tone} ${lit ? 16 : 6}%, transparent)`, boxShadow: lit ? '0 0 0 1px rgba(var(--accent-rgb),.45),0 0 22px -6px rgba(var(--accent-rgb),.5)' : 'none' }}>
              <div
                className="sb-gh"
                tabIndex={0}
                title={tr('Sidebar.drag_to_reorder_alt')}
                aria-label={tr('Sidebar.name_section_drag_to_reorder', { name: label(g.name) })}
                onPointerDown={(e) => {
                  if (listRef.current) dragSection(e, g.id, listRef.current, (ids) => {
                    // every section the list shows, in the new order, followed by the ones that have no rows now
                    const shown = new Set(ids);
                    flushSync(() => saveOrder([...ids, ...order.filter((x) => !shown.has(x))]));
                    showFlash(g.id);
                  });
                }}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    const vis = order.filter((x) => shownRows.some((r) => r.group === x));
                    const moved = moveGroup(vis, g.id, e.key === 'ArrowUp' ? -1 : 1);
                    saveOrder([...moved, ...order.filter((x) => !moved.includes(x))]);
                    showFlash(g.id);
                  }
                }}
              >
                <Icon name="grip" size={8} style={{ flex: 'none' }} />
                <Icon name={g.icon} size={11} style={{ color: g.tone, opacity: 0.9 }} />
                <span>{label(g.name)}</span>
                <i style={{ background: `linear-gradient(90deg, color-mix(in oklab, ${g.tone} 35%, transparent), transparent)` }} />
              </div>
              {g.id === 'minion' && <InfoLines lines={skillNow?.minion?.info} dim={skillNow?.minion?.info2} />}
              {rows.map((r) => (
                <Row key={r.key} r={r} d={g.id === 'minion' ? undefined : deltas?.[r.stat]} fmt={p.fmt} ex={ex} pv={g.id === 'minion' ? undefined : pvLine(r)} />
              ))}
            </div>
          );
        })}
      </div>

      {tip && <StatExplain target={tip} engine={explainEngine} xml={p.xml} fmt={p.fmt} alt={alt} mainSkill={skillNow?.name} onClose={() => setTip(null)} onKeep={() => window.clearTimeout(timers.current.leave)} onLeave={ex.leave} />}
      {warnings.length > 0 && (
        <>
          <button ref={warnBtn} type="button" className="sb-warn" title={warnings.join('\n')} aria-expanded={warnOpen} onClick={() => setWarnOpen((v) => !v)}>
            <i />
            <span className="n">{tr('Sidebar.count_warnings', { count: warnings.length })}</span>
          </button>
          <PortalMenu anchor={warnBtn} open={warnOpen} onClose={() => setWarnOpen(false)} label={tr('Sidebar.warnings')} minWidth={300} className="menu-wrap">
            {warnings.map((w) => (
              <div key={w} className="sb-warn-row"><i />{w}</div>
            ))}
          </PortalMenu>
        </>
      )}
      </div>
    </>
  );
}

export { DEFAULT_NUMBER_FORMAT };
