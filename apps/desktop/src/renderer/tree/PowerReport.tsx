// The Node Power report: the nodes that would help most, with the chosen stat's real change, the points the path costs and
// the change per point (upstream's PowerReportListControl). Click a row to bring the node into view.
import { useMemo, useState } from 'react';
import { POWER_STATS, type NodePower } from '@pom/protocol';
import { displayStats, formatNumSep, sFormat, type NumberFormat } from '../displayStats';
import { Icon, Select } from '../ui';
import type { PassiveTree } from './PassiveTree';
import { pointsLabel, reportRows, type ReportRow } from './powerRows';
import { label, tr } from '../i18n';

const TYPE_NAME = [tr('tree_PowerReport_2.normal'), tr('tree_PowerReport_2.notable'), tr('tree_PowerReport_2.keystone'), tr('tree_NodeTooltip.mastery'), tr('tree_PowerReport_2.jewel'), tr('tree_PowerReport_2.class_start'), tr('h_c_Tree.ascendancy')];

type SortKey = 'type' | 'power' | 'points' | 'per';

export const statLabel = (stat: string) => POWER_STATS.find((s) => s.stat === stat)?.label ?? stat;

/** A power value the way upstream formats it for its stat (percent stats times 100), always with its sign. */
export function formatPower(stat: string, v: number, nf: NumberFormat): string {
  const sd = displayStats.find((d) => d.stat === stat);
  const val = v * (sd?.pc || sd?.mod ? 100 : 1);
  let text = sFormat(sd?.fmt ?? '.1f', val);
  if (/^[+-]?\d+\.\d+/.test(text)) text = text.replace(/(\.\d*?)0+(\D*)$/, '$1$2').replace(/\.(\D*)$/, '$1');
  text = formatNumSep(text, nf);
  return val > 0 && !text.startsWith('+') ? '+' + text : text;
}

export function sortRows(rows: ReportRow[], key: SortKey, desc: boolean): ReportRow[] {
  const dir = desc ? -1 : 1;
  const by: Record<SortKey, (a: ReportRow, b: ReportRow) => number> = {
    type: (a, b) => (a.type === b.type ? b.power - a.power : a.type - b.type),
    power: (a, b) => a.power - b.power,
    points: (a, b) => (a.points === b.points ? b.power - a.power : a.points - b.points),
    per: (a, b) => a.perPoint - b.perPoint,
  };
  return [...rows].sort((a, b) => dir * by[key](a, b));
}

export function PowerReport({ progress, nodes, tree, stat, depthLabel, fmt, onStat, onFocus, onHide }: { progress?: number | null; nodes: NodePower[] | null; tree: PassiveTree | null; stat: string; depthLabel: string; fmt: NumberFormat; onStat: (s: string) => void; onFocus: (id: number) => void; onHide: () => void }) {
  const [masteries, setMasteries] = useState(true);
  // "Show Unallocated" / "Show Allocated" (upstream's filter box; its "& Clusters" entry needs the cluster notable map, not in the engine).
  const [allocated, setAllocated] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'power', desc: true });
  const rows = useMemo(() => {
    if (!nodes || !tree) return [];
    // Allocated rows hold the removal change, so the best nodes are the most negative: the power sort runs the other way round.
    return sortRows(reportRows(nodes, tree, { masteries, allocated }), sort.key, allocated && sort.key !== 'type' && sort.key !== 'points' ? !sort.desc : sort.desc).slice(0, 200);
  }, [nodes, tree, masteries, allocated, sort]);
  const head = (key: SortKey, label: string, cls?: string) => (
    <button type="button" className={'th ' + (cls ?? '') + (sort.key === key ? ' on' : '')} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'type' && key !== 'points' }))} aria-label={tr('tree_PowerReport.sort_by_label', { label })}>
      {label}
      {sort.key === key && <Icon name="chevron-down" size={11} style={{ transform: sort.desc ? undefined : 'rotate(180deg)' }} />}
    </button>
  );
  return (
    <div className="tt-report" data-lg="panel" role="region" aria-label={tr('tree_PowerReport.power_report')}>
      <div className="rh">
        <span className="ttl">{tr('tree_PowerReport.power_report')}</span>
        <span className="sub">{nodes ? (allocated ? tr('h_c_Tree.pr_alloc', { stat: label(statLabel(stat)), n: nodes.filter((n) => !!n.allocated === allocated).length.toLocaleString('en-US') }) : tr('h_c_Tree.pr_unalloc', { stat: label(statLabel(stat)), n: nodes.filter((n) => !!n.allocated === allocated).length.toLocaleString('en-US'), depth: depthLabel })) : tr('tree_PowerReport.calculating')}</span>
        <span className="cap">{tr('tree_PowerReport.stat')}</span>
        <Select ariaLabel={tr('tree_PowerReport.node_power_stat')} value={stat} options={POWER_STATS.map((s) => ({ value: s.stat, label: s.label }))} width={150} onChange={onStat} />
        <Select ariaLabel={tr('tree_PowerReport.node_power_filter')} value={allocated ? 'alloc' : 'unalloc'} options={[{ value: 'unalloc', label: tr('tree_PowerReport.show_unallocated') }, { value: 'alloc', label: tr('tree_PowerReport.show_allocated') }]} width={175} onChange={(v) => { setAllocated(v === 'alloc'); setSort({ key: 'power', desc: true }); }} />
        <label className="chk"><input type="checkbox" checked={masteries} onChange={(e) => setMasteries(e.target.checked)} />{tr('tree_PowerReport.show_masteries')}</label>
        <button type="button" className="btn sm" data-lg="control" onClick={onHide}><Icon name="eye-off" size={14} />{tr('tree_PowerReport.hide_power_report')}</button>
      </div>
      <div className="rt">
        <div className="r hd">
          {head('type', tr('tree_PowerReport_2.type'))}
          <span className="th">{tr('tree_PowerReport.node_name')}</span>
          {head('power', statLabel(stat).toUpperCase(), 'num')}
          {head('points', tr('tree_PowerReport_2.points'), 'num')}
          {head('per', tr('tree_PowerReport_2.per_point'), 'num')}
        </div>
        {rows.map((r) => (
          <button key={r.key} type="button" className="r" onClick={() => onFocus(r.id)} title={tr('tree_PowerReport.show_this_node_on_the')}>
            <span className={'t' + r.type}>{TYPE_NAME[r.type]}</span>
            <span className="ellipsis">{r.name}</span>
            <span className={(r.power < 0 ? 'dn' : 'up') + ' num'}>{formatPower(stat, r.power, fmt)}</span>
            <span className="pts num">{pointsLabel(r.points)}</span>
            <span className="num">{formatPower(stat, r.perPoint, fmt)}</span>
          </button>
        ))}
        {nodes && rows.length === 0 && <div className="menu-empty">{allocated ? tr('tree_PowerReport.pick_a_stat_to_see') : tr('tree_PowerReport.no_unallocated_node_adds_to')}</div>}
        {!nodes && (
          <div className="menu-empty" role="status">
            {tr('tree_PowerReport.working_through_the_nodes_progress', { progress: progress ?? 0 })}
            <div className="rbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? 0}><i style={{ width: `${progress ?? 0}%` }} /></div>
          </div>
        )}
      </div>
    </div>
  );
}
