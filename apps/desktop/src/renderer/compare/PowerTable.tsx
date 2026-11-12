import type { ItemInfo } from '@pom/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DISPLAY_STATS, formatStat } from '../../shared/displayStats.js';
import type { PowerRow, PowerStat, PowerTask } from '../../shared/comparePower.js';
import { artUrl, gemArtUrl, gemColour, RARITY_COLOUR, useGameInfo } from '../gameData';
import { useHoverTip } from '../items/parts';
import type { SkillKind } from '../items/statCompare';
import { NodeIcon } from '../calcs/NodeIcon';
import { Art } from '../tabKit';
import { Icon } from '../ui';
import { loadTreeGraph, type TreeGraph } from './treeGraph';
import { fromMain, label as lbl, tr } from '../i18n';

export type PowerSort = 'val' | 'cat' | 'pts' | 'per';

function statFormat(stat: PowerStat): { fmt: string; scale: number; compact: boolean } {
  const d = DISPLAY_STATS.find((x) => x.stat === stat.stat);
  return { fmt: d?.fmt ?? '.1f', scale: d?.pc || d?.mod ? 100 : 1, compact: d?.compact ?? /DPS|Average/.test(stat.stat) };
}

interface Props {
  version: string;
  report: { metric: string; stat: PowerStat; rows: PowerRow[]; base: number };
  sort: PowerSort;
  onSort: (s: PowerSort) => void;
  onClose: () => void;
  /** The engine session of this build, to read an item the way it would show here. */
  engineId: string | null;
  kind: SkillKind;
  stats: Record<string, number | string | boolean | null>;
}

const per = (r: PowerRow): number | null => (r.task.points ? r.impact / r.task.points : null);
const CMP: Record<PowerSort, (a: PowerRow, b: PowerRow) => number> = {
  val: (a, b) => b.impact - a.impact,
  cat: (a, b) => a.task.category.localeCompare(b.task.category) || Math.abs(b.impact) - Math.abs(a.impact),
  pts: (a, b) => (a.task.points ?? Infinity) - (b.task.points ?? Infinity) || Math.abs(b.impact) - Math.abs(a.impact),
  per: (a, b) => (per(b) ?? -Infinity) - (per(a) ?? -Infinity),
};

/** The task's name with the slot, socket and jewel count words in the player's language (the item name stays as is). */
const note = (r: PowerRow): string => (r.note ? ' ' + fromMain('ml_misc_power', r.note.trim()) : '');
const taskName = (t: PowerTask): string => {
  if (t.kind === 'gem') return t.name === '(empty group)' ? fromMain('ml_misc_power', t.name) : t.name;
  if (t.kind !== 'item') return t.name;
  // "Item, Slot", "Item, Slot, 2 Jewels" (abyssal swap) or "Item, Socket #3" (tree jewel): the item name stays, the rest follows the language.
  return t.name.replace(/, (Socket)( #\d+)?$/, (_m, w: string, n?: string) => `, ${lbl(w)}${n ?? ''}`).replace(/, ([^,]+?)(, \d+ Jewels?)?$/, (m, slot: string, jewels?: string) => (t.slot && slot === t.slot ? `, ${lbl(slot)}${jewels ? ', ' + fromMain('ml_misc_power', jewels.slice(2)) : ''}` : m));
};

const catColour = (c: string): string => (c === 'Tree' ? 'var(--gold-text)' : c === 'Items' ? 'var(--rarity-unique)' : c === 'Skill gems' || c === 'Support gems' ? 'var(--rarity-gem-text)' : 'var(--text-3)');

/** The power report's table: Category, Name, the metric, Points and Per Point. Hovering a node or an item shows its tooltip. */
export function PowerTable({ version, report, sort, onSort, onClose, engineId, kind, stats }: Props) {
  const info = useGameInfo();
  const tip = useHoverTip(kind, stats);
  const [graph, setGraph] = useState<TreeGraph | null>(null);
  const items = useRef(new Map<string, Promise<ItemInfo | null>>());
  useEffect(() => {
    let live = true;
    void loadTreeGraph(version).then((g) => live && setGraph(g));
    return () => {
      live = false;
    };
  }, [version]);
  const rows = useMemo(() => [...report.rows].sort(CMP[sort]), [report.rows, sort]);
  const showTip = (el: Element, t: PowerTask) => {
    if (t.kind === 'tree' && t.nodeId !== undefined) {
      const n = graph?.nodes.get(t.nodeId);
      if (!n) return;
      tip.show(el, { lines: [{ text: n.n, colour: t.art === 'Keystone' ? 'var(--node-keystone)' : t.art === 'Notable' ? 'var(--gold-text)' : 'var(--text-strong)' }, { text: t.art ?? tr('compare_PowerTable.passive'), colour: 'var(--text-muted)' }, ...(n.s ?? []).map((text) => ({ text, colour: 'var(--mod-passive)' }))] });
    } else if (t.itemText) {
      const key = t.itemText;
      let p = items.current.get(key);
      if (!p) {
        p = window.pom.sendCommand('itemInfo', { buildId: engineId, itemText: key }).then((r) => (r.ok ? r.result.item : null));
        items.current.set(key, p);
      }
      const rect = el;
      void p.then((inf) => inf && rect.isConnected && tip.show(rect, { info: inf }));
    }
  };
  // A hover changes only the tooltip: the rows are built again only when the report, its order or the art changes.
  const showRef = useRef(showTip);
  showRef.current = showTip;
  const hide = tip.hide;
  const body = useMemo(() => {
    const f = statFormat(report.stat);
    const fmt = (v: number): string => `${v > 0 ? '+' : '−'}${formatStat(Math.abs(v), f.fmt, 1, 0, f.compact).replace(/^-/, '')}`;
    return rows.map((r, i) => {
      const t = r.task;
      const v = r.impact * f.scale;
      const pp = per(r);
      const colour = t.kind === 'item' ? (RARITY_COLOUR[t.rarity ?? ''] ?? 'var(--text)') : t.kind === 'gem' || t.kind === 'support' ? gemColour(info, t.art ?? t.name) : t.kind === 'tree' ? (t.art === 'Keystone' ? 'var(--node-keystone)' : t.art === 'Notable' ? 'var(--gold-text)' : 'var(--text)') : 'var(--text)';
      const img = t.kind === 'item' ? (artUrl(info, t.art) ?? undefined) : t.kind === 'gem' || t.kind === 'support' ? gemArtUrl(info, t.art ?? t.name) : undefined;
      return (
        <div className="tr" key={t.id} style={{ background: i % 2 ? 'rgba(var(--line-rgb),.015)' : 'transparent' }} onMouseEnter={(e) => showRef.current(e.currentTarget, t)} onMouseLeave={hide}>
          <span style={{ color: catColour(t.category), fontSize: 12.5 }}>{lbl(t.category)}</span>
          <span className="nm">
            {(t.kind === 'item' || t.kind === 'gem' || t.kind === 'support') && <Art src={img} size={20} />}
            {t.kind === 'tree' && t.sprite && <NodeIcon version={version} sprite={t.sprite} />}
            <span className="ellipsis" title={taskName(t) + note(r)} style={{ color: colour }}>{taskName(t)}{note(r)}</span>
          </span>
          <span style={{ textAlign: 'right', fontWeight: 500, color: v > 0 ? 'var(--positive-text)' : 'var(--negative-text)' }}>
            {fmt(v)}
            {r.percent !== null && ` (${r.percent > 0 ? '+' : '−'}${Math.abs(r.percent).toFixed(1)}%)`}
          </span>
          <span style={{ textAlign: 'right', color: 'var(--text-3)' }}>{t.points ?? ''}</span>
          <span style={{ textAlign: 'right', color: pp === null ? 'var(--text-faint)' : pp > 0 ? 'var(--positive-text)' : 'var(--negative-text)' }}>{pp === null ? '' : fmt(pp * f.scale)}</span>
        </div>
      );
    });
  }, [rows, report.stat, info, version, hide]);
  const th = (id: PowerSort, label: string, right?: boolean) => (
    <button type="button" aria-label={tr('compare_PowerTable.sort_by_label', { label })} style={right ? { justifyContent: 'flex-end' } : undefined} onClick={() => onSort(id)}>
      {label}
      {sort === id && <Icon name="caret-down" size={11} />}
    </button>
  );
  return (
    <div className="cmp-pt" data-lg="tile">
      <div className="hd" title={tr('compare_PowerTable.adding_each_element_of_b')}>
        <Icon name="chart-bar" size={15} style={{ color: 'var(--gold-label)' }} />
        <b>{tr('compare_PowerTable.power_report_label', { label: lbl(report.stat.label) })}</b>
        <span style={{ flex: 1 }} />
        <button type="button" className="icon-btn" aria-label={tr('compare_PowerTable.close_power_report')} onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="th">
        {th('cat', tr('compare_PowerTable_2.category'))}
        <span>{tr('compare_PowerTable.name')}</span>
        {th('val', lbl(report.stat.label).toUpperCase(), true)}
        {th('pts', tr('compare_PowerTable_2.points'), true)}
        {th('per', tr('compare_PowerTable_2.per_point'), true)}
      </div>
      <div className="rows scroll-thin">
        {body}
        {!rows.length && (
          <div style={{ padding: '18px 14px', color: 'var(--text-muted)', whiteSpace: 'normal', lineHeight: 1.5 }}>
            <b style={{ color: 'var(--text-2)' }}>{tr('compare_PowerTable.no_differences_found')}</b>{' '}
            {report.base === 0 ? tr('compare_PowerTable.this_build_has_no_label', { label: lbl(report.stat.label) }) : tr('compare_PowerTable.nothing_from_b_changes_label', { label: lbl(report.stat.label) })}
          </div>
        )}
      </div>
      {tip.node}
    </div>
  );
}
