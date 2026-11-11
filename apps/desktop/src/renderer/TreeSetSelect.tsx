// The Tree tab's tree select: every tree set with its allocated passive points, a hover card that says what switching to it
// would give you (the engine's numbers) and what the respec costs, and the "Manage trees…" entry (TreeTab.lua `specSelect`).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { compareLines, normaliseOutput, type CompareLine, type NumberFormat } from './displayStats';
import { engineSend, type EngineBuild } from './engineBuild';
import { setActiveSpec } from './buildSkills';
import { respecCost } from '../shared/treeSets';
import { useSpecData, type SpecRow } from './treeSetsData';
import { Icon, Kbd, PortalMenu } from './ui';
import './treeSets.css';
import { tr } from './i18n';

/** The card lists this many changed stats; a switch between very different trees changes dozens. */
const MAX_LINES = 12;
const classColour = (name: string) => (name ? `var(--class-${name.toLowerCase()})` : 'var(--text-strong)');

interface Hover {
  row: SpecRow;
  top: number;
  menuLeft: number;
  menuRight: number;
}

export function TreeSetSelect({ eng, xml, level, width, fmt, onManage }: { eng: EngineBuild; xml: string; level: number; width: number | string; fmt: NumberFormat; onManage: () => void }) {
  const data = useSpecData(xml);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const [lines, setLines] = useState<CompareLine[] | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);
  const rows = data.rows;
  const cur = rows.find((r) => r.active) ?? rows[0];
  const count = rows.length + 1; // the trees and the Manage entry
  const close = useCallback(() => {
    setOpen(false);
    setHover(null);
  }, []);
  const pick = (i: number) => {
    close();
    if (i !== data.active) void eng.editXml((x) => setActiveSpec(x, i)).catch(() => undefined);
  };

  // What switching to the hovered tree would give you: the engine's numbers for the build with that tree active.
  useEffect(() => {
    const id = ++seq.current;
    setLines(null);
    if (!hover || hover.row.active || !eng.buildId) return;
    const t = window.setTimeout(() => {
      const buildId = eng.buildId!;
      void (async () => {
        const { buildXml } = await engineSend('getBuildXml', { buildId });
        const r = await eng.preview({ kind: 'setXml', xml: setActiveSpec(buildXml, hover.row.index) });
        if (id !== seq.current) return;
        const after = { ...eng.stats };
        for (const d of r.changed) {
          if (d.after === null) delete after[d.statId];
          else after[d.statId] = d.after;
        }
        setLines(compareLines(eng.stats, normaliseOutput(after), eng.flags, fmt));
      })().catch(() => id === seq.current && setLines([]));
    }, 140);
    return () => window.clearTimeout(t);
  }, [hover?.row.index, hover?.row.active, eng.buildId, eng.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setActive(Math.max(0, rows.findIndex((r) => r.active)));
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + count) % count);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (active >= rows.length) {
        close();
        onManage();
      } else if (rows[active]) pick(rows[active]!.index);
    }
  };

  const showHover = (r: SpecRow, el: HTMLElement) => {
    const menu = el.closest('.menu.portal')?.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    setHover({ row: r, top: rect.top, menuLeft: menu?.left ?? rect.left, menuRight: menu?.right ?? rect.right });
  };

  const label = cur ? cur.short : tr('TreeSetSelect_2.default');
  return (
    <div style={{ position: 'relative', flex: 'none', width }}>
      <button
        ref={trigger}
        type="button"
        className="select"
        style={{ width: '100%' }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tr('TreeSetSelect.passive_tree')}
        onClick={() => {
          if (open) close();
          else {
            setActive(Math.max(0, rows.findIndex((r) => r.active)));
            setOpen(true);
          }
        }}
        onKeyDown={onKey}
      >
        <span className="label">{label}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <PortalMenu anchor={trigger} open={open} onClose={close} role="listbox" label={tr('TreeSetSelect.passive_tree')} minWidth={362} className="ts-menu">
        <div className="menu-head">{tr('TreeSetSelect.passive_trees')}</div>
        <div className="ts-opts">
        {rows.map((r, i) => (
          <button
            key={r.index}
            type="button"
            role="option"
            aria-selected={r.active}
            data-active={i === active}
            className="menu-item ts-opt"
            onMouseEnter={(e) => {
              setActive(i);
              showHover(r, e.currentTarget);
            }}
            onMouseLeave={() => setHover(null)}
            onClick={() => pick(r.index)}
          >
            <span className="grow">{r.short}</span>
            <span className="pts">{r.counts ? r.counts.used : '…'} {tr('TreeSetSelect.pts')}</span>
            <span className="ck">{r.active && <Icon name="check" size={14} />}</span>
          </button>
        ))}
        </div>
        <div className="menu-sep" />
        <button
          type="button"
          role="option"
          aria-selected={false}
          data-active={active === rows.length}
          className="menu-item ts-manage-row"
          onMouseEnter={() => { setActive(rows.length); setHover(null); }}
          onClick={() => {
            close();
            onManage();
          }}
        >
          <span className="grow">{tr('TreeSetSelect.manage_trees')}</span>
          <Kbd>Ctrl M</Kbd>
        </button>
      </PortalMenu>
      {open && hover && <HoverCard hover={hover} cur={cur} rows={rows} level={level} lines={lines} data={data} />}
    </div>
  );
}

function HoverCard({ hover, cur, rows, level, lines, data }: { hover: Hover; cur: SpecRow | undefined; rows: SpecRow[]; level: number; lines: CompareLine[] | null; data: ReturnType<typeof useSpecData> }) {
  const r = hover.row;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Placed before paint, so the first frame shown is already in place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = hover.menuRight + 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, hover.menuLeft - 8 - w);
    setPos({ left, top: Math.max(8, Math.min(hover.top - 8, window.innerHeight - h - 8)) });
  }, [hover, lines]);
  void rows;
  const kinds = cur ? data.facts.get(cur.treeVersion) : undefined;
  const cost = cur && !r.active && kinds && r.classId === cur.classId ? respecCost(cur.nodes, r.nodes, level, kinds) : null;
  const gold = cost && (cost.passive > 0 || cost.ascendancy > 0) ? cost : null;
  return createPortal(
    <div ref={ref} className="ts-tip" role="tooltip" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }} data-lg="pop" data-solid="">
      <div className="a">
        <span>{tr('TreeSetSelect.class')} <b style={{ color: classColour(r.className) }}>{r.className || tr('TreeSetSelect.none')}</b>{r.ascName ? <> {tr('TreeSetSelect.ascendancy')} <b>{r.ascName}</b></> : null}</span>
        <span>{tr('TreeSetSelect.points_used')} <b>{r.counts ? r.counts.used : '…'}</b>{r.counts && r.counts.sockets > 0 ? <> {tr('TreeSetSelect.jewel_sockets')} <b>{r.counts.sockets}</b></> : null}</span>
      </div>
      {!r.active && (
        <div className="cmp">
          <span className="cap">{tr('TreeSetSelect.switching_to_this_tree_will')}</span>
          {lines === null ? <span className="cap">{tr('TreeSetSelect.calculating')}</span> : lines.length === 0 ? <span className="cap">{tr('TreeSetSelect.no_change_to_your_stats')}</span> : lines.slice(0, MAX_LINES).map((l) => <span key={l.key} className={l.good ? 'up' : 'down'}>{l.value} {l.label}{l.percent}</span>)}
          {lines !== null && lines.length > MAX_LINES && <span className="cap">{tr('TreeSetSelect.and_max_lines_more_changes', { MAX_LINES: lines.length - MAX_LINES })}</span>}
        </div>
      )}
      <div className="z">
        {gold && <span className="gold">{tr('TreeSetSelect.tolocalestring_gold_required_to_swit', { gold: gold.gold.toLocaleString('en-US') })}</span>}
        {gold && gold.passive > 0 && <span className="sub">{tr('TreeSetSelect.count_passive_nodes', { count: gold.passive })} {tr('TreeSetSelect.to_be_refunded')}</span>}
        {gold && gold.ascendancy > 0 && <span className="sub">{tr('TreeSetSelect.count_ascendancy_nodes', { count: gold.ascendancy })} {tr('TreeSetSelect.to_be_refunded')}</span>}
        <span className="ver">{tr('TreeSetSelect.game_version_versiondisplay', { versionDisplay: r.versionDisplay })}</span>
      </div>
    </div>,
    document.body,
  );
}
