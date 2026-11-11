import { useState } from 'react';
import { Dialog } from '../../ui';
import { Over } from '../dialogs';
import type { PowerStat } from '../rank';
import { DEFAULT_WEIGHTS, sliderOfWeight, weightOfSlider, type StatWeight } from './model';
import { label, tr } from '../../i18n';

export function weightLabel(w: number): string {
  return w > 0 ? w.toFixed(2) : '0';
}

/** The stats the sort can weigh: every one of upstream's stat list that items can change. */
export function weightableStats(stats: PowerStat[] | null): PowerStat[] {
  return (stats ?? []).filter((s) => s.items && s.stat);
}

export function toMultipliers(list: StatWeight[]): Record<string, number> {
  return Object.fromEntries(list.map((w) => [w.stat, w.weightMult]));
}

/** The "Stat Weight Multipliers" popup (`TradeQueryClass:SetStatWeights`). */
export function StatWeightsDialog({ stats, current, onSave, onCancel }: { stats: PowerStat[] | null; current: StatWeight[]; onSave: (list: StatWeight[]) => void; onCancel: () => void }) {
  const list = weightableStats(stats);
  const [mult, setMult] = useState<Record<string, number>>(() => toMultipliers(current));
  const [sel, setSel] = useState<string>(() => current[0]?.stat ?? list[0]?.stat ?? '');
  const cur = list.find((s) => s.stat === sel);
  const value = mult[sel] ?? 0;
  const save = () => {
    const out: StatWeight[] = list.filter((s) => (mult[s.stat] ?? 0) > 0).map((s) => ({ stat: s.stat, label: s.label, weightMult: mult[s.stat]!, negate: s.negate }));
    // An empty list keeps the one before (upstream does not warn).
    onSave(out.length ? out : current);
  };
  return (
    <Over>
      <Dialog size="small" title={tr('items_trader_StatWeights.stat_weight_multipliers')} subtitle={tr('items_trader_StatWeights.results_are_sorted_by_these')} confirmLabel={tr('items_trader_StatWeights.save')} confirmIcon="check" altLabel={tr('items_trader_StatWeights.reset')} altIcon="undo" onAlt={() => setMult(toMultipliers(DEFAULT_WEIGHTS))} onCancel={onCancel} onConfirm={save}>
        <div className="tr-sw">
          <div className="tr-sw-slide">
            <span className="tr-sw-name">{label(cur?.label ?? '')}:</span>
            <input type="range" min={0} max={100} step={1} value={sliderOfWeight(value)} aria-label={tr('items_trader_StatWeights.weight_of_label', { label: cur?.label ?? tr('items_trader_StatWeights.the_stat') })} onChange={(e) => setMult((m) => ({ ...m, [sel]: weightOfSlider(Number(e.target.value)) }))} />
            <span className="tr-sw-val">{value > 0 ? value.toFixed(2) : tr('items_trader_StatWeights.disabled')}</span>
          </div>
          <div className="tr-sw-list" role="listbox" aria-label={tr('items_trader_StatWeights.stats')}>
            {list.map((s) => (
              <button key={s.stat} type="button" role="option" aria-selected={s.stat === sel} className="tr-sw-row" title={tr('items_trader_StatWeights.click_to_modify_this_stats')} onClick={() => setSel(s.stat)}>
                <span className="w">{weightLabel(mult[s.stat] ?? 0)}</span>
                <span className="n">{label(s.label)}</span>
              </button>
            ))}
          </div>
        </div>
      </Dialog>
    </Over>
  );
}
