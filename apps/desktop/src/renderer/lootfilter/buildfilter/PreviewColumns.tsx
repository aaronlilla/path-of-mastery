import type { BuiltFilter } from '../../../shared/lootfilter/buildFilter.js';
import type { Stage } from '../../../shared/lootfilter/stages.js';
import type { LabelStyle, Rule } from '../../../shared/lootfilter/types.js';
import { LabelChip } from '../LabelChip';
import { GROUP_LABEL, countOf, coversStage } from './model';
import { tr } from '../../i18n';
import { lfBuild } from '../mainText';

interface Row {
  key: string;
  label: string;
  style: LabelStyle;
  count: number;
  reason: string;
  ruleId: string;
}

const rowOf = (r: Rule): Row => ({ key: r.id, label: lfBuild(r.name ?? GROUP_LABEL[r.build?.group ?? ''] ?? r.id), style: r.style ?? {}, count: countOf(r), reason: lfBuild(r.build?.reason ?? r.why ?? ''), ruleId: r.id });

/** What one stage shows and what it hides, as labels with the reason each rule exists. */
export function PreviewColumns({ built, stage, off }: { built: BuiltFilter; stage: Stage; off: string[] }) {
  const live = built.rules.filter((r) => r.enabled && !off.includes(r.build?.group ?? '') && coversStage(r, stage));
  const hidden = live.filter((r) => r.visibility === 'hide').map(rowOf);
  const shown = live.filter((r) => r.visibility !== 'hide' && r.build?.kind !== 'safety').map(rowOf);
  const col = (title: string, rows: Row[], hide: boolean) => (
    <div className="bf-col" data-col={hide ? 'hidden' : 'shown'}>
      <div className="bf-col-head">
        <span className="lf-eyebrow">{title}</span>
        <span className="bf-count">{rows.length}</span>
      </div>
      {rows.length === 0 && <span className="adv-v-muted">{tr('lootfilter_buildfilter_PreviewColumns.nothing_here_for_this_stage')}</span>}
      {rows.map((r) => (
        <div key={r.key} className="bf-item" data-rule={r.ruleId}>
          <div className="bf-item-chip">
            <LabelChip name={r.label} style={hide ? { fg: [200, 200, 200], bd: [120, 120, 120], bg: [30, 30, 30, 200], fs: 30 } : r.style} fontPx={13} hidden={hide} hiddenLook="fade" />
            <span className="bf-n">{r.count}</span>
          </div>
          <span className="bf-why">{r.reason}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div className="bf-cols">
      {col(tr('lootfilter_buildfilter_PreviewColumns_2.shown'), shown, false)}
      {col(tr('lootfilter_buildfilter_PreviewColumns_2.hidden'), hidden, true)}
    </div>
  );
}
