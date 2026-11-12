import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { BuildEdit, ConfigCatalog, ConfigOptionDef, ConfigState, CustomModBlock } from '@pom/protocol';
import {
  buildCards,
  changedCount,
  checkEditValue,
  CUSTOM_SECTION,
  defaultFor,
  isMapModSlot,
  isSegmented,
  listLabel,
  parseNumberText,
  sanitizeNumber,
  SECTION_LOOK,
  shownValue,
  sortSections,
  stripCodes,
  type CardView,
  type CfgValue,
  type RowView,
} from '../shared/configLogic';
import { compareStats, type CompareLine, type StatMeta } from '../shared/statCompare';
import './configTab.css';
import { CfgDropdown, NumBox, useTips, type DdItem, type TipSpec } from './ConfigParts';
import { ModPicker, ModsBuild } from './ModPicker';
import { appendModLine } from '../shared/modBrowser';
import { engineCall, type EngineHandle } from './engineHandle';
import { useGemIcon } from './configArt';
import { ColorText } from './ColorText';
import type { OpenBuild } from './types';
import { Dialog, Icon, Switch, useToast } from './ui';
import { useHighlight } from './assistant/bus';
import { label as lbl, tr } from './i18n';
/** Matches --ctl-col in tokens.css: the dropdown's own width (CSS makes it fill the value column) and its menu's minimum. */
const CTL_COL = 200;
const tl = (t: string) => { const s = stripCodes(t); const r = lbl(s); return r === s ? t : r; };

export interface ConfigTabProps {
  build: OpenBuild;
  engine: EngineHandle | null;
}

// ---- engine data that never changes ------------------------------------------------------------------------------------

let catalogPromise: Promise<ConfigCatalog> | null = null;
function loadCatalog(): Promise<ConfigCatalog> {
  catalogPromise ??= engineCall('configCatalog', {}).then((r) => r.catalog);
  catalogPromise.catch(() => (catalogPromise = null));
  return catalogPromise;
}

let statMetaPromise: Promise<StatMeta[] | null> | null = null;
/** The display stats (labels and formats) the "will give you" lines use, when the engine has them. */
function loadStatMeta(): Promise<StatMeta[] | null> {
  statMetaPromise ??= (async () => {
    try {
      const r = (await engineCall('statMeta' as never, {} as never)) as unknown;
      const raw = Array.isArray(r) ? r : ((r as { stats?: unknown; meta?: unknown })?.stats ?? (r as { meta?: unknown })?.meta);
      if (!Array.isArray(raw)) return null;
      const list: StatMeta[] = raw.flatMap((e: Record<string, unknown>) => {
        const id = (e.id ?? e.stat) as string | undefined;
        return id && typeof e.label === 'string' && typeof e.fmt === 'string'
          ? [{ id, label: e.label, fmt: e.fmt, lowerIsBetter: !!e.lowerIsBetter, pc: !!e.pc, mod: !!e.mod, compPercent: !!e.compPercent, _flag: !!(e.flag || e.notFlag) } as StatMeta & { _flag: boolean }]
          : [];
      });
      // A stat listed once for attacks and once for spells: the unflagged entry first.
      return list.sort((a, b) => Number((a as StatMeta & { _flag?: boolean })._flag) - Number((b as StatMeta & { _flag?: boolean })._flag));
    } catch {
      return null;
    }
  })();
  return statMetaPromise;
}

// ---- row ---------------------------------------------------------------------------------------------------------------

interface RowCtx {
  getState: () => ConfigState;
  set: (opt: ConfigOptionDef, value: CfgValue | null) => void;
  tipFor: (rv: RowView) => TipSpec | null;
  itemTip: (opt: ConfigOptionDef, val: string | number, label: string, tooltip?: string) => TipSpec;
  bind: ReturnType<typeof useTips>['bind'];
}

const Row = memo(
  function Row({ rv, ctx, version, val, stored, ph, bare }: { rv: RowView; ctx: RowCtx; version: number; val: CfgValue | undefined; stored: CfgValue | undefined; ph: CfgValue | undefined; bare?: boolean }) {
    void version;
    const { opt } = rv;
    const hl = useHighlight();
    const marked = hl?.tab === 'config' && !!opt.var && hl.configKey === opt.var;
    const { set, bind } = ctx;
    const label = stripCodes(tl(opt.label));
    const tip = ctx.tipFor(rv);
    const cls = 'cfg-row' + (rv.changed ? ' on' : '') + (rv.invalid ? ' bad' : '') + (rv.notUsed ? ' dim' : '');
    let control: JSX.Element | null = null;
    if (opt.type === 'check') {
      control = <Switch checked={val === true} label={label} onChange={(v) => set(opt, checkEditValue(opt, ctx.getState(), v))} />;
    } else if (opt.type === 'list' && opt.list) {
      const items: DdItem[] = opt.list.map((l) => ({ val: l.val, label: tl(l.label), search: l.search, tip: ctx.itemTip(opt, l.val, l.label, l.tooltip) }));
      const defVal = opt.list[(opt.defaultIndex ?? 1) - 1]?.val;
      if (isSegmented(opt)) {
        control = (
          <div className="seg cfg-seg" data-lg="tile" role="radiogroup" aria-label={label}>
            {opt.list.map((l) => (
              <button key={String(l.val)} type="button" role="radio" aria-checked={String(l.val) === String(val)} aria-pressed={String(l.val) === String(val)} onClick={() => set(opt, l.val)} {...bind(items.find((i) => i.val === l.val)?.tip ?? null)}>
                <ColorText text={tl(l.label)} />
              </button>
            ))}
          </div>
        );
      } else {
        control = <CfgDropdown value={val as string | number | undefined} items={items} width={CTL_COL} ariaLabel={label} defaultVal={defVal} onPick={(v) => set(opt, v)} bind={bind} />;
      }
    } else if (opt.type === 'count' || opt.type === 'countAllowZero' || opt.type === 'integer' || opt.type === 'float') {
      control = (
        <NumBox
          value={typeof stored === 'number' ? stored : undefined}
          placeholder={ph === undefined ? '' : String(ph)}
          ariaLabel={label}
          sanitize={(t) => sanitizeNumber(opt.type, t)}
          parse={parseNumberText}
          min={opt.type === 'count' || opt.type === 'float' ? 0 : undefined}
          onCommit={(v) => set(opt, v)}
        />
      );
    } else if (opt.type === 'text') {
      control = <textarea className="cfg-text" defaultValue={typeof val === 'string' ? val : ''} aria-label={label} onBlur={(e) => e.target.value !== (val ?? '') && set(opt, e.target.value || null)} />;
    }
    if (bare) {
      return (
        <div className={cls + ' cfg-cell'} data-ck={opt.var} data-assistant-highlight={marked ? opt.var : undefined} {...(tip ? bind(tip) : {})}>
          {control}
        </div>
      );
    }
    return (
      <div className={cls} data-ck={opt.var} data-assistant-highlight={marked ? opt.var : undefined} {...(tip ? bind(tip) : {})}>
        <span className="l">
          <ColorText text={tl(opt.label).replace(/:\s*$/, '')} />
        </span>
        <span className="c">{control}</span>
      </div>
    );
  },
  (a, b) =>
    a.version === b.version &&
    a.rv.opt === b.rv.opt &&
    a.rv.changed === b.rv.changed &&
    a.rv.invalid === b.rv.invalid &&
    a.rv.notUsed === b.rv.notUsed &&
    a.val === b.val &&
    a.stored === b.stored &&
    a.ph === b.ph &&
    a.bare === b.bare &&
    a.ctx === b.ctx,
);

/** Runs of map prefix / suffix options become one group each (drawn as a 2 x 2 grid); everything else stays a single row. */
function groupRows(rows: CardView['rows']): Array<CardView['rows'][number] | RowView[]> {
  const out: Array<CardView['rows'][number] | RowView[]> = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (r.kind === 'row' && isMapModSlot(r.opt)) {
      const prefix = r.opt.var!.startsWith('MapPrefix');
      if (Array.isArray(last) && last[0]!.opt.var!.startsWith('MapPrefix') === prefix) last.push(r);
      else out.push([r]);
    } else out.push(r);
  }
  return out;
}

function SubLabel({ text }: { text: string }) {
  const name = stripCodes(text).replace(/:\s*$/, '');
  const icon = useGemIcon(name);
  return (
    <div className="cfg-sub">
      {icon && <img src={icon} alt="" />}
      <ColorText text={tl(text).replace(/:\s*$/, '')} />
    </div>
  );
}

// ---- custom modifiers --------------------------------------------------------------------------------------------------

type Draft = { title: string; enabled: boolean; text: string };
const toDraft = (b: CustomModBlock): Draft => ({ title: b.title, enabled: b.enabled, text: b.text });

function ModBlock({ draft, committed, onChange, onCommit, onDelete, onToggle, bind }: { draft: Draft; committed: CustomModBlock | undefined; onChange: (d: Draft) => void; onCommit: (d: Draft) => void; onDelete: () => void; onToggle: (on: boolean) => void; bind: ReturnType<typeof useTips>['bind'] }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const hl = useRef<HTMLDivElement>(null);
  const idle = useRef<number>(0);
  const live = draft.enabled && draft.text.trim() !== '';
  const lines = draft.text.split('\n');
  const committedLines = committed ? committed.text.split('\n') : [];
  const schedule = (d: Draft) => {
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => onCommit(d), 800);
  };
  useEffect(() => () => window.clearTimeout(idle.current), []);
  const rows = Math.min(10, Math.max(2, lines.length));
  const [picking, setPicking] = useState(false);
  return (
    <div className={'cfg-mod' + (live ? ' live' : '')} data-mod="">
      {picking && (
        <ModPicker
          onClose={() => {
            setPicking(false);
            requestAnimationFrame(() => ta.current?.focus());
          }}
          onPick={(line) => {
            const d = { ...draft, text: appendModLine(draft.text, line) };
            onChange(d);
            window.clearTimeout(idle.current);
            onCommit(d);
          }}
        />
      )}
      <div className="top">
        <Switch checked={draft.enabled} label={tr('ConfigTab.enable_mod_group')} onChange={onToggle} />
        <input
          className="t"
          type="text"
          value={draft.title}
          placeholder={tr('ConfigTab.mod_group_name')}
          aria-label={tr('ConfigTab.mod_group_name')}
          onChange={(e) => {
            const d = { ...draft, title: e.target.value };
            onChange(d);
            schedule(d);
          }}
          onBlur={() => {
            window.clearTimeout(idle.current);
            onCommit(draft);
          }}
        />
        <button
          type="button"
          className="cfg-ico"
          aria-label={tr('ConfigTab.add_mod')}
          onClick={() => setPicking(true)}
          {...bind({ text: tr('ConfigTab.pick_a_modifier_from_the') })}
        >
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="cfg-ico del" aria-label={tr('ConfigTab.delete_mod_group')} title={tr('ConfigTab.delete_mod_group')} onClick={onDelete}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div className="edit">
        <div className="hl" ref={hl} aria-hidden>
          {lines.map((l, i) => {
            const known = committed && committedLines[i] === l ? committed.lineOk[i] : undefined;
            return (
              <div key={i} className={known === true ? 'ok' : known === false && l.trim() ? 'bad' : ''}>
                {l || ' '}
              </div>
            );
          })}
        </div>
        <textarea
          ref={ta}
          value={draft.text}
          rows={rows}
          spellCheck={false}
          placeholder={tr('ConfigTab.one_modifier_per_line_e')}
          aria-label={tr('ConfigTab.modifiers')}
          onScroll={(e) => hl.current && (hl.current.scrollTop = e.currentTarget.scrollTop)}
          onChange={(e) => {
            const d = { ...draft, text: e.target.value };
            onChange(d);
            schedule(d);
          }}
          onBlur={() => {
            window.clearTimeout(idle.current);
            onCommit(draft);
          }}
        />
      </div>
    </div>
  );
}

function CustomMods({ blocks, onCommit, onToast, bind }: { blocks: CustomModBlock[]; onCommit: (b: Draft[], note?: { text: string; undo?: boolean }) => void; onToast: () => void; bind: ReturnType<typeof useTips>['bind'] }) {
  void onToast;
  const sig = JSON.stringify(blocks.map(toDraft));
  const [drafts, setDrafts] = useState<Draft[]>(() => blocks.map(toDraft));
  const dirty = useRef(false);
  const latest = useRef(drafts);
  latest.current = drafts;
  useEffect(() => {
    if (!dirty.current) setDrafts(blocks.map(toDraft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const commit = (next: Draft[], note?: { text: string; undo?: boolean }) => {
    dirty.current = false;
    onCommit(next, note);
  };
  const change = (i: number, d: Draft) => {
    dirty.current = true;
    setDrafts((cur) => cur.map((x, j) => (j === i ? d : x)));
  };
  // A blur or idle commit sends the whole list, using the newest text of every block.
  const commitBlock = (i: number, d: Draft) => {
    const next = latest.current.map((x, j) => (j === i ? d : x));
    if (JSON.stringify(next) === sig) {
      dirty.current = false;
      return;
    }
    commit(next);
  };
  return (
    <>
      {drafts.map((d, i) => (
        <ModBlock
          key={i}
          draft={d}
          committed={blocks[i]}
          bind={bind}
          onChange={(nd) => change(i, nd)}
          onCommit={(nd) => commitBlock(i, nd)}
          onToggle={(on) => commit(latest.current.map((x, j) => (j === i ? { ...x, enabled: on } : x)))}
          onDelete={() => commit(latest.current.filter((_, j) => j !== i), { text: tr('h_rA_cfg.deleted_x', { title: d.title || tr('h_rA_cfg.mod_group') }), undo: true })}
        />
      ))}
      <div className="cfg-addgroup">
        <button
          type="button"
          className="cfg-btn"
          data-lg="control"
          onClick={() => {
            dirty.current = true;
            const next = [...latest.current, { title: 'Group ' + (latest.current.length + 1), enabled: true, text: '' }];
            setDrafts(next);
            commit(next);
          }}
        >
          <Icon name="plus" size={14} />
          {tr('ConfigTab.add_mod_group')}
        </button>
      </div>
    </>
  );
}

// ---- the tab -----------------------------------------------------------------------------------------------------------

const remembered = new Map<string, { q: string; showAll: boolean; onlyChanged: boolean }>();

/**
 * Two balanced columns of cards without CSS multi-column. With cards that may not break across columns, the browser's own
 * balancing laid the whole tab out about fifteen times over: 340 to 410 ms per layout, against 21 ms without it, on every
 * open and every keystroke in the search box. The cards wrap as a column flex box instead, and this sets the shortest
 * height that holds them in two columns in order, which is the same split the multi-column layout arrived at.
 */
function useBalancedColumns(ref: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const GAP = 14;
    let last = '-';
    const fit = () => {
      const kids = [...el.children] as HTMLElement[];
      const min = Number(getComputedStyle(el).getPropertyValue('--col-min')) || 420;
      const two = kids.length > 1 && el.clientWidth >= min * 2 + GAP;
      let h = 0;
      if (two) {
        const hs = kids.map((k) => k.offsetHeight + GAP);
        const total = hs.reduce((a, b) => a + b, 0);
        let acc = 0;
        let best = total;
        for (const x of hs) {
          acc += x;
          best = Math.min(best, Math.max(acc, total - acc));
        }
        // One pixel of slack per card covers heights rounded down; the 14 is the bottom padding.
        h = best + kids.length + GAP;
      }
      const key = two ? String(h) : '';
      if (key === last) return;
      last = key;
      if (two) {
        el.dataset.cols = '2';
        el.style.height = `${h}px`;
      } else {
        delete el.dataset.cols;
        el.style.height = '';
      }
    };
    const ro = new ResizeObserver(fit);
    const watch = () => {
      ro.disconnect();
      ro.observe(el);
      for (const k of el.children) ro.observe(k);
    };
    const mo = new MutationObserver(() => {
      watch();
      fit();
    });
    mo.observe(el, { childList: true });
    watch();
    fit();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref]);
}

export function ConfigTab({ build, engine }: ConfigTabProps) {
  const toast = useToast();
  const tips = useTips();
  const { bind } = tips;
  const [catalog, setCatalog] = useState<ConfigCatalog | null>(null);
  const [state, setState] = useState<ConfigState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The search, Show All and Show only changed settings come back when the tab is opened again.
  const mem = remembered.get(build.id);
  const [q, setQ] = useState(mem?.q ?? '');
  const [showAll, setShowAll] = useState(mem?.showAll ?? false);
  const [onlyChanged, setOnlyChanged] = useState(mem?.onlyChanged ?? false);
  useEffect(() => {
    remembered.set(build.id, { q, showAll, onlyChanged });
  }, [build.id, q, showAll, onlyChanged]);
  // Collapsed sections (upstream's +/- on each section header); UI state only, kept while the tab is open.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem('pom-config-collapsed') || '[]'));
    } catch {
      return new Set<string>();
    }
  });
  const toggleSection = (title: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (!next.delete(title)) next.add(title);
      try {
        localStorage.setItem('pom-config-collapsed', JSON.stringify([...next]));
      } catch {
        /* private window */
      }
      return next;
    });
  const [setMenu, setSetMenu] = useState(false);
  const [manage, setManage] = useState(false);
  const [ren, setRen] = useState<{ id: number; draft: string; isNew: boolean } | null>(null);
  // While a new set is being made: the ids that existed before it. The new row draws as the rename box at once, not as a plain row first.
  const [newBefore, setNewBefore] = useState<Set<number> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<HTMLDivElement>(null);
  useBalancedColumns(cols);
  const search = useRef<HTMLInputElement>(null);
  const setBtn = useRef<HTMLDivElement>(null);
  const manBtn = useRef<HTMLButtonElement>(null);
  const manPop = useRef<HTMLDivElement>(null);
  const setPop = useRef<HTMLDivElement>(null);
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const version = engine?.version ?? 0;
  const buildId = engine?.buildId ?? null;

  // The catalog once; the state again after every engine change.
  useEffect(() => {
    let live = true;
    loadCatalog().then(
      (c) => live && setCatalog(c),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng) return null;
    const mine = ++seq.current;
    try {
      const r = await eng.call('configState', {});
      if (seq.current === mine) {
        setState(r.state);
        setError(null);
      }
      return r.state;
    } catch (e) {
      if (seq.current === mine) setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);
  useEffect(() => {
    if (buildId) void reload();
    else setState(null);
  }, [buildId, version, reload]);

  // ---- edits ----
  const run = useCallback(
    async (edit: BuildEdit, optimistic?: (s: ConfigState) => ConfigState) => {
      const eng = engineRef.current;
      if (!eng) return false;
      if (optimistic) setState((s) => (s ? optimistic(s) : s));
      try {
        await eng.edit(edit);
        return true;
      } catch (e) {
        toast({ text: tr('h_rA_cfg.change_failed', { error: e instanceof Error ? e.message : String(e) }), kind: 'error' });
        void reload();
        return false;
      }
    },
    [reload, toast],
  );
  const setOption = useCallback(
    (opt: ConfigOptionDef, value: CfgValue | null) => {
      if (opt.var === undefined) return;
      const key = opt.var;
      void run({ kind: 'setConfig', key, value }, (s) => {
        const values = { ...s.values };
        if (value === null) delete values[key];
        else values[key] = value;
        return { ...s, values };
      });
    },
    [run],
  );
  const commitMods = useCallback(
    (blocks: Draft[], note?: { text: string; undo?: boolean }) => {
      void run({ kind: 'setCustomMods', blocks }).then((ok) => {
        if (ok && note) toast({ text: note.text, action: note.undo ? { label: tr('ConfigTab.undo'), run: () => void engineRef.current?.undo() } : undefined, ttl: 6000 });
      });
    },
    [run, toast],
  );

  // ---- tooltips ----
  const previews = useRef(new Map<string, CompareLine[] | null>());
  useEffect(() => previews.current.clear(), [version, buildId]);
  const compareFor = useCallback(
    (edit: BuildEdit) => async () => {
      const eng = engineRef.current;
      const meta = await loadStatMeta();
      if (!eng || !meta) return null;
      const key = JSON.stringify(edit);
      if (previews.current.has(key)) return previews.current.get(key) ?? null;
      try {
        const r = await eng.preview(edit);
        const lines = compareStats(r.changed, meta);
        previews.current.set(key, lines);
        return lines;
      } catch {
        return null;
      }
    },
    [],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctx: RowCtx = useMemo(
    () => ({
      getState: () => stateRef.current as ConfigState,
      set: setOption,
      bind,
      tipFor: (rv) => {
        const { opt } = rv;
        const st = stateRef.current as ConfigState;
        const parts: string[] = [];
        if (opt.tooltip) parts.push(opt.tooltip);
        if (opt.var && st.dynamicTooltips[opt.var]) parts.push(st.dynamicTooltips[opt.var]!);
        if (opt.ifNodeNames?.length) parts.push(opt.ifNodeNames.map((n) => tr('ConfigTab.this_option_is_specific_to', { n })).join('\n'));
        if (rv.invalid) parts.push(tr('ConfigTab_2.t_1this_config_option_is_conditional_with'));
        else if (rv.notUsed) parts.push(tr('ConfigTab.not_used_by_this_build'));
        const spec: TipSpec = { text: parts.join('\n') || undefined };
        if (opt.type === 'check' && opt.var && !rv.invalid) {
          const cur = shownValue(opt, st) === true;
          spec.header = tr('ConfigTab_2.toggling_this_option_will_give_you');
          spec.compare = compareFor({ kind: 'setConfig', key: opt.var, value: checkEditValue(opt, st, !cur) });
        }
        return spec.text || spec.compare ? spec : null;
      },
      itemTip: (opt, val, _label, tooltip) => {
        const spec: TipSpec = { text: tooltip };
        const st = stateRef.current as ConfigState;
        if (opt.var && String(shownValue(opt, st)) !== String(val)) {
          spec.header = tr('ConfigTab_2.selecting_this_option_will_give_you');
          spec.compare = compareFor({ kind: 'setConfig', key: opt.var, value: val });
        }
        return spec;
      },
    }),
    [setOption, bind, compareFor],
  );

  // ---- derived ----
  // The cards follow the search text one render behind, so each keystroke shows in the box at once; the cards end up the same.
  const dq = useDeferredValue(q);
  const cards: CardView[] = useMemo(() => (catalog && state ? buildCards(catalog, state, { q: dq, showAll, onlyChanged }) : []), [catalog, state, dq, showAll, onlyChanged]);
  const nChanged = catalog && state ? changedCount(catalog, state) : 0;
  const activeSet = state?.sets.find((s) => s.id === state.activeSet) ?? state?.sets[0];

  // ---- keys: Ctrl F, Ctrl Z / Y outside fields, Esc ----
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so these keys only act on the tab on screen.
  useLayoutEffect(() => {
    const kd = (e: KeyboardEvent) => {
      const r = root.current;
      if (!r || !r.offsetParent) return;
      const a = document.activeElement;
      const inField = !!a && /INPUT|TEXTAREA/.test(a.tagName);
      if (e.key === 'Escape') {
        if (document.querySelector('.dialog')) return; // a dialog on top takes Escape first (e.g. the delete confirmation over the sets panel)
        if (ren) {
          e.stopPropagation();
          cancelRen();
        } else if (manage || setMenu) {
          e.stopPropagation();
          setManage(false);
          setSetMenu(false);
        } else if (q && a === search.current) {
          e.stopPropagation();
          setQ('');
        }
        return;
      }
      if (e.key === 'F2' && manage && state) {
        const s = state.sets.find((x) => x.id === state.activeSet);
        if (s && !ren) setRen({ id: s.id, draft: s.title, isNew: false });
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        e.preventDefault();
        e.stopPropagation();
        search.current?.focus();
        search.current?.select();
      } else if (!inField && (k === 'z' || k === 'y')) {
        e.preventDefault();
        e.stopPropagation();
        const eng = engineRef.current;
        if (eng) void (k === 'y' || e.shiftKey ? eng.redo() : eng.undo());
      }
    };
    window.addEventListener('keydown', kd, true);
    return () => window.removeEventListener('keydown', kd, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ren, manage, setMenu, q, state]);

  // Close the menus on a press outside them.
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so it only listens for the tab on screen.
  useLayoutEffect(() => {
    if (!manage && !setMenu) return;
    const pd = (e: PointerEvent) => {
      const t = e.target as Node;
      if (manage && !manPop.current?.contains(t) && !manBtn.current?.contains(t)) {
        setManage(false);
        setRen(null);
      }
      if (setMenu && !setPop.current?.contains(t) && !setBtn.current?.contains(t)) setSetMenu(false);
    };
    document.addEventListener('pointerdown', pd, true);
    return () => document.removeEventListener('pointerdown', pd, true);
  }, [manage, setMenu]);

  // ---- config sets ----
  const sets = state?.sets ?? [];
  const activate = (id: number) => void run({ kind: 'configSet', op: 'activate', id });
  const newest = async (): Promise<{ id: number; title: string } | null> => {
    const st = await reload();
    if (!st) return null;
    const s = st.sets.reduce((a, b) => (b.id > a.id ? b : a), st.sets[0]!);
    return { id: s.id, title: s.title };
  };
  const newSet = async (copyOf?: number) => {
    setNewBefore(new Set(sets.map((x) => x.id)));
    try {
      const ok = await run(copyOf === undefined ? { kind: 'configSet', op: 'new' } : { kind: 'configSet', op: 'copy', id: copyOf });
      if (!ok) return;
      const n = await newest();
      if (!n) return;
      // Making the new set the active one follows the user's own copy or new: it joins that undo step.
      await run({ kind: 'configSet', op: 'activate', id: n.id, amend: true } as unknown as BuildEdit);
      setManage(true);
      setRen({ id: n.id, draft: n.title, isNew: copyOf === undefined });
    } finally {
      setNewBefore(null);
    }
  };
  const commitRen = () => {
    const r = ren;
    if (!r) return;
    setRen(null);
    const t = r.draft.trim();
    if (t) void run({ kind: 'configSet', op: 'rename', id: r.id, title: t });
  };
  function cancelRen() {
    const r = ren;
    setRen(null);
    if (r?.isNew) void run({ kind: 'configSet', op: 'delete', id: r.id });
  }
  const [confirmDel, setConfirmDel] = useState<{ id: number; title: string } | null>(null);
  const deleteSet = (id: number, title: string) => {
    if (sets.length < 2) return;
    setConfirmDel({ id, title });
  };
  const reallyDelete = () => {
    const c = confirmDel;
    setConfirmDel(null);
    if (!c) return;
    void run({ kind: 'configSet', op: 'delete', id: c.id }).then((ok) => ok && toast({ text: tr('h_rA_cfg.deleted_x', { title: c.title }), action: { label: tr('ConfigTab.undo'), run: () => void engineRef.current?.undo() }, ttl: 6000 }));
  };
  // Dragging a set in the Manage list moves it to the place it is dropped on (`ConfigSetListControl`).
  const [drag, setDrag] = useState<{ id: number; over: number | null } | null>(null);
  useEffect(() => {
    if (ren) requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>('[data-ren="1"]')?.select());
  }, [ren?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const jump = (title: string) => {
    const sc = scroller.current;
    const c = sc?.querySelector<HTMLElement>(`[data-sec="${CSS.escape(title)}"]`);
    if (!sc || !c) return;
    if (collapsed.has(title)) toggleSection(title);
    sc.scrollTo({ top: c.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 4, behavior: 'smooth' });
  };

  // ---- render ----
  if (!engine) {
    return (
      <div className="tabroot cfg-root" data-screen-label="Configuration / Tab / Content" ref={root}>
        <div className="cfg-note" role="status">
          <b>{tr('ConfigTab.no_configuration_yet')}</b> {tr('ConfigTab.the_calculation_engine_is_not')}
          {build.engine.state === 'unavailable' && <span> {build.engine.reason}</span>}
          {build.engine.state === 'loading' && <span> {tr('ConfigTab.the_engine_is_still_calculating')}</span>}
        </div>
      </div>
    );
  }
  if (error && !state) {
    return (
      <div className="tabroot cfg-root" data-screen-label="Configuration / Tab / Content" ref={root}>
        <div className="cfg-note" role="alert">
          <b>{tr('ConfigTab.couldn_t_read_the_configuration')}</b> {error}
        </div>
      </div>
    );
  }
  const loading = !catalog || !state;
  const sections = catalog ? sortSections(catalog.sections) : [];
  const empty = !loading && cards.length === 0;
  return (
    <div className="tabroot cfg-root" data-screen-label="Configuration / Tab / Content" ref={root}>
      {tips.host}
      <div className="cfg-tb tab-tb" data-lg="panel">
        <div ref={setBtn} className="cfg-setwrap">
          <button
            type="button"
            className="cfg-set"
            data-mt="set"
            aria-haspopup="listbox"
            aria-expanded={setMenu}
            onClick={() => {
              setManage(false);
              setSetMenu((v) => !v);
            }}
            disabled={loading}
          >
            <span className="tx">
              <span className="k">{tr('ConfigTab.config_set')}</span>
              <span className="v">{activeSet?.title ?? ''}</span>
            </span>
            <Icon name="chevron-down" size={12} />
          </button>
          {setMenu && (
            <div ref={setPop} className="cfg-pop cfg-setmenu" data-lg="pop" data-solid="" role="listbox" aria-label={tr('ConfigTab.config_sets')}>
              {sets.map((s) => (
                <button key={s.id} type="button" role="option" aria-selected={s.id === state?.activeSet} className="cfg-mi" onClick={() => { activate(s.id); setSetMenu(false); }}>
                  <span className="tx">{s.title}</span>
                  <span className="r">{tr('ConfigTab.changed_changed', { changed: s.changed })}</span>
                  <span className="ck">{s.id === state?.activeSet && <Icon name="check" size={13} />}</span>
                </button>
              ))}
              <div className="sep" />
              <button type="button" className="cfg-mi" onClick={() => { setSetMenu(false); void newSet(); }}>
                <Icon name="plus" size={14} />
                <span className="tx">{tr('ConfigTab.new_config_set')}</span>
              </button>
            </div>
          )}
        </div>
        <button ref={manBtn} type="button" className="cfg-btn" data-lg="control" data-mt="manage" aria-expanded={manage} aria-label={tr('ConfigTab.manage')} title={tr('ConfigTab.manage')} disabled={loading} onClick={() => { setSetMenu(false); setManage((v) => !v); setRen(null); }}>
          <Icon name="sliders" size={16} />
          <span className="cfg-bt">{tr('ConfigTab.manage')}</span>
        </button>
        <div className="cfg-search" data-lg="tile">
          <Icon name="search" size={16} />
          <input ref={search} type="text" value={q} placeholder={tr('ConfigTab.search')} aria-label={tr('ConfigTab.search_configuration')} title={tr('ConfigTab.ctrl_f')} onChange={(e) => setQ(e.target.value.slice(0, 100))} />
          {q && (
            <button type="button" aria-label={tr('ConfigTab.clear_search')} onClick={() => { setQ(''); search.current?.focus(); }}>
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
        <div className="right">
          <button type="button" role="switch" className={'cfg-oc' + (showAll ? ' on' : '')} aria-checked={showAll} title={showAll ? tr('ConfigTab.hide_options_this_build_does') : tr('ConfigTab.also_show_options_this_build')} onClick={() => setShowAll((v) => !v)}>
            <span className="trk">
              <span className="knob" />
            </span>
            {tr('ConfigTab.show_all_configurations')}
          </button>
          <button type="button" role="switch" className={'cfg-oc' + (onlyChanged ? ' on' : '')} aria-checked={onlyChanged} title={nChanged ? tr('ConfigTab.count_options_in_this_config', { count: nChanged }) : tr('ConfigTab.every_option_in_this_config')} onClick={() => setOnlyChanged((v) => !v)}>
            <span className="trk">
              <span className="knob" />
            </span>
            {tr('ConfigTab.show_only_changed_nchanged', { nChanged })}
          </button>
        </div>
      </div>

      {manage && state && (
        <div ref={manPop} className="cfg-pop cfg-manage" data-lg="pop" data-solid="" role="dialog" aria-label={tr('ConfigTab.manage_config_sets')} style={{ left: Math.max(8, (manBtn.current?.offsetLeft ?? 0) + (manBtn.current?.offsetParent ? (manBtn.current.offsetParent as HTMLElement).offsetLeft : 0)), top: (manBtn.current?.offsetTop ?? 0) + (manBtn.current?.offsetHeight ?? 40) + 6 + (manBtn.current?.offsetParent ? (manBtn.current.offsetParent as HTMLElement).offsetTop : 0) }}>
          <div className="hd">
            <span>{tr('ConfigTab.config_sets')}</span>
            <button type="button" className="cfg-ico" aria-label={tr('ConfigTab.close')} onClick={() => { setManage(false); setRen(null); }}>
              <Icon name="x" size={13} />
            </button>
          </div>
          <div className="rows">
            {sets.map((s) => {
              const cur = s.id === state.activeSet;
              const editing = ren?.id === s.id || (!ren && !!newBefore && !newBefore.has(s.id));
              return (
                <div
                  key={s.id}
                  className={'r' + (cur ? ' cur' : '') + (drag && drag.over === s.id && drag.id !== s.id ? ' over' : '')}
                  draggable={!editing}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDrag({ id: s.id, over: null });
                  }}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    if (drag.over !== s.id) setDrag({ ...drag, over: s.id });
                  }}
                  onDragEnd={() => setDrag(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    const d = drag;
                    setDrag(null);
                    const to = sets.findIndex((x) => x.id === s.id) + 1;
                    if (d && d.id !== s.id && to > 0) void run({ kind: 'configSet', op: 'move', id: d.id, to });
                  }}
                >
                  <span className="cfg-grip" aria-hidden="true" title={tr('ConfigTab.drag_to_change_the_order')}>
                    <Icon name="grip" size={13} />
                  </span>
                  {editing ? (
                    <input
                      data-ren="1"
                      type="text"
                      value={ren?.draft ?? s.title}
                      aria-label={tr('ConfigTab.enter_name_for_this_config')}
                      onChange={(e) => ren && setRen({ ...ren, draft: e.target.value.slice(0, 100) })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRen();
                        }
                      }}
                      onBlur={commitRen}
                    />
                  ) : (
                    <button type="button" className="nm" title={tr('ConfigTab.switch_to_this_set')} onClick={() => activate(s.id)} onDoubleClick={() => setRen({ id: s.id, draft: s.title, isNew: false })}>
                      <span className="t">{s.title}</span>
                      {cur && <span className="cu">{tr('ConfigTab.current')}</span>}
                      <span className="n">{tr('ConfigTab.changed_changed', { changed: s.changed })}</span>
                    </button>
                  )}
                  <button type="button" className="cfg-ico" aria-label={tr('ConfigTab.rename')} title={tr('ConfigTab.rename')} onClick={() => setRen({ id: s.id, draft: s.title, isNew: false })}>
                    <Icon name="edit" size={13} />
                  </button>
                  <button type="button" className="cfg-ico" aria-label={tr('ConfigTab.copy')} title={tr('ConfigTab.copy')} onClick={() => void newSet(s.id)}>
                    <Icon name="copy" size={13} />
                  </button>
                  <button type="button" className="cfg-ico del" aria-label={tr('ConfigTab.delete')} title={sets.length < 2 ? tr('ConfigTab.keep_at_least_one_config') : tr('h_rA_cfg.delete_x', { title: s.title })} disabled={sets.length < 2} onClick={() => deleteSet(s.id, s.title)}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="ft">
            <button type="button" className="cfg-btn" onClick={() => void newSet()}>
              <Icon name="plus" size={14} />
              {tr('ConfigTab.new_config_set')}
            </button>
          </div>
        </div>
      )}
      {confirmDel && (
        <Dialog tone="danger" size="small" icon="danger" title={tr('ConfigTab.delete_config_set')} confirmLabel={tr('ConfigTab.delete')} onCancel={() => setConfirmDel(null)} onConfirm={reallyDelete}>
          <span style={{ color: 'var(--text-2)', lineHeight: 1.55 }}>{tr('ConfigTab.are_you_sure_you_want', { title: confirmDel.title || tr('ConfigTab.default') })}</span>
        </Dialog>
      )}

      <div className="cfg-body" data-r="tab-body cfg-grid" ref={scroller}>
        <nav className="cfg-nav" data-r="cfg-nav" aria-label={tr('ConfigTab.config_sections')}>
          {sections.map((s) => {
            const look = SECTION_LOOK[s.title] ?? { nav: s.title, icon: 'settings', tone: 'var(--stat-neutral)' };
            return (
              <button key={s.title} type="button" style={{ opacity: cards.some((c) => c.section.title === s.title) ? 1 : 0.4 }} onClick={() => jump(s.title)}>
                <Icon name={look.icon} size={14} />
                <span className="t">{lbl(look.nav)}</span>
              </button>
            );
          })}
        </nav>
        <div ref={cols} className="cfg-cols" data-r="cfg-cols">
          {loading && <div className="cfg-card cfg-hint">{tr('ConfigTab.reading_the_configuration')}</div>}
          {empty && (
            <div className="cfg-card cfg-empty" data-lg="panel">
              <span className="tx">{dq.trim() ? tr(onlyChanged ? 'h_rA_cfg.no_match_changed' : 'h_rA_cfg.no_match', { query: dq.trim() }) : tr('ConfigTab.nothing_is_changed_from_default')}</span>
              <button type="button" onClick={() => { setQ(''); setOnlyChanged(false); }}>
                <Icon name="eye" size={14} />
                {tr('ConfigTab.show_everything')}
              </button>
            </div>
          )}
          {cards.map((c) => {
            const look = SECTION_LOOK[c.section.title] ?? { nav: c.section.title, icon: 'settings', tone: 'var(--stat-neutral)' };
            return (
              <section key={c.section.title} className="cfg-card" data-lg="panel" data-card="" data-sec={c.section.title} style={{ ['--tone' as string]: look.tone }}>
                <button type="button" className="ttl" aria-expanded={!collapsed.has(c.section.title)} title={collapsed.has(c.section.title) ? tr('ConfigTab.expand_this_section') : tr('ConfigTab.collapse_this_section')} onClick={() => toggleSection(c.section.title)}>
                  <Icon name={look.icon} size={18} />
                  <span className="ttl-t">{lbl(c.section.title)}</span>
                  <Icon name="chevron-down" size={14} />
                </button>
                {!collapsed.has(c.section.title) &&
                  groupRows(c.rows).map((g) => {
                    const row = (r: RowView, bare?: boolean) => <Row key={r.opt.index} rv={r} ctx={ctx} version={version} val={state ? shownValue(r.opt, state) : undefined} stored={r.opt.var && state ? state.values[r.opt.var] : undefined} ph={r.opt.var && state ? state.placeholders[r.opt.var] : undefined} bare={bare} />;
                    if (Array.isArray(g)) return <div key={'g' + g[0]!.opt.index} className="cfg-multi"><div className="cfg-cap">{tl(g[0]!.opt.label).replace(/:\s*$/, '')}</div><div className="cfg-grid4">{g.map((r) => row(r, true))}</div></div>;
                    return g.kind === 'sub' ? <SubLabel key={'s' + g.opt.index} text={g.opt.label} /> : row(g);
                  })}
                {c.custom && state && !collapsed.has(c.section.title) && (
                  <ModsBuild.Provider value={buildId}>
                    <CustomMods blocks={state.customMods} onCommit={commitMods} onToast={() => undefined} bind={bind} />
                  </ModsBuild.Provider>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Kept so the section title check stays next to the custom section's rendering.
void CUSTOM_SECTION;
void defaultFor;
void listLabel;
