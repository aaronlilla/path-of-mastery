import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useDeferredValue, useLayoutEffect } from 'react';
import { getAppSettings } from './appSettings';
import type { BuildEdit, GemInfo, GroupSpec, SkillGem, SkillGroup, SkillsState, SkillSlotInfo } from '@pom/protocol';
import { appendedGroupIndex, ATTR, defaultGemLevel, dpsColour, formatGemPower, GEM_LEVEL_MODES, gemRowLook, gemWikiUrl, groupToText, matchColourOrder, matchSummary, openingGroup, optimisedSockets, optimiseWanted, gemListed, gemVersions, groupWarnings, searchGems, skillIdOf, socketColour, SORT_FIELDS, SUPPORT_TYPES, textToGroup, type PickerFilter } from '../shared/skillsLogic';
import { pickerView, scoreGems, type GemScores, type PickerView, type RankPass } from '../shared/gemRanking';
import { readItems, setItemText } from '../shared/itemsXml';
import { engineCall, type EngineHandle } from './engineHandle';
import { gemArt, gemFrame, slotIcon, socketIcon } from './gameArt';
import { setSockets } from './items/itemText';
import { Over } from './items/dialogs';
import { NameDialog } from './skills/SetsDialog';
import { SetsPopover } from './SetsPopover';
import { loadItemInfo, useSkillTips, type SkillTip, type TipBind, type TipSeg } from './skills/skillTips';
import type { OpenBuild } from './types';
import { Dialog, Icon, PortalMenu, Switch, useDismiss, useToast } from './ui';
import { useDelayedFlag } from './delayedFlag';
import { requestAssistant, useHighlight } from './assistant/bus';
import './skillsTab.css';
import { noteText, notesFor, usePreview } from './preview/preview';
import './preview/preview.css';
import { fromMain, label, tr } from './i18n';

/** A new gem's quality: the build's own default when it has one, else the Default gem quality of Settings. */
const newGemQuality = (buildDefault: number | undefined): number => buildDefault || getAppSettings().defaultGemQuality;

export interface SkillsTabProps {
  build: OpenBuild;
  engine: EngineHandle | null;
}

const MATCH_Q = 10;
/** A group row draws this many socket dots, then "+N", so a group of fifteen gems leaves room for its name. */
const MAX_DOTS = 8;
const PICKER_ROWS = 40;
/** Tab width from which the ranked gem list is docked as a third column instead of a dropdown under the blank row. */
const DOCK_MIN = 1000;

/** After the selected group is scrolled into sight, no group row is left cut in half at the top edge of the scroll area:
 *  scroll up to show the cut row whole when the selected row still fits, else down past it. */
function alignListTop(selRow: HTMLElement): void {
  let sc: HTMLElement | null = selRow.parentElement;
  while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  if (!sc || sc.scrollTop <= 0) return;
  const box = sc.getBoundingClientRect();
  const top = box.top + sc.clientTop;
  const bottom = top + sc.clientHeight;
  const rows = Array.from(selRow.parentElement?.querySelectorAll<HTMLElement>('.sk-grow') ?? []);
  const cut = rows.find((r) => {
    const b = r.getBoundingClientRect();
    return b.top < top - 1 && b.bottom > top + 1;
  });
  if (!cut) return;
  const c = cut.getBoundingClientRect();
  const s = selRow.getBoundingClientRect();
  if (s.bottom + (top - c.top) <= bottom) sc.scrollTop -= top - c.top;
  else sc.scrollTop += c.bottom - top;
}

const SORT_LABEL = Object.fromEntries(SORT_FIELDS.map((f) => [f.value, label(f.label)]));

/** A gem icon that falls back to the plain coloured frame when the art has no file for the name. */
function GemImg({ name, colour, size = 22 }: { name: string; colour: SkillGem['colour']; size?: number }) {
  return <img className="sk-gem-img" src={gemArt(name, colour)} alt="" width={size} height={size} />;
}

/** `− 20 +` box: the number can be typed too; it is applied on Enter or when the box loses focus. */
function Stepper({ value, min, max, onChange, label, fg, title, tip }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string; fg?: string; title?: string; tip?: TipBind }) {
  const [draft, setDraft] = useState<string | null>(null);
  const esc = useRef(false); // Escape blurs the box, and blur would commit the draft the closure still holds
  const commit = () => {
    if (esc.current) { esc.current = false; setDraft(null); return; }
    if (draft == null) return;
    const n = Math.round(Number(draft));
    setDraft(null);
    if (Number.isFinite(n) && draft.trim() !== '') {
      const c = Math.max(min, Math.min(max, n));
      if (c !== value) onChange(c);
    }
  };
  return (
    <div className="sk-step" {...tip}>
      <button type="button" aria-label={tr('SkillsTab.lower_label', { label })} onClick={() => value > min && onChange(value - 1)}>
        <Icon name="minus" size={12} />
      </button>
      <input
        value={draft ?? String(value)}
        title={title}
        aria-label={label}
        inputMode="numeric"
        style={{ color: fg ?? 'var(--text-strong)' }}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            esc.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <button type="button" aria-label={tr('SkillsTab.raise_label', { label })} onClick={() => value < max && onChange(value + 1)}>
        <Icon name="plus" size={12} />
      </button>
    </div>
  );
}

/** A gem table number cell, as in upstream: type the number, or step it with the arrow keys or the wheel. Applied on
 *  Enter, Tab or when it loses focus; one tab stop per cell, so Tab walks name, level, quality, next name. */
function NumCell({ value, min, max, onChange, label, fg, title, tip }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string; fg?: string; title?: string; tip?: TipBind }) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const esc = useRef(false); // Escape blurs the box, and blur would commit the draft the closure still holds
  const commit = () => {
    if (esc.current) { esc.current = false; setDraft(null); return; }
    if (draft == null) return;
    const n = Math.round(Number(draft));
    setDraft(null);
    if (Number.isFinite(n) && draft.trim() !== '' && clamp(n) !== value) onChange(clamp(n));
  };
  const step = (d: number) => {
    const cur = draft != null && draft.trim() !== '' && Number.isFinite(Number(draft)) ? Number(draft) : value;
    setDraft(String(clamp(cur + d)));
  };
  return (
    <span className="sk-num" {...tip}>
      <input
        value={draft ?? String(value)}
        title={title}
        aria-label={label}
        inputMode="numeric"
        style={{ color: fg ?? 'var(--text-strong)' }}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onWheel={(e) => {
          if (document.activeElement !== e.currentTarget) return;
          step(e.deltaY < 0 ? 1 : -1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            step((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 1));
          } else if (e.key === 'Escape') {
            esc.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </span>
  );
}

/** Resolves with the promise's value, or null when it fails or does not answer in time. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => window.setTimeout(() => r(null), ms))]);
}

function leadGem(g: SkillGroup): SkillGem | null {
  const f = g.gems[0];
  if (!f) return null;
  if (!f.support) return f;
  return g.gems.find((x) => !x.support) ?? f;
}

/** The name the list shows: upstream's label, or the gem names for a group with no active skill ("<No active skills>"). */
function groupName(g: SkillGroup): string {
  if (g.displayLabel === '<No active skills>') return g.gems.length ? g.gems.map((x) => x.nameSpec).join(', ') : tr('SkillsTab.new_group');
  return g.displayLabel || tr('SkillsTab.new_group');
}

function groupSub(g: SkillGroup): string {
  if (g.source) return tr('h_rb_Sk.from_src', { src: g.sourceName || g.source });
  if (!g.enabled) return tr('SkillsTab_2.off');
  const sup = g.gems.filter((x) => x.support).length;
  if (sup) return tr(sup === 1 ? 'h_rb_Sk.support_one' : 'h_rb_Sk.support_many', { n: sup });
  return g.gems.length ? '' : tr('SkillsTab.empty_add_an_active_skill');
}

/** Upstream's usage tips under the group list. */
const USAGE_TIPS: SkillTip = {
  notes: [tr('h_rb_Sk.u_title'), tr('h_rb_Sk.u_copy'), tr('h_rb_Sk.u_toggle'), tr('h_rb_Sk.u_fulldps'), tr('h_rb_Sk.u_main'), tr('h_rb_Sk.u_f1')],
};
const SLOT_NOTE: SkillTip = { notes: [tr('SkillsTab.select_the_item_in_which'), tr('SkillsTab.this_will_allow_the_skill')] };
const lvlText = (s?: string) => (s === undefined ? s : fromMain('skills_texts', s));
const GEM_NOTE = [tr('SkillsTab.note_count_integer_value_scales'), tr('SkillsTab.to_be_used_with_totems'), tr('h_rb_Sk.gem_note3')];

/** `AddSocketGroupTooltip`: the group's status, its source, its active skills and each gem with the level and quality the calculation uses. */
function groupTip(g: SkillGroup, isMain: boolean): TipSeg[][] {
  const out: TipSeg[][] = [];
  const status: string[] = [];
  if (isMain) status.push(g.enabled ? tr('SkillsTab.main_skill_active') : tr('SkillsTab.main_skill_forced_active'));
  if (!g.enabled) status.push(tr('SkillsTab_2.disabled'));
  if (g.includeInFullDPS) status.push(tr('SkillsTab_2.included_in_full_dps'));
  if (status.length) out.push([{ t: status.join(' · '), c: 'var(--text-2)' }]);
  if (g.source) out.push([{ t: tr('h_rb_Sk.source_lbl') + ' ', c: 'var(--text-2)' }, { t: g.sourceName || g.source, c: 'var(--rarity-unique, #af6025)' }]);
  if (g.enabled && g.slotInactive) out.push([{ t: tr('SkillsTab.note_this_group_is_disabled'), c: 'var(--text-2)' }]);
  if (out.length) out.push([]);
  g.activeSkills.forEach((a, i) => {
    out.push([{ t: tr('SkillsTab.active_skill_v1', { value: i + 1 }), c: 'var(--text-2)' }, { t: a.name, c: gemColourOf(g, a.gem) }]);
  });
  if (g.activeSkills.length) out.push([]);
  for (const x of g.gems) {
    const lv: TipSeg[] = [{ t: ` ${x.level}` }];
    if (x.effectiveLevel > x.level) lv.push({ t: `+${x.effectiveLevel - x.level}`, c: 'var(--mod-magic, #8888ff)' });
    lv.push({ t: `/${x.quality}` });
    if (x.effectiveQuality > x.quality) lv.push({ t: `+${x.effectiveQuality - x.quality}`, c: 'var(--mod-magic, #8888ff)' });
    const why = x.inactiveReason ? ' ' + x.inactiveReason : x.enabled ? '' : ' ' + tr('h_rb_Sk.gem_disabled');
    out.push([{ t: x.nameSpec, c: ATTR[x.colour].text }, ...lv, ...(why ? [{ t: why, c: 'var(--text-muted)' }] : [])]);
  }
  if (!g.gems.length) out.push([{ t: tr('SkillsTab.empty_group'), c: 'var(--text-muted)' }]);
  return out;
}

function gemColourOf(g: SkillGroup, gemIndex: number): string {
  const x = g.gems[gemIndex - 1];
  return x ? ATTR[x.colour].text : 'var(--text-2)';
}

type Menu = null | 'set' | 'manage' | 'slot' | 'imbued' | 'sortBy' | 'lvl';

export function SkillsTab({ build, engine }: SkillsTabProps) {
  // Next-league preview on: a gem the patch notes change gets the preview ring and its note lines.
  const pv = usePreview();
  const pvMark = (name: string) => {
    const notes = pv.on ? notesFor(pv.info, 'gem', name) : null;
    return notes && pv.info ? { 'data-pv-changed': '', title: tr('h_rb_Sk.pv_note', { next: pv.next, notes: notes.map((n) => noteText(pv.info!, n)).join(' · ') }) } : {};
  };
  const toast = useToast();
  const [gems, setGems] = useState<GemInfo[]>([]);
  const [state, setState] = useState<SkillsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [q, setQ] = useState('');
  const [qMode, setQMode] = useState<string | null>(null);
  const [qHi, setQHi] = useState(0);
  const [kind, setKind] = useState<'S' | 'A' | null>(null);
  // Gem defaults start folded: the group list gets the column's height (set once, rarely changed).
  const [defOpen, setDefOpen] = useState(() => {
    try {
      return localStorage.getItem('pom-gemdef-open2') === '1';
    } catch {
      return true;
    }
  });
  const [dlg, setDlg] = useState<null | 'all' | 'sets' | 'new'>(null);
  const [setsPop, setSetsPop] = useState(false);
  const tips = useSkillTips(engine, build.xml);
  const [undoBar, setUndoBar] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null);
  // The picker's DPS ranking: the last finished pass per group (kept while a newer one runs) and the pass in progress.
  const passes = useRef(new Map<string, RankPass>());
  const partial = useRef(new Map<string, GemScores>());
  const [ranking, setRanking] = useState<{ key: string; done: number; total: number } | null>(null);
  const [, setPassTick] = useState(0);
  const clip = useRef<string>('');
  const clipSystem = useRef(true);
  const addRef = useRef<HTMLInputElement>(null);
  const rowInput = useRef<HTMLInputElement>(null);
  const setBtn = useRef<HTMLButtonElement>(null);
  const manageBtn = useRef<HTMLButtonElement>(null);
  const slotBtn = useRef<HTMLButtonElement>(null);
  const imbBtn = useRef<HTMLButtonElement>(null);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const lvlBtn = useRef<HTMLButtonElement>(null);
  const addBox = useRef<HTMLDivElement>(null);
  const rowBox = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const undoTimer = useRef<number>(0);
  // A wide tab docks the ranked gem list as a third column, always open for the selected group.
  const rootRef = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const fit = () => setDocked(el.clientWidth >= DOCK_MIN);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // The root is drawn once the state is read (the placeholders before it have no root).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!state]);
  // The group's settings sit in a drawer at the foot of the editor, shut until the bar is pressed.
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerBar = useRef<HTMLButtonElement>(null);
  const drawerPanel = useRef<HTMLDivElement>(null);
  const drawerWas = useRef(false);
  const edScroll = useRef<HTMLDivElement>(null);
  // Open, the drawer covers the foot of the gem list: the rows fade out just above its top edge instead of being cut in half.
  useEffect(() => {
    const list = edScroll.current;
    const panel = drawerPanel.current;
    if (!list) return;
    if (!drawer || !panel) {
      list.style.maskImage = '';
      return;
    }
    const fade = () => {
      const dh = Math.max(0, list.getBoundingClientRect().bottom - panel.getBoundingClientRect().top);
      list.style.maskImage = `linear-gradient(to bottom, #000 calc(100% - ${dh + 22}px), transparent calc(100% - ${dh}px))`;
    };
    fade();
    const t = window.setTimeout(fade, 180); // after the slide-in
    const ro = new ResizeObserver(fade);
    ro.observe(panel);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
      list.style.maskImage = '';
    };
  }, [drawer, sel, docked]);
  // A press inside one of the drawer's dropdowns (drawn outside it) is not an outside press; Escape reaches the top layer first.
  useDismiss(drawerRef, drawer, useCallback(() => { if (!document.querySelector('.menu.portal')) setDrawer(false); }, []));
  useEffect(() => {
    const panel = drawerPanel.current;
    const at = document.activeElement;
    if (drawer) panel?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true });
    else if (drawerWas.current && (!at || at === document.body || panel?.contains(at))) drawerBar.current?.focus({ preventScroll: true });
    drawerWas.current = drawer;
  }, [drawer]);
  useEffect(() => setDrawer(false), [sel]);
  // A new group puts the caret in its blank gem row once the editor for it is on screen.
  const focusAdd = useRef(false);
  const version = engine?.version ?? 0;
  const buildId = engine?.buildId ?? null;

  // ---- data ----------------------------------------------------------------------------------
  useEffect(() => {
    let live = true;
    engineCall('gemCatalog', {})
      .then((r) => live && setGems(r.gems))
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!engine) return;
    let live = true;
    engine
      .call('skillsState')
      .then((r) => {
        if (!live) return;
        setError(null);
        setState(r.state);
      })
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId, version]);

  useEffect(() => {
    return () => {
      window.clearTimeout(undoTimer.current);
    };
  }, []);

  const groups = state?.groups ?? [];
  // A group just added is selected once the state that holds it has arrived, so the editor never shows an empty frame in between.
  const pendingSel = useRef<number | null>(null);
  const groupCount = useRef(0);
  groupCount.current = groups.length;
  // Keep the selection on a real group; the main skill's group is selected when the tab opens or the set changes.
  // Layout effects, so the frame painted when the state arrives already has its group: never a "Select a socket group" frame.
  useLayoutEffect(() => {
    if (!state) return;
    // Read and clear the pending selection here, not in the updater: StrictMode runs updaters twice.
    const want = pendingSel.current;
    const taken = want != null && want <= groups.length ? want : null;
    if (taken != null || !groups.length) pendingSel.current = null;
    setSel((s) => {
      if (!groups.length) return null;
      if (taken != null) return taken;
      if (s == null) return openingGroup(state.mainGroup, groups.length);
      return Math.min(s, groups.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  // A selection sent back to nothing (set switched, groups deleted) lands on the main skill's group once the state is there.
  useLayoutEffect(() => {
    if (sel == null && state && state.groups.length) setSel(openingGroup(state.mainGroup, state.groups.length));
  }, [sel, state]);

  const opts = state?.options;
  /** The "Reading the skills…" placeholder only for a slow read: a fast one goes straight to the content, no placeholder frames. */
  const slowRead = useDelayedFlag(!state || !opts, 200);
  const group = sel != null ? groups[sel - 1] ?? null : null;
  // The assistant changed or points at a gem: open its group (0 means the last one) and mark the row.
  const hl = useHighlight();
  const hlAt = hl?.tab === 'skills' && hl.gem && groups.length ? { group: hl.gem.group || groups.length, gem: hl.gem.gem } : null;
  useEffect(() => {
    if (hlAt) setSel(hlAt.group);
  }, [hl?.key, groups.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const gemById = useMemo(() => new Map(gems.map((g) => [g.id, g])), [gems]);
  const slotMap = useMemo(() => new Map((state?.slots ?? []).map((s) => [s.slot, s])), [state]);
  const characterLevel = build.info.level || 1;

  const apply = useCallback(
    async (edit: BuildEdit, keepBar = false) => {
      if (!engine) return false;
      if (!keepBar) setUndoBar(null);
      try {
        const r = await engine.edit(edit);
        return !r.blocked;
      } catch (e) {
        toast({ text: tr('SkillsTab.the_change_could_not_be', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
        return false;
      }
    },
    [engine, toast],
  );

  // ---- socket facts ----------------------------------------------------------------------------
  /** Item sockets the group's gems sit in: the item's sockets from where earlier groups in the same slot stop. */
  const socketsFor = useCallback(
    (g: SkillGroup): { item: SkillSlotInfo['item']; sockets: string[] } => {
      const slot = g.slot ? slotMap.get(g.slot) : undefined;
      const item = slot?.item;
      if (!item || g.source) return { item, sockets: [] };
      let offset = 0;
      for (const o of groups) {
        if (o === g) break;
        if (o.slot === g.slot && !o.source) offset += o.gems.length;
      }
      return { item, sockets: item.sockets.slice(offset) };
    },
    [groups, slotMap],
  );

  // ---- group actions ---------------------------------------------------------------------------
  const newGroup = useCallback(
    async (spec?: GroupSpec) => {
      // Upstream adds a new or pasted group at the end of the list.
      const at = appendedGroupIndex(groups);
      const ok = await apply({ kind: 'addGroup', at: groups.length + 1, group: spec ?? { enabled: true } });
      if (ok) {
        if (at <= groupCount.current) setSel(at);
        else pendingSel.current = at;
        setQ('');
        setQMode(null);
        if (!spec) focusAdd.current = true;
      }
    },
    [apply, groups],
  );

  const flashUndo = (msg: string) => {
    setUndoBar(msg);
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoBar(null), 6000);
  };

  const deleteGroup = useCallback(async () => {
    if (!group || sel == null) return;
    if (group.source) {
      toast({ text: tr('SkillsTab.this_socket_group_cannot_be'), kind: 'info' });
      return;
    }
    const name = groupName(group);
    if (await apply({ kind: 'removeGroup', group: sel }, true)) flashUndo(tr('h_rb_Sk.deleted_one', { name }));
  }, [apply, group, sel, toast]);

  /** A change to the skill sets from the Manage Skill Sets dialog; activating or deleting one sends the selection back to the main skill's group. */
  const setOp = async (op: BuildEdit & { kind: 'skillSet' }, reselect: boolean) => {
    if ((await apply(op)) && reselect) setSel(null);
  };

  /** Ctrl Z and Ctrl Y go through the engine's undo, as on the other tabs; typing in a box keeps its own undo. */
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so these keys only act on the tab on screen.
  useLayoutEffect(() => {
    if (!engine || dlg) return;
    const kd = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const t = e.target as HTMLElement | null;
      if (!!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('.dialog')) return;
      e.preventDefault();
      setUndoBar(null);
      void (k === 'y' || e.shiftKey ? engine.redo() : engine.undo());
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, [engine, dlg]);

  /** Delete All, after upstream's confirm popup. */
  const deleteAll = async () => {
    setDlg(null);
    const n = groups.length;
    if (await apply({ kind: 'removeAllGroups' }, true)) {
      setSel(null);
      flashUndo(tr(n === 1 ? 'h_rb_Sk.deleted_grp_one' : 'h_rb_Sk.deleted_grp_many', { n }));
    }
  };

  const undoDelete = async () => {
    setUndoBar(null);
    window.clearTimeout(undoTimer.current);
    await engine?.undo();
  };

  const copyGroup = async (g: SkillGroup) => {
    if (g.source) return;
    const text = groupToText(g);
    clip.current = text;
    // The copy also stays inside the app, so a clipboard that does not answer costs nothing.
    clipSystem.current = false;
    void withTimeout(navigator.clipboard.writeText(text).then(() => true), 400).then((r) => {
      clipSystem.current = r === true;
    });
    toast({ text: tr('SkillsTab.copied_the_socket_group'), kind: 'ok', ttl: 1800 });
  };

  const pasteGroup = async () => {
    let text = clip.current;
    // A copy made here that the system clipboard refused (an unfocused window) is pasted from memory, not from stale clipboard text.
    const t = clipSystem.current || !text ? await withTimeout(navigator.clipboard.readText(), 400) : null;
    if (t) text = t;
    const parsed = text ? textToGroup(text) : null;
    if (!parsed) return;
    const byName = new Map<string, GemInfo>();
    for (const g of gems) {
      const k = g.name.toLowerCase();
      const old = byName.get(k);
      if (!old || (old.legacy && !g.legacy)) byName.set(k, g);
    }
    const specs = parsed.gems.flatMap((x) => {
      const g = byName.get(x.nameSpec.toLowerCase());
      return g ? [{ gemId: g.id, level: x.level, quality: x.quality, enabled: x.enabled, count: x.count }] : [];
    });
    if (!specs.length) {
      toast({ text: tr('SkillsTab.none_of_the_pasted_gems'), kind: 'error' });
      return;
    }
    const missed = parsed.gems.length - specs.length;
    await newGroup({ label: parsed.label, ...(parsed.slot ? { slot: parsed.slot } : {}), enabled: true, gems: specs });
    if (missed) toast({ text: tr('SkillsTab.count_pasted_gems_were_not', { count: missed }), kind: 'info' });
  };

  // The selected group stays in sight in the list (a new group is added at the end, below a short list's fold).
  useEffect(() => {
    const selRow = listRef.current?.querySelector<HTMLElement>('.sk-grow[data-on="true"]');
    if (selRow) {
      selRow.scrollIntoView({ block: 'nearest' });
      alignListTop(selRow);
    }
    if (focusAdd.current && addRef.current && pendingSel.current == null && group && !group.gems.length) {
      focusAdd.current = false;
      addRef.current.focus();
    }
  }, [sel, groups.length, group, docked]);

  const listKey = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const i = sel ?? 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (groups.length) setSel(Math.max(1, Math.min(groups.length, i + (e.key === 'ArrowDown' ? 1 : -1) || 1)));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      void deleteGroup();
    } else if (mod && e.key.toLowerCase() === 'c' && group) {
      e.preventDefault();
      void copyGroup(group);
    } else if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      void pasteGroup();
    }
  };

  // ---- gem picker ------------------------------------------------------------------------------
  // Docked, the list is always open for the selected group: adding when nothing else is being edited.
  const pMode = qMode ?? (docked && group && !group.source ? 'add' : null);
  const rowMode = pMode?.startsWith('row') ? Number(pMode.slice(3)) : null;
  const filter: PickerFilter | null = opts ? { options: opts, characterLevel, kind } : null;
  // The search and its rows follow the typed text one render behind, so a keystroke shows in the box at once instead of
  // waiting for the search and the list (about 160 ms a key in a trace). The rows end up the same.
  const dq = useDeferredValue(q);
  const results = useMemo(() => {
    if (!filter || !pMode) return [];
    return searchGems(gems, dq, filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gems, dq, pMode, kind, opts, characterLevel]);

  const field = opts?.sortGemsByDPSField ?? 'FullDPS';
  // Every gem the picker can list for the group, whatever is typed: the ranking pass scores all of them, supports first.
  const rankIds = useMemo(() => {
    if (!opts) return [];
    const f: PickerFilter = { options: opts, characterLevel, kind: null };
    const listed = gems.filter((g) => gemListed(g, f));
    return [...listed.filter((g) => g.support), ...listed.filter((g) => !g.support)].map((g) => g.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gems, opts?.showLegacyGems, opts?.showSupportGemTypes, opts?.defaultGemLevel, characterLevel]);
  const rankKey = opts && group && !group.source && sel != null ? `${buildId}|${state?.activeSet}|${rowMode ?? 'add'}|${sel}|${field}` : null;
  useEffect(() => {
    passes.current.clear();
    partial.current.clear();
  }, [buildId]);
  // The ranking pass starts as soon as a group is selected, not when the picker opens, and scores every listed gem. The
  // picker keeps the last finished order (or waits for the first) until the pass is done, so rows never move part way.
  useEffect(() => {
    if (!engine || !rankKey || sel == null || !rankIds.length) return;
    if (passes.current.get(rankKey)?.version === version) {
      setRanking(null);
      return;
    }
    for (const k of partial.current.keys()) if (!k.endsWith(`|${version}`)) partial.current.delete(k);
    const pk = `${rankKey}|${version}`;
    const out = partial.current.get(pk) ?? {};
    partial.current.set(pk, out);
    let alive = true;
    const gem = rowMode != null ? { gem: rowMode + 1 } : {};
    const ask = async (gemIds: string[]) => (await engine.call('gemPower', { group: sel, field, gemIds, ...gem })).power;
    void scoreGems(rankIds, ask, out, () => alive, (done) => alive && setRanking({ key: rankKey, done, total: rankIds.length })).then((ok) => {
      if (!ok || !alive) return;
      passes.current.set(rankKey, { version, scores: out });
      partial.current.delete(pk);
      setRanking(null);
      setPassTick((t) => t + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, rankKey, version, rankIds]);

  const sortOn = !!opts?.sortGemsByDPS;
  const pass = rankKey ? passes.current.get(rankKey) : undefined;
  const progress = ranking && ranking.key === rankKey ? ranking : null;
  // Adding to a group that has an active skill: supports first as one ranked block, other actives in their own section, and
  // gems already in the group at the end.
  const adding = rowMode == null && !!group;
  const sections = adding && !!group?.gems.some((x) => x.known && !x.support);
  const inGroup = useMemo(() => (adding && group ? new Set(group.gems.flatMap((x) => (x.gemId ? [x.gemId] : []))) : undefined), [adding, group]);
  // A typed name is never held back by the first ranking pass: the matches show in search order at once, so typing a gem
  // and pressing Enter adds it even while the pass for a new group is still running.
  const viewOf = (rows: GemInfo[], query: string) => pickerView(rows, { sort: sortOn && !(query.trim() && !pass), pass, version, limit: PICKER_ROWS, sections, inGroup, exact: query.split(':')[0] });
  // Replacing a gem with nothing typed: its other versions (the base gem, the transfigured variants) come first.
  const rowGemId = rowMode != null ? group?.gems[rowMode]?.gemId : undefined;
  const versions = useMemo(() => {
    const info = rowGemId ? gemById.get(rowGemId) : undefined;
    if (!info || !opts) return [];
    const f: PickerFilter = { options: opts, characterLevel, kind: null };
    return gemVersions(gems, info).filter((g) => gemListed(g, f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowGemId, gemById, gems, opts?.showLegacyGems, opts?.showSupportGemTypes, opts?.defaultGemLevel, characterLevel]);
  const withVersions = (v: PickerView<GemInfo>, query: string): PickerView<GemInfo> & { versions: number } => {
    if (!versions.length || query.trim()) return { ...v, versions: 0 };
    const ids = new Set(versions.map((g) => g.id));
    const at = (i: number) => (i < 0 ? i : versions.length + i - v.rows.slice(0, i).filter((r) => ids.has(r.id)).length);
    return { ...v, rows: [...versions, ...v.rows.filter((r) => !ids.has(r.id))], ranked: at(v.ranked), actives: at(v.actives), inGroup: at(v.inGroup), versions: versions.length };
  };
  const view = useMemo(
    () => withVersions(viewOf(results, dq), dq),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, pass, sortOn, version, sections, inGroup, versions, dq],
  );
  const shown = view.rows;

  const closePicker = useCallback(() => {
    setQMode(null);
    setQ('');
    setQHi(0);
  }, []);

  // The add list opens below the add box, in the editor's flow, so the group's gem rows above it stay in sight. When it
  // runs past the bottom of the editor, the editor scrolls just enough to show it. ponytail: sized when it opens or the group
  // changes, not on window resize.
  const inList = useRef<HTMLDivElement>(null);
  const addOpen = qMode === 'add' && !!group && !group.source;
  useLayoutEffect(() => {
    const l = inList.current;
    const sc = l?.closest('.sk-ed-scroll');
    if (!l || !sc) return;
    // In a short editor (the narrow layout) the list takes at most about half of it, so the gem rows nearest the add box
    // stay in sight above it.
    l.style.maxHeight = `${Math.round(Math.min(320, Math.max(150, sc.clientHeight * 0.45)))}px`;
    const over = l.getBoundingClientRect().bottom - sc.getBoundingClientRect().bottom + 8;
    if (over > 0) sc.scrollTop += over;
  }, [addOpen, group?.gems.length, view.held]);

  const groupCap = group && !group.source ? socketsFor(group).item?.socketLimit ?? 0 : 0;
  const groupFull = !!group && groupCap > 0 && group.gems.length >= groupCap;

  const pickGem = async (g: GemInfo) => {
    if (!group || sel == null || !opts) return;
    if (rowMode != null) {
      closePicker();
      await apply({ kind: 'setGemSkill', group: sel, gem: rowMode + 1, gemId: g.id });
    } else {
      // A gem already in the group stays in the list (marked "in group"); a click on it says why nothing was added.
      if (g.id && group.gems.some((x) => x.gemId === g.id)) {
        toast({ text: tr('SkillsTab.name_is_already_in_this', { name: g.name }), kind: 'info' });
        return;
      }
      setQ('');
      setQHi(0);
      await apply({ kind: 'addGem', group: sel, gem: { gemId: g.id, level: defaultGemLevel(g, opts.defaultGemLevel, characterLevel), quality: newGemQuality(opts.defaultGemQuality) } });
      window.setTimeout(() => addRef.current?.focus(), 0);
    }
  };

  const pickerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setQHi((h) => Math.min(shown.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setQHi((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter straight after a keystroke picks from the text as typed, not from the list still one render behind.
      // The same view the list draws, so Enter picks the row on screen.
      const list = dq !== q && filter && pMode ? withVersions(viewOf(searchGems(gems, q, filter), q), q).rows : shown;
      const g = list[qHi];
      if (g) void pickGem(g);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePicker();
      (e.target as HTMLElement).blur();
    }
  };

  // ---- render -----------------------------------------------------------------------------------
  if (!engine) {
    return (
      <div className="tabroot" data-screen-label="Skills / Tab / Content">
        <div className="panel" data-lg="panel">
          <div className="later">
            <span className="eyebrow">{tr('SkillsTab.skills')}</span>
            <h2>{tr('SkillsTab.no_numbers_yet')}</h2>
            <p>{tr('SkillsTab.the_calculation_engine_is_not')}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!state || !opts) {
    if (!error && !slowRead) return null;
    return (
      <div className="tabroot" data-screen-label="Skills / Tab / Content">
        <div className="panel" data-lg="panel">
          <div className="later">
            <span className="eyebrow">{tr('SkillsTab.skills')}</span>
            <h2>{error ? tr('SkillsTab.could_not_read_the_skills') : tr('SkillsTab.reading_the_skills')}</h2>
            {error && <p>{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  const set = state.sets.find((s) => s.id === state.activeSet) ?? state.sets[0];
  const totalGems = groups.reduce((a, g) => a + g.gems.length, 0);
  const setTitle = (t: string) => t || tr('SkillsTab_2.default');
  const noGroups = !groups.length;
  /** A gem in a group: its tooltip from the engine at the level the calculation uses, and its wiki page on F1. */
  const gemSpec = (x: SkillGem): SkillTip => {
    const info = x.gemId ? gemById.get(x.gemId) : undefined;
    const skillId = x.skillId ?? (info ? skillIdOf(info) : undefined);
    return {
      ...(x.known && skillId ? { gem: { skillId, level: x.effectiveLevel } } : {}),
      ...((x.known || !x.skillId) && x.errMsg ? { notes: [x.errMsg] } : {}),
      ...(x.known ? { wiki: gemWikiUrl(info?.name ?? x.nameSpec, x.support) } : {}),
    };
  };

  /** Optimise Sockets: the item's sockets are rebuilt from the gems of the groups socketed in it, as one edit that Ctrl Z undoes. */
  const optimiseSocketsOf = async (g: SkillGroup, item: NonNullable<SkillSlotInfo['item']>) => {
    if (!engine) return;
    const { buildXml } = await engine.call('getBuildXml');
    const entry = readItems(buildXml).items.find((i) => i.id === item.id);
    if (!entry) return;
    const max = (item.socketLimit ?? 0) - item.sockets.filter((c) => c === 'A').length;
    const mine = groups.filter((o) => o.slot === g.slot && !o.source).map((o) => o.gems.filter((x) => x.known).map((x) => ({ colour: x.colour })));
    await apply({ kind: 'setXml', xml: setItemText(buildXml, item.id, setSockets(entry.text, optimisedSockets(mine, max))) });
  };

  /** A picker row: the gem's tooltip at the default level, and what adding it (or swapping it in) would do to the build. */
  const rowTip = (m: GemInfo): TipBind =>
    tips.bind(() => {
      if (!group || sel == null) return null;
      const level = defaultGemLevel(m, opts.defaultGemLevel, characterLevel);
      return {
        gem: { skillId: skillIdOf(m), level },
        compare: {
          header: tr('SkillsTab.selecting_this_gem_will_give'),
          edit: rowMode != null ? { kind: 'setGemSkill', group: sel, gem: rowMode + 1, gemId: m.id } : { kind: 'addGem', group: sel, gem: { gemId: m.id, level, quality: newGemQuality(opts.defaultGemQuality) } },
        },
        wiki: gemWikiUrl(m.name, m.support),
      };
    });

  const closeMenu = () => setMenu(null);
  const tgl = (m: Menu) => () => setMenu((c) => (c === m ? null : m));
  const slotsList: { slot: string; label: string; info?: SkillSlotInfo }[] = [{ slot: '', label: tr('SkillsTab.none') }, ...state.slots.map((s) => ({ slot: s.slot, label: label(s.label || s.slot), info: s }))];

  const anchorW = rowBox.current?.getBoundingClientRect().width ?? 420;
  const pickerList = (
    <div
      ref={inList}
      className={'sk-menu res' + (docked ? ' sk-docklist' : rowMode == null ? ' sk-inlist' : '')}
      style={docked || rowMode == null ? undefined : { width: Math.max(anchorW, 260) - 10, maxHeight: 320 }}
      role={docked || rowMode == null ? 'listbox' : undefined}
      aria-label={docked || rowMode == null ? tr('SkillsTab.gems') : undefined}
      // A press on the list's own scrollbar or a heading keeps focus in the search box, so the list stays open.
      onMouseDown={(e) => e.preventDefault()}
    >
      {rowMode == null && groupFull && (
        <div className="rank" role="note" data-full="true" title={tr('SkillsTab.no_free_socket_length_groupcap', { count: group?.gems.length, groupCap }) + ' ' + tr('SkillsTab.a_gem_added_past_the')}>
          <span>{tr('SkillsTab.no_free_socket_short', { count: group?.gems.length, groupCap })}</span>
        </div>
      )}
      {sortOn && (view.held || view.stale) && (
        <div className="rank" role="status" data-held={view.held}>
          <span>{view.held ? tr('SkillsTab.ranking_gems_by') : tr('SkillsTab.re_ranking_by')}{SORT_LABEL[field] ?? field}…</span>
          <span className="n">{progress ? `${progress.done}/${progress.total}` : ''}</span>
          <span className="bar" style={{ '--p': progress && progress.total ? progress.done / progress.total : 0 } as React.CSSProperties} />
        </div>
      )}
      {shown.map((m, i) => {
        const mine = view.inGroup >= 0 && i >= view.inGroup;
        const v = mine ? undefined : pass?.scores[m.id];
        const pct = mine ? tr('SkillsTab_2.in_group') : formatGemPower(v);
        return (
          <Fragment key={m.id}>
          {view.pinned && view.versions === 0 && i === 0 && <div className="div">{tr('SkillsTab.exact_match')}</div>}
          {view.versions > 0 && i === 0 && <div className="div">{tr('SkillsTab.other_versions_of_this_gem')}</div>}
          {view.versions > 0 && i === view.versions && <div className="div">{tr('SkillsTab.other_gems')}</div>}
          {i === view.actives && (
            <div className="div" title={tr('SkillsTab.active_skill_gems_that_raise')}>
              {tr('SkillsTab.other_skills_that_raise_dps')}
            </div>
          )}
          {sortOn && i === view.ranked && i !== view.inGroup && (
            <div className="div" title={tr('SkillsTab.the_engine_gives_these_gems')}>
              {tr('SkillsTab.no_dps_change')}
            </div>
          )}
          {i === view.inGroup && <div className="div">{tr('SkillsTab.already_in_this_group')}</div>}
          <button
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={i === qHi}
            className="sk-mi res"
            data-hi={i === qHi}
            data-in={mine}
            {...rowTip(m)}
            onMouseDown={(e) => {
              e.preventDefault();
              tips.hide();
              void pickGem(m);
            }}
            onMouseEnter={(e) => {
              setQHi(i);
              rowTip(m).onMouseEnter?.(e);
            }}
          >
            <GemImg name={m.name} colour={m.colour} size={20} />
            <span className="grow" style={{ color: ATTR[m.colour].text }}>
              {m.name}
            </span>
            <span className="mark" aria-hidden style={{ color: typeof v === 'number' ? dpsColour(v) : undefined }}>
              {typeof v === 'number' ? (m.support ? <Icon name="check" size={15} /> : '+') : ''}
            </span>
            <span className="dps" style={{ color: typeof v === 'number' && v > 0 ? 'var(--positive)' : typeof v === 'number' && v < 0 ? 'var(--negative-text)' : 'var(--text-faint)' }} title={mine ? tr('SkillsTab.this_gem_is_already_in') : pct ? tr('SkillsTab.field_if_this_gem_is', { field: SORT_LABEL[field] ?? field }) : undefined}>
              {pct}
            </span>
          </button>
          </Fragment>
        );
      })}
      {!shown.length && !view.held && <div className="none">{tr('SkillsTab.no_gem_matches_dq', { dq })}{opts.showLegacyGems ? '' : '. Legacy gems are hidden in Gem defaults.'}</div>}
    </div>
  );

  const editorBody = (() => {
    if (!group || sel == null) return null;
    const g = group;
    const src = !!g.source;
    const { item, sockets } = socketsFor(g);
    const cap = item?.socketLimit ?? sockets.length;
    const links = Math.min(sockets.length, g.gems.length);
    const ms = matchSummary(g.gems, sockets);
    const over = item && cap > 0 ? Math.max(0, g.gems.length - cap) : 0;
    const order = matchColourOrder(g.gems, sockets);
    const slotInfo = g.slot ? slotMap.get(g.slot) : undefined;
    let matchTxt: string;
    let matchFg = 'var(--text-muted)';
    let matchIc = 'info';
    if (!g.slot) matchTxt = tr('SkillsTab_2.not_socketed_in_an_item');
    else if (!item) matchTxt = slotInfo ? tr('SkillsTab_2.no_item_equipped') : tr('h_rb_Sk.no_sockets', { slot: g.slot });
    else if (item && !item.canHaveSockets) matchTxt = tr('SkillsTab_2.this_item_cannot_have_sockets');
    else if (!g.gems.length) matchTxt = tr('SkillsTab_2.add_gems_to_check_colours');
    else if (over) {
      matchTxt = tr('SkillsTab_2.gems_in_sockets_over_the_link', { gems: g.gems.length, cap: cap, over: over });
      matchFg = 'var(--negative-text)';
      matchIc = 'alert';
    } else if (!ms.coloured) {
      matchTxt = tr('SkillsTab_2.all_white_any_gem_fits');
      matchIc = 'check';
    } else if (ms.matched) {
      matchTxt = tr(ms.coloured === 1 ? 'h_rb_Sk.match_some_1' : 'h_rb_Sk.match_some_n', { matched: ms.matched, coloured: ms.coloured, q: MATCH_Q });
      matchFg = ms.matched === ms.coloured ? 'var(--positive)' : 'var(--text-2)';
      matchIc = 'check';
    } else matchTxt = tr(ms.coloured === 1 ? 'h_rb_Sk.match_none_1' : 'h_rb_Sk.match_none_n', { n: ms.coloured });
    const canOpt = !src && !!item && g.gems.length > 1 && !!order && !over;
    const optMax = item ? (item.socketLimit ?? 0) - item.sockets.filter((c) => c === 'A').length : 0;
    const optNeeded = !src && !!item && optimiseWanted(groups.filter((o) => o.slot === g.slot && !o.source), optMax);
    const isMain = state.mainGroup === sel;
    const imb = g.imbuedSupport ? gems.find((x) => x.support && x.name.toLowerCase() === g.imbuedSupport!.toLowerCase()) : undefined;
    const imbList = gems.filter((x) => searchGems([x], '', { options: opts, characterLevel, kind: 'S', imbued: true }).length).sort((a, b) => a.name.localeCompare(b.name));
    // `isImbuedEnabled`: the group has a slot, and the item holds no imbued support yet unless it is this group's own.
    const slotTaken = groups.some((o) => o !== g && o.slot === g.slot && !!o.imbuedSupport);
    const slotOn = !!(g.slot && !src) && (!slotTaken || !!g.imbuedSupport);
    const setAttr = (attr: string, value: string | number | boolean | null) => apply({ kind: 'setGroup', group: sel, attr, value });
    return (
      <>
        <div ref={edScroll} className="sk-ed-scroll">
        <div className="sk-gems">
          <div className="sk-gemrow head" data-r="gemrow">
            <span />
            <span>{tr('SkillsTab.gem_name')}</span>
            <span className="c">{tr('SkillsTab.level')}</span>
            <span className="c">{tr('SkillsTab.quality')}</span>
            <span className="c">{tr('SkillsTab.enabled_2')}</span>
            <span className="c">{tr('SkillsTab.count_2')}</span>
          </div>
          {g.gems.map((x, i) => {
            const info = x.gemId ? gemById.get(x.gemId) : undefined;
            const editing = rowMode === i;
            const maxLv = Math.max(x.maxLevel, x.level, 1);
            const lvTip = x.effectiveLevel !== x.level ? tr('SkillsTab.level_level_effectivelevel_with_bonu', { level: x.level, effectiveLevel: x.effectiveLevel }) : x.level > x.naturalMaxLevel ? tr('SkillsTab.corrupted_level') : tr('h_rb_Sk.max_lv', { n: x.naturalMaxLevel });
            return (
              <div key={i} className="sk-gemwrap" style={{ opacity: x.enabled ? 1 : 0.5 }}>
                <div className="sk-gemrow" data-r="gemrow" data-assistant-highlight={hlAt && sel === hlAt.group && i + 1 === (hlAt.gem || g.gems.length) ? x.gemId || String(i + 1) : undefined} {...pvMark(x.nameSpec)}>
                  <button type="button" className="sk-x" disabled={src} aria-label={tr('SkillsTab.remove_this_gem')} title={tr('SkillsTab.remove_this_gem')} onClick={() => void apply({ kind: 'removeGem', group: sel, gem: i + 1 })}>
                    <Icon name="x" size={12} />
                  </button>
                  <div className="sk-namebox" ref={editing ? rowBox : undefined}>
                    {!editing ? (
                      <button
                        type="button"
                        className="sk-name"
                        disabled={src}
                        {...tips.bind(() => gemSpec(x))}
                        // Typing on a focused gem name starts replacing it, as in upstream's name box.
                        onKeyDown={(e) => {
                          if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
                          e.preventDefault();
                          setQMode('row' + i);
                          setQ(e.key);
                          setQHi(0);
                          setKind(x.support ? 'S' : 'A');
                        }}
                        onClick={() => {
                          setQMode('row' + i);
                          setQ('');
                          setQHi(0);
                          setKind(x.support ? 'S' : 'A');
                        }}
                      >
                        <span className="dotw" {...(x.matchesSocket ? tips.bind({ notes: [tr('SkillsTab.in_a_matching_socket_match', { MATCH_Q })] }) : {})}>
                          <span className="dot" style={{ background: ATTR[x.colour].socket, boxShadow: `${x.matchesSocket ? '0 0 0 1.5px rgba(var(--accent-rgb),.75), ' : ''}0 0 6px ${ATTR[x.colour].socket}` }} />
                        </span>
                        <GemImg name={x.nameSpec} colour={x.colour} size={18} />
                        <span className="nm" style={{ color: x.known ? ATTR[x.colour].text : gemRowLook(x).muted ? 'var(--text-muted)' : 'var(--negative-text)' }}>
                          {fromMain('skills_texts', gemRowLook(x).text)}
                        </span>
                        {info?.legacy && (
                          <span style={{ display: 'flex', flex: 'none' }} {...tips.bind({ notes: [tr('SkillsTab.legacy_gem_only_exists_in')] })}>
                            <Icon name="info" size={13} label={tr('SkillsTab.legacy_gem_only_exists_in')} style={{ color: 'var(--text-faint)' }} />
                          </span>
                        )}
                      </button>
                    ) : (
                      <div className="sk-search">
                        <Icon name="search" size={14} style={{ flex: 'none', color: 'var(--text-muted)' }} />
                        <input autoFocus ref={rowInput} value={q} placeholder={tr('h_rb_Sk.replace_ph', { name: x.nameSpec })} aria-label={tr('SkillsTab.replace_gem')} onChange={(e) => { setQ(e.target.value); setQHi(0); }} onKeyDown={pickerKey} onBlur={() => window.setTimeout(() => setQMode((m) => (m === 'row' + i ? null : m)), 160)} />
                      </div>
                    )}
                  </div>
                  <NumCell value={x.level} min={1} max={maxLv} label={tr('SkillsTab.gem_level')} fg={x.level > x.naturalMaxLevel ? 'var(--negative-text)' : undefined} title={lvTip} onChange={(n) => void apply({ kind: 'setGem', group: sel, gem: i + 1, attr: 'level', value: n })} />
                  <NumCell value={x.quality} min={0} max={23} label={tr('SkillsTab.gem_quality')} fg={x.quality > 20 ? 'var(--negative-text)' : undefined} tip={tips.bind({ ...(x.effectiveQuality !== x.quality ? { notes: [tr('SkillsTab.quality_quality_effectivequality_wit', { quality: x.quality, effectiveQuality: x.effectiveQuality })] } : {}), compare: { header: tr('SkillsTab.setting_to_20_quality_will'), edit: { kind: 'setGem', group: sel, gem: i + 1, attr: 'quality', value: 20 } } })} onChange={(n) => void apply({ kind: 'setGem', group: sel, gem: i + 1, attr: 'quality', value: n })} />
                  <span className="sk-c" {...tips.bind({ compare: { header: x.enabled ? tr('SkillsTab.disabling_this_gem_will_give') : tr('SkillsTab.enabling_this_gem_will_give'), edit: { kind: 'setGem', group: sel, gem: i + 1, attr: 'enabled', value: !x.enabled } } })}>
                    <Switch checked={x.enabled} onChange={(v) => void apply({ kind: 'setGem', group: sel, gem: i + 1, attr: 'enabled', value: v })} label={tr('SkillsTab.gem_enabled')} />
                  </span>
                  {x.hasCount ? <NumCell value={x.count} min={1} max={99} label={tr('SkillsTab.gem_count')} tip={tips.bind({ notes: GEM_NOTE })} onChange={(n) => void apply({ kind: 'setGem', group: sel, gem: i + 1, attr: 'count', value: n })} /> : <span />}
                </div>
                {x.vaal && !src && (
                  <div className="sk-vaal">
                    <label className="sk-toggle sm">
                      <Switch checked={x.enableGlobal1} onChange={(v) => void apply({ kind: 'setGem', group: sel, gem: i + 1, attr: 'enableGlobal1', value: v })} label={tr('h_rb_Sk.enable_x', { name: x.effectName })} />
                      {tr('SkillsTab.enable_effectname', { effectName: x.effectName })}
                    </label>
                    {x.secondaryEffectName && (
                      <label className="sk-toggle sm">
                        <Switch checked={x.enableGlobal2} onChange={(v) => void apply({ kind: 'setGem', group: sel, gem: i + 1, attr: 'enableGlobal2', value: v })} label={tr('h_rb_Sk.enable_x', { name: x.secondaryEffectName })} />
                        {tr('SkillsTab.enable_secondaryeffectname', { secondaryEffectName: x.secondaryEffectName })}
                      </label>
                    )}
                  </div>
                )}
                {x.errMsg && x.known && <div className="sk-err">{x.errMsg}</div>}
              </div>
            );
          })}
          {!src && (
            <div className="sk-gemrow add" data-r="gemrow">
              <span />
              <div className="sk-addbox" ref={addBox}>
                <div className="sk-add" data-on={qMode === 'add'}>
                  <Icon name="plus" size={14} style={{ flex: 'none', color: 'var(--text-muted)' }} />
                  <input
                    ref={addRef}
                    value={qMode === 'add' ? q : ''}
                    placeholder={!group.gems.length ? tr('SkillsTab.add_an_active_skill_gem') : docked ? tr('SkillsTab.add_gem_filter_ph') : tr('SkillsTab.add_a_gem_type_to_2')}
                    title={group.gems.length && docked ? tr('SkillsTab.add_a_gem_type_to') : undefined}
                    aria-label={tr('SkillsTab.add_a_gem')}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setQHi(0);
                      setQMode('add');
                    }}
                    onFocus={() => {
                      setQMode('add');
                      setQHi(0);
                    }}
                    // The list closes when the editor scrolls (the gem just added pushes the box down); a click or a key in the
                    // box that still has focus brings it back.
                    onClick={() => setQMode('add')}
                    onKeyDown={pickerKey}
                    onBlur={() => window.setTimeout(() => setQMode((m) => (m === 'add' ? null : m)), 160)}
                  />
                  <div className="kinds" role="radiogroup" aria-label={tr('SkillsTab.gem_type')}>
                    {(
                      [
                        ['S', tr('SkillsTab.only_show_support_gems')],
                        ['A', tr('SkillsTab.only_show_active_gems')],
                      ] as const
                    ).map(([k, t]) => (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={kind === k}
                        title={t}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setKind((c) => (c === k ? null : k));
                          setQHi(0);
                        }}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
                {addOpen && !docked && pickerList}
              </div>
            </div>
          )}
        </div>
        </div>
        <div ref={drawerRef} className="sk-drawer" data-open={drawer}>
          <button ref={drawerBar} id="sk-drawer-bar" type="button" className="sk-drawer-bar" aria-expanded={drawer} aria-controls="sk-drawer-panel" onClick={() => setDrawer((v) => !v)}>
            <span style={{ flex: 1 }}>{tr('SkillsTab.group_settings')}</span>
            <Icon name="chevron-down" size={12} style={{ flex: 'none', color: 'var(--text-muted)' }} />
          </button>
          <div ref={drawerPanel} id="sk-drawer-panel" className="sk-drawer-panel" role="region" aria-labelledby="sk-drawer-bar" tabIndex={-1}>
            <div className="sk-line">
              <div className="sk-label" data-lg="tile">
                {leadGem(g) ? <GemImg name={leadGem(g)!.nameSpec} colour={leadGem(g)!.colour} size={20} /> : <img className="sk-gem-img" src={gemFrame('str')} alt="" width={20} height={20} />}
                <GroupLabel key={sel + ':' + (g.label ?? '')} value={g.label ?? ''} placeholder={(g.displayLabel || tr('SkillsTab_2.new_group')) + (g.gems.length > 1 && !g.source ? ' ' + g.gems.length + 'L' : '')} disabled={src} onCommit={(v) => setAttr('label', v.trim() ? v : null)} />
                <Icon name="pencil" size={12} style={{ flex: 'none', color: 'var(--text-faint)', marginRight: 4 }} />
              </div>
              <button type="button" className="sk-btn" data-on={isMain} disabled={isMain} title={isMain ? tr('SkillsTab.this_group_is_the_main') : tr('SkillsTab.show_this_group_as_the')} onClick={() => void apply({ kind: 'setMainGroup', group: sel })}>
                <Icon name="star" size={14} />
                {isMain ? tr('SkillsTab.main_skill') : tr('SkillsTab.make_main_skill')}
              </button>
            </div>
            <div className="sk-line">
              <div className="sk-pick slot">
                <button ref={slotBtn} type="button" className="sk-sel" disabled={src} {...tips.bind(SLOT_NOTE)} aria-haspopup="listbox" aria-expanded={menu === 'slot'} onClick={tgl('slot')}>
                  {g.slot && slotIcon(g.slot) ? <img src={slotIcon(g.slot)} alt="" width={18} height={18} className="sk-slot-img" /> : <img src={slotIcon('Body Armour')} alt="" width={18} height={18} className="sk-slot-img" style={{ opacity: g.slot ? 0.85 : 0.35 }} />}
                  <span className="sk-stack">
                    <span className="cap">{tr('SkillsTab.socketed_in')}</span>
                    <span className="val">{g.slot ? slotInfo?.label || g.slot : tr('SkillsTab.none')}</span>
                  </span>
                  <Icon name="chevron-down" size={12} style={{ flex: 'none', color: 'var(--text-muted)' }} />
                </button>
                <PortalMenu anchor={slotBtn} open={menu === 'slot'} onClose={closeMenu} role="listbox" label={tr('SkillsTab.socketed_in_2')} minWidth={250}>
                  <div className="sk-menu" style={{ maxHeight: 340 }}>
                    {slotsList.map((m) => {
                      const on = (g.slot ?? '') === m.slot;
                      const it = m.info?.item;
                      return (
                        <button
                          key={m.slot || 'none'}
                          type="button"
                          role="option"
                          aria-selected={on}
                          className="sk-mi tall"
                          data-on={on}
                          {...tips.bind(!m.slot ? SLOT_NOTE : it ? { item: () => loadItemInfo(engine, it.id) } : { notes: [tr('SkillsTab.no_item_is_equipped_in')] })}
                          onClick={() => {
                            tips.hide();
                            closeMenu();
                            void setAttr('slot', m.slot || null);
                          }}
                        >
                          {m.slot && slotIcon(m.slot) ? <img src={slotIcon(m.slot)} alt="" width={18} height={18} className="sk-slot-img" /> : <span style={{ width: 18 }} />}
                          <span className="sk-stack">
                            <span>{m.label}</span>
                            <span className="sub">{!m.slot ? tr('SkillsTab.granted_or_unsocketed') : it ? tr('SkillsTab.base_count_sockets', { count: it.sockets.length, base: it.name || it.base }) : tr('SkillsTab.no_item')}</span>
                          </span>
                          <span className="chk">{on && <Icon name="check" size={13} />}</span>
                        </button>
                      );
                    })}
                  </div>
                </PortalMenu>
              </div>
              <label className="sk-toggle">
                <Switch checked={g.enabled} onChange={(v) => void setAttr('enabled', v)} label={tr('SkillsTab.enabled')} />
                {tr('SkillsTab.enabled')}
              </label>
              <label className="sk-toggle">
                <Switch checked={g.includeInFullDPS && g.enabled} onChange={(v) => void setAttr('includeInFullDPS', v)} label={tr('SkillsTab.include_in_full_dps')} />
                {tr('SkillsTab.include_in_full_dps')}
              </label>
              {src && (
                <label className="sk-toggle">
                  {tr('SkillsTab.count')}
                  <Stepper value={g.groupCount ?? 1} min={1} max={99} label={tr('SkillsTab.group_count')} onChange={(n) => void setAttr('groupCount', n)} />
                </label>
              )}
            </div>

            {g.activeSkills.length > 1 && (
              <div className="sk-line">
                <span className="sk-cap">{tr('SkillsTab.active_skill')}</span>
                <div className="sk-seg" role="radiogroup" aria-label={tr('SkillsTab.main_active_skill_in_this')} data-lg="tile">
                  {g.activeSkills.map((a) => (
                    <button key={a.index} type="button" role="radio" aria-checked={g.mainActiveSkill === a.index} onClick={() => void apply({ kind: 'setMainActiveSkill', group: sel, skill: a.index })}>
                      {a.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {src ? (
              <div className="sk-note">
                <Icon name="info" size={14} />
                <span>
                  {tr('SkillsTab.this_is_a_special_group', { nameSpec: leadGem(g)?.effectName || leadGem(g)?.nameSpec || 'skill', source: g.sourceName || g.source })}
                </span>
              </div>
            ) : (
              <>
                <div className="sk-line sk-lbl">
                  <span className="sk-cap">{tr('SkillsTab.item_sockets')}</span>
                  <div className="sk-val">
                  {item && item.canHaveSockets && sockets.length > 0 && (
                    <div className="sk-vrow">
                      <span className="sk-socks">
                        {sockets.map((c, i) => {
                          const col = socketColour(c);
                          const gm = g.gems[i];
                          const m = !!gm && c !== 'W' && c !== 'A' && gm.colour === col;
                          return (
                            <span key={i} className="sk-sock-wrap">
                              {i > 0 && <span className="link" />}
                              <span className="sock" data-match={m} title={(gm ? (m ? tr('h_rb_Sk.sock_gem_q', { colour: label(ATTR[col].label), gem: gm.nameSpec, q: MATCH_Q }) : tr('h_rb_Sk.sock_gem', { colour: label(ATTR[col].label), gem: gm.nameSpec })) : tr('h_rb_Sk.sock_empty', { colour: label(ATTR[col].label) })) + (c === 'W' || c === 'A' ? '' : '\n' + tr('h_rb_Sk.sock_hint', { colour: label(ATTR[col].label).toLowerCase(), q: MATCH_Q }))} style={{ backgroundImage: `url(${socketIcon(col)})` }} />
                            </span>
                          );
                        })}
                      </span>
                      <span className="sk-muted" title={(links > 1 ? tr('h_rb_Sk.link_n', { n: links }) : tr(sockets.length === 1 ? 'h_rb_Sk.sockets_one' : 'h_rb_Sk.sockets_many', { n: sockets.length })) + ' · ' + (item.name || item.base)}>{(links > 1 ? tr('h_rb_Sk.link_n', { n: links }) : tr(sockets.length === 1 ? 'h_rb_Sk.sockets_one' : 'h_rb_Sk.sockets_many', { n: sockets.length })) + ' · ' + (item.name || item.base)}</span>
                    </div>
                  )}
                  <div className="sk-vrow">
                  <span className="sk-match" style={{ color: matchFg }}>
                    <Icon name={matchIc} size={13} />
                    {matchTxt}
                  </span>
                  <button type="button" className="sk-btn sm" disabled={!canOpt} title={tr('SkillsTab.reorder_the_gems_so_coloured')} onClick={() => order && void apply({ kind: 'orderGems', group: sel, order })}>
                    <Icon name="wand" size={14} />
                    {tr('SkillsTab.match_colours')}
                  </button>
                  {item && item.socketLimit !== undefined && (
                    <button type="button" className="sk-btn sm" disabled={!optNeeded} {...tips.bind({ notes: [tr('SkillsTab.rebuild_the_item_s_sockets')] })} onClick={() => void optimiseSocketsOf(g, item)}>
                      <Icon name="links" size={14} />
                      {tr('SkillsTab.optimise_sockets')}
                    </button>
                  )}
                  </div>
                  </div>
                </div>

                <div className="sk-line sk-lbl">
                  <span className="sk-cap">{tr('SkillsTab.imbued_support')}</span>
                  <div className="sk-val"><div className="sk-vrow">
                  <div className="sk-pick imb">
                    <button ref={imbBtn} type="button" className="sk-sel flat" disabled={!slotOn} title={slotOn ? '' : slotTaken ? tr('SkillsTab.only_one_imbued_support_is') : tr('SkillsTab.socketed_in_item_must_be')} aria-haspopup="listbox" aria-expanded={menu === 'imbued'} onClick={tgl('imbued')}>
                      {imb && <GemImg name={imb.name} colour={imb.colour} size={18} />}
                      <span className="val" style={{ color: imb ? ATTR[imb.colour].text : 'var(--text-muted)' }}>
                        {g.imbuedSupport || tr('SkillsTab.none')}
                      </span>
                      <Icon name="chevron-down" size={12} style={{ flex: 'none', color: 'var(--text-muted)' }} />
                    </button>
                    <PortalMenu anchor={imbBtn} open={menu === 'imbued'} onClose={closeMenu} role="listbox" label={tr('SkillsTab.imbued_support')} minWidth={280}>
                      <div className="sk-menu" style={{ maxHeight: 300 }}>
                        {[{ name: '', colour: 'w' as const } as Pick<GemInfo, 'name' | 'colour'>, ...imbList].map((m) => {
                          const on = (g.imbuedSupport ?? '') === m.name;
                          return (
                            <button
                              key={m.name || 'none'}
                              type="button"
                              role="option"
                              aria-selected={on}
                              className="sk-mi"
                              data-on={on}
                              onClick={() => {
                                closeMenu();
                                void setAttr('imbuedSupport', m.name || null);
                              }}
                            >
                              {m.name ? <GemImg name={m.name} colour={m.colour} size={18} /> : <span style={{ width: 18 }} />}
                              <span className="grow" style={{ color: m.name ? ATTR[m.colour].text : 'var(--text-muted)' }}>
                                {m.name || tr('SkillsTab.none')}
                              </span>
                              <span className="chk">{on && <Icon name="check" size={13} />}</span>
                            </button>
                          );
                        })}
                      </div>
                    </PortalMenu>
                  </div>
                  {g.imbuedSupport && (
                    <button type="button" className="sk-x" aria-label={tr('SkillsTab.remove_this_imbued_support')} title={tr('SkillsTab.remove_this_imbued_support_2')} onClick={() => void setAttr('imbuedSupport', null)}>
                      <Icon name="x" size={12} />
                    </button>
                  )}
                  </div></div>
                </div>
              </>
            )}
          </div>
        </div>
      </>
    );
  })();

  const pickerOpen = !!qMode && !!group && !group.source && qMode !== null;

  /** The assistant hook: a question about the selected group, left in the composer for the player to send. */
  const askAssistant = () => {
    if (!group) return;
    const metric = SORT_LABEL[field] ?? field;
    const ok = requestAssistant({ text: `Look at my "${groupName(group)}" socket group (${group.gems.map((x) => x.nameSpec).join(', ') || 'empty'}). Which gems would raise its ${metric} the most, and is any gem in it doing nothing?` });
    if (!ok) toast({ text: tr('SkillsTab.open_the_assistant_panel_first'), kind: 'info' });
  };

  return (
    <div ref={rootRef} className="tabroot sk-root" data-docked={docked} data-screen-label="Skills / Tab / Content">
      <div className="sk-bar" data-lg="panel" data-r="tab-tb">
        <button ref={setBtn} type="button" className="sk-set" aria-haspopup="listbox" aria-expanded={menu === 'set'} onClick={tgl('set')}>
          <span className="sk-stack">
            <span className="cap">{tr('SkillsTab.skill_set')}</span>
            <span className="val">{setTitle(set?.title ?? '')}</span>
          </span>
          <Icon name="chevron-down" size={12} style={{ flex: 'none', transform: menu === 'set' ? 'rotate(180deg)' : undefined, transition: 'transform 160ms', color: 'var(--text-muted)' }} />
        </button>
        <PortalMenu anchor={setBtn} open={menu === 'set'} onClose={closeMenu} role="listbox" label={tr('SkillsTab.skill_sets')} minWidth={260}>
          <div className="sk-menu">
            {state.sets.map((s) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={s.id === state.activeSet}
                className="sk-mi"
                data-on={s.id === state.activeSet}
                onClick={() => {
                  closeMenu();
                  if (s.id !== state.activeSet) void setOp({ kind: 'skillSet', op: 'activate', id: s.id }, true);
                }}
              >
                <span className="grow">{setTitle(s.title)}</span>
                <span className="meta">
                  {tr('SkillsTab.count_groups', { count: s.groups })}
                </span>
                <span className="chk">{s.id === state.activeSet && <Icon name="check" size={13} />}</span>
              </button>
            ))}
            <div className="sep" />
            <button
              type="button"
              className="sk-mi plain"
              onClick={() => {
                closeMenu();
                setDlg('new');
              }}
            >
              <Icon name="plus" size={14} />
              {tr('SkillsTab.new_skill_set')}
            </button>
          </div>
        </PortalMenu>
        <button ref={manageBtn} type="button" className="sk-tbtn" data-lg="control" aria-haspopup="dialog" aria-expanded={setsPop} onClick={() => setSetsPop((v) => !v)}>
          <Icon name="sliders" size={16} />
          {tr('SkillsTab.manage')}
        </button>
        <span style={{ flex: 1 }} />
        <span className="sk-summary">
          {tr('SkillsTab.count_groups_2', { count: groups.length })}, {tr('SkillsTab.count_gems', { count: totalGems })}
        </span>
        <button type="button" className="sk-tbtn" data-lg="control" disabled={!group} title={tr('SkillsTab.open_the_assistant_with_a')} onClick={askAssistant}>
          <Icon name="sparkle" size={15} />
          {tr('SkillsTab.ask_about_this_group')}
        </button>
      </div>

      <div className="sk-groups" data-lg="panel" data-r="tab-body sk-groups">
        <div className="sk-groups-in">
          <div className="sk-hdr" data-r="sk-hdr">
            <span className="ttl">
              <Icon name="links" size={18} style={{ color: 'var(--gold-label)' }} />
              {tr('SkillsTab.socket_groups')}
            </span>
            <span className="sk-help" aria-label={tr('SkillsTab.usage_tips')} {...tips.bind(USAGE_TIPS)}>
              <Icon name="keyboard" size={15} />
            </span>
            <div className="acts">
              <button type="button" className="sk-btn sm" title={tr('SkillsTab.new_socket_group')} onClick={() => void newGroup()}>
                <Icon name="plus" size={14} />
                {tr('SkillsTab.new')}
              </button>
              <button type="button" className="sk-btn sm" disabled={!group} title={tr('SkillsTab.delete_the_selected_group_del')} onClick={() => void deleteGroup()}>
                <Icon name="trash" size={14} />
                {tr('SkillsTab.delete')}
              </button>
              <button type="button" className="sk-btn sm" disabled={noGroups} title={tr('SkillsTab.delete_every_group_in_this')} onClick={() => setDlg('all')}>
                <Icon name="trash" size={14} />
                {tr('SkillsTab.delete_all')}
              </button>
            </div>
          </div>

          <div ref={listRef} className="sk-list" data-docked={docked} tabIndex={0} role="listbox" aria-label={tr('SkillsTab.socket_groups_2')} onKeyDown={listKey}>
            {groups.map((g) => {
              const on = sel === g.index;
              const lead = leadGem(g);
              const { item: gItem, sockets } = socketsFor(g);
              const cap = gItem && gItem.canHaveSockets ? gItem.socketLimit ?? gItem.sockets.length : null;
              const warns = groupWarnings(g, g.source ? null : cap).map((w) => fromMain('skills_texts', w));
              const sub = groupSub(g);
              const dotsFor = g.gems.map((x, i) => {
                const s = sockets[i];
                const col = s ? socketColour(s) : null;
                const m = !!s && s !== 'W' && s !== 'A' && col === x.colour;
                return { c: col ? ATTR[col].socket : 'rgba(var(--line-rgb),.18)', m };
              });
              const colouredN = sockets.slice(0, g.gems.length).filter((s) => s !== 'W' && s !== 'A').length;
              const matchedN = dotsFor.filter((d) => d.m).length;
              const sockTip = tr(g.gems.length === 1 ? 'h_rb_Sk.gems_one' : 'h_rb_Sk.gems_many', { n: g.gems.length }) + (sockets.length ? ' · ' + (colouredN ? tr(colouredN === 1 ? 'h_rb_Sk.col_sock_one' : 'h_rb_Sk.col_sock_many', { c: colouredN, m: matchedN }) : tr('h_rb_Sk.all_white')) : '');
              return (
                <div
                  key={g.index}
                  role="option"
                  aria-selected={on}
                  className="sk-grow"
                  data-on={on}
                  data-over={drag?.over === g.index && drag.from !== g.index}
                  draggable
                  {...tips.bind(() => ({ group: groupTip(g, state.mainGroup === g.index), ...(lead ? gemSpec(lead) : {}) }))}
                  style={{ opacity: g.enabled ? 1 : 0.62 }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDrag({ from: g.index, over: null });
                  }}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    if (drag.over !== g.index) setDrag({ ...drag, over: g.index });
                  }}
                  onDragEnd={() => setDrag(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    const d = drag;
                    setDrag(null);
                    if (d && d.from !== g.index) {
                      setSel(g.index);
                      void apply({ kind: 'moveGroup', from: d.from, to: g.index });
                    }
                  }}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      void apply({ kind: 'setGroup', group: g.index, attr: 'enabled', value: !g.enabled });
                      return;
                    }
                    setSel(g.index);
                    setQMode(null);
                    setQ('');
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSel(g.index);
                    if (e.ctrlKey || e.metaKey) void apply({ kind: 'setGroup', group: g.index, attr: 'includeInFullDPS', value: !g.includeInFullDPS });
                    else void apply({ kind: 'setMainGroup', group: g.index });
                  }}
                >
                  {g.source ? <img className="sk-gem-img" src={slotIcon('Body Armour')} alt="" width={22} height={22} /> : lead ? <GemImg name={lead.nameSpec} colour={lead.colour} /> : <img className="sk-gem-img" src={gemFrame('str')} alt="" width={22} height={22} />}
                  <span className="mid">
                    <span className="nm" style={{ color: !g.enabled ? 'var(--text-muted)' : lead ? ATTR[lead.colour].text : 'var(--text-2)' }}>
                      {groupName(g)}
                    </span>
                    {state.mainGroup === g.index && <span className="badge">{tr('SkillsTab.main')}</span>}
                    {g.includeInFullDPS && g.enabled && <span className="badge dim">{tr('SkillsTab.full_dps')}</span>}
                    {sub && <span className="sub">{sub}</span>}
                    {g.gems.length > 1 && (
                      <span className="sk-gl">
                        {g.gems.map((x, i) => (
                          <span key={i} style={{ color: x.known ? ATTR[x.colour].text : 'var(--negative-text)', opacity: x.enabled ? 0.92 : 0.45 }}>
                            {x.nameSpec}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  {warns.length > 0 && (
                    <span className="warn" title={warns.join('\n')} aria-label={warns.join('. ')}>
                      <Icon name="warning" size={14} />
                    </span>
                  )}
                  {gItem && gItem.canHaveSockets && !g.source && (
                    <span className="cnt" data-over={g.gems.length > sockets.length} title={tr('h_rb_Sk.cnt_tip', { g: g.gems.length, s: sockets.length, slot: slotMap.get(g.slot ?? '')?.label || g.slot })}>
                      {g.gems.length}/{sockets.length}
                    </span>
                  )}
                  <span className="dots" title={sockTip}>
                    {dotsFor.slice(0, MAX_DOTS).map((d, i) => (
                      <span key={i} style={{ background: d.c, boxShadow: d.m ? '0 0 0 1.5px rgba(var(--accent-rgb),.55)' : 'none' }} />
                    ))}
                    {dotsFor.length > MAX_DOTS && <span className="more">+{dotsFor.length - MAX_DOTS}</span>}
                  </span>
                </div>
              );
            })}
          </div>

          {undoBar && (
            <div className="sk-undo" role="status">
              <Icon name="trash" size={13} style={{ flex: 'none', color: 'var(--text-muted)' }} />
              <span className="m">{undoBar}</span>
              <button type="button" onClick={() => void undoDelete()}>
                <Icon name="undo" size={12} />
                {tr('SkillsTab.undo')}
              </button>
            </div>
          )}

          <div className="sk-defs">
            <button type="button" className="hd" aria-expanded={defOpen} onClick={() => {
              const v = !defOpen;
              try {
                localStorage.setItem('pom-gemdef-open2', v ? '1' : '0');
              } catch {
                // Not remembered.
              }
              setDefOpen(v);
            }}>
              <span style={{ flex: 1 }}>{tr('SkillsTab.gem_defaults')}</span>
              <Icon name="chevron-down" size={12} style={{ flex: 'none', transform: defOpen ? undefined : 'rotate(-90deg)', transition: 'transform 160ms', color: 'var(--text-muted)' }} />
            </button>
            {defOpen && (
              <div className="body" data-r="gemopt">
                <div className="o">
                  <span className="l">{tr('SkillsTab.sort_gems_by_dps')}</span>
                  <Switch checked={opts.sortGemsByDPS} onChange={(v) => void apply({ kind: 'setSkillsOption', attr: 'sortGemsByDPS', value: v })} label={tr('SkillsTab.sort_gems_by_dps')} />
                  <button ref={sortBtn} type="button" className="sk-sel" style={{ width: 150, opacity: opts.sortGemsByDPS ? 1 : 0.45 }} disabled={!opts.sortGemsByDPS} aria-haspopup="listbox" aria-expanded={menu === 'sortBy'} onClick={tgl('sortBy')}>
                    <span className="val">{SORT_LABEL[opts.sortGemsByDPSField] ?? opts.sortGemsByDPSField}</span>
                    <Icon name="chevron-down" size={12} style={{ flex: 'none', color: 'var(--text-muted)' }} />
                  </button>
                  <PortalMenu anchor={sortBtn} open={menu === 'sortBy'} onClose={closeMenu} role="listbox" label={tr('SkillsTab.sort_gems_by')} minWidth={170}>
                    <div className="sk-menu">
                      {SORT_FIELDS.map((f) => (
                        <button key={f.value} type="button" role="option" aria-selected={f.value === opts.sortGemsByDPSField} className="sk-mi" data-on={f.value === opts.sortGemsByDPSField} onClick={() => { closeMenu(); void apply({ kind: 'setSkillsOption', attr: 'sortGemsByDPSField', value: f.value }); }}>
                          <span className="grow">{label(f.label)}</span>
                          <span className="chk">{f.value === opts.sortGemsByDPSField && <Icon name="check" size={13} />}</span>
                        </button>
                      ))}
                    </div>
                  </PortalMenu>
                </div>
                <div className="o">
                  <span className="l">{tr('SkillsTab.default_gem_level')}</span>
                  <button ref={lvlBtn} type="button" className="sk-sel" style={{ width: 196 }} title={lvlText(GEM_LEVEL_MODES.find((m) => m.value === opts.defaultGemLevel)?.description)} aria-haspopup="listbox" aria-expanded={menu === 'lvl'} onClick={tgl('lvl')}>
                    <span className="val">{lvlText(GEM_LEVEL_MODES.find((m) => m.value === opts.defaultGemLevel)?.label) ?? opts.defaultGemLevel}</span>
                    <Icon name="chevron-down" size={12} style={{ flex: 'none', color: 'var(--text-muted)' }} />
                  </button>
                  <PortalMenu anchor={lvlBtn} open={menu === 'lvl'} onClose={closeMenu} role="listbox" label={tr('SkillsTab.default_gem_level')} minWidth={210}>
                    <div className="sk-menu">
                      {GEM_LEVEL_MODES.map((m) => (
                        <button key={m.value} type="button" role="option" aria-selected={m.value === opts.defaultGemLevel} className="sk-mi" data-on={m.value === opts.defaultGemLevel} title={lvlText(m.description)} onClick={() => { closeMenu(); void apply({ kind: 'setSkillsOption', attr: 'defaultGemLevel', value: m.value }); }}>
                          <span className="grow">{lvlText(m.label)}</span>
                          <span className="chk">{m.value === opts.defaultGemLevel && <Icon name="check" size={13} />}</span>
                        </button>
                      ))}
                    </div>
                  </PortalMenu>
                </div>
                <div className="o">
                  <span className="l">{tr('SkillsTab.default_gem_quality')}</span>
                  <Stepper value={opts.defaultGemQuality} min={0} max={23} label={tr('SkillsTab.default_gem_quality_2')} onChange={(n) => void apply({ kind: 'setSkillsOption', attr: 'defaultGemQuality', value: n })} />
                </div>
                <div className="o">
                  <span className="l">{tr('SkillsTab.show_support_gems')}</span>
                  <div className="sk-seg sm" role="radiogroup" aria-label={tr('SkillsTab.show_support_gems')} data-lg="tile">
                    {SUPPORT_TYPES.map((m) => (
                      <button key={m.value} type="button" role="radio" aria-checked={opts.showSupportGemTypes === m.value} onClick={() => void apply({ kind: 'setSkillsOption', attr: 'showSupportGemTypes', value: m.value })}>
                        {label(m.label)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="o">
                  <span className="l">{tr('SkillsTab.show_legacy_gems')}</span>
                  <Switch checked={opts.showLegacyGems} onChange={(v) => void apply({ kind: 'setSkillsOption', attr: 'showLegacyGems', value: v })} label={tr('SkillsTab.show_legacy_gems')} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="sk-editor" data-lg="panel" data-r="tab-body sk-editor">
        {editorBody ?? (
          <div className="sk-edempty">
            <span className="t">{noGroups ? tr('SkillsTab.no_socket_groups_yet') : tr('SkillsTab.select_a_socket_group')}</span>
            <span className="s">{noGroups ? tr('SkillsTab.paste_one_with_ctrl_v') : tr('SkillsTab.its_gems_sockets_and_levels')}</span>
            {noGroups && (
              <button type="button" className="sk-gold" onClick={() => void newGroup()}>
                <Icon name="plus" size={14} />
                {tr('SkillsTab.new_socket_group')}
              </button>
            )}
          </div>
        )}
      </div>

      {docked && (
        <div className="sk-dock" data-lg="panel" data-r="sk-dock">
          {group && !group.source && sel != null ? (
            <>
              <div className="sk-dock-hd">
                <span className="ttl">
                  {rowMode != null ? (
                    <>
                      {tr('SkillsTab.replace')} <b style={{ color: ATTR[group.gems[rowMode]?.colour ?? 'w'].text }}>{group.gems[rowMode]?.nameSpec}</b>
                    </>
                  ) : (
                    <>
                      {tr('SkillsTab.add_to')} <b style={{ color: leadGem(group) ? ATTR[leadGem(group)!.colour].text : undefined }}>{groupName(group)}</b>
                    </>
                  )}
                </span>
                <div className="sk-seg sm" role="radiogroup" aria-label={tr('SkillsTab.gem_type')} data-lg="tile">
                  {(
                    [
                      [null, tr('SkillsTab_2.all')],
                      ['S', tr('SkillsTab_2.supports')],
                      ['A', tr('SkillsTab_2.skills')],
                    ] as const
                  ).map(([k, t]) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={kind === k}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setKind(k);
                        setQHi(0);
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sk-dock-sub">
                {sortOn ? tr('SkillsTab.sorted_by', { field: SORT_LABEL[field] ?? field }) : tr('SkillsTab.sort_gems_by_dps_is')}
                {q.trim() ? <span className="q"> {tr('SkillsTab.matching_trim', { value: q.trim() })}</span> : null}
              </div>
              {pickerList}
            </>
          ) : (
            <div className="sk-edempty">
              <span className="s">{group?.source ? tr('h_rb_Sk.src_locked') : tr('SkillsTab.select_a_socket_group_to')}</span>
            </div>
          )}
        </div>
      )}

      <PortalMenu anchor={rowBox} open={pickerOpen && rowMode != null && !docked} onClose={closePicker} role="listbox" label={tr('SkillsTab.gems')} minWidth={Math.max(anchorW, 260)}>
        {rowMode != null && pickerList}
      </PortalMenu>

      <SetsPopover
        title={tr('SkillsTab.skill_sets')}
        noun="skill set"
        anchor={manageBtn}
        open={setsPop}
        onClose={() => setSetsPop(false)}
        rows={state.sets}
        current={state.activeSet}
        onUse={(id) => void setOp({ kind: 'skillSet', op: 'activate', id }, true)}
        onRename={(id, title) => void setOp({ kind: 'skillSet', op: 'rename', id, title }, false)}
        onCopy={(id) => void setOp({ kind: 'skillSet', op: 'copy', id, title: `${setTitle(state.sets.find((x) => x.id === id)?.title ?? '')} copy` }, false)}
        onDelete={(id) => void setOp({ kind: 'skillSet', op: 'delete', id }, true)}
        onNew={() => void setOp({ kind: 'skillSet', op: 'new', title: tr('SkillsTab.set_length', { value: state.sets.length + 1 }) }, false)}
        newLabel={tr('SkillsTab.new_skill_set')}
      />
      {dlg === 'new' && (
        <Over>
          <NameDialog
            mode="new"
            title=""
            onCancel={() => setDlg(null)}
            onSave={(title) => {
              setDlg(null);
              void setOp({ kind: 'skillSet', op: 'new', title }, false);
            }}
          />
        </Over>
      )}
      {dlg === 'all' && (
        <Over>
          <Dialog size="small" tone="danger" icon="danger" title={tr('SkillsTab.delete_all')} confirmLabel={tr('SkillsTab.delete')} onCancel={() => setDlg(null)} onConfirm={() => void deleteAll()}>
            <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.5 }}>{tr('SkillsTab.are_you_sure_you_want')}</p>
          </Dialog>
        </Over>
      )}
      {tips.node}
    </div>
  );
}

/** The group label box: edited locally, applied on Enter or when it loses focus. */
function GroupLabel({ value, placeholder, disabled, onCommit }: { value: string; placeholder: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  const esc = useRef(false); // Escape blurs the box, and blur would commit the draft the closure still holds
  return (
    <input
      value={v}
      placeholder={placeholder}
      aria-label={tr('SkillsTab.group_label')}
      maxLength={50}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (esc.current) esc.current = false; else if (v !== value) onCommit(v); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          esc.current = true;
          setV(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
