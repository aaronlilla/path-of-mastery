import type { Stage } from '../../../shared/lootfilter/stages.js';
import { bandText } from './model';
import { tr } from '../../i18n';
import { lfBuild } from '../mainText';

/** S0 to S4 as a strip of AreaLevel bands. The selected stage is the one the preview shows. */
export function StageStrip({ stages, selected, onSelect }: { stages: Stage[]; selected: string; onSelect: (id: string) => void }) {
  return (
    <div className="bf-strip" role="tablist" aria-label={tr('lootfilter_buildfilter_StageStrip.stages_by_area_level')} data-screen-label="Loot Filter / Build / Stages">
      {stages.map((s) => (
        <button key={s.id} type="button" role="tab" aria-selected={s.id === selected} className="bf-stage" data-stage={s.id} onClick={() => onSelect(s.id)}>
          <span className="bf-stage-id">{s.id}</span>
          <span className="bf-stage-name">{lfBuild(s.name)}</span>
          <span className="bf-stage-band">{tr('lootfilter_buildfilter_StageStrip.area_v2', { value: bandText(s) })}</span>
          <span className="bf-stage-mean">{lfBuild(s.meaning)}</span>
        </button>
      ))}
    </div>
  );
}
