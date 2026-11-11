import type { Clause, GuidedAction, LabelStyle } from '../../../shared/lootfilter/types.js';
import { VERB, newGuidedRule } from '../../../shared/lootfilter/guided.js';
import { Icon } from '../../ui';
import { useSay } from './say';
import { useLf } from '../lfStore';
import { LabelChip, GROUND_DESERT } from '../LabelChip';
import { AnchorPop } from './AnchorPop';
import { tr } from '../../i18n';

/** The four verbs the wizard offers, in the popover's words. */
const ROWS: { act: GuidedAction; label: string; icon: string }[] = [
  { act: 'hide', label: tr('lootfilter_guided_ChipPop.hide'), icon: 'eye-off' },
  { act: 'quiet', label: tr('lootfilter_guided_ChipPop.quiet'), icon: 'volume-off' },
  { act: 'standout', label: tr('lootfilter_guided_ChipPop.standout'), icon: 'sparkle-fill' },
  { act: 'loud', label: tr('lootfilter_guided_ChipPop.loud'), icon: 'volume' },
];

/**
 * An item chip's popover: picking a verb makes the same guided rule the wizard's "Apply this change" makes
 * (same `newGuidedRule`, same priority, same undo step), in two clicks. "More options…" opens the wizard at step 2.
 */
export function ChipPop({ name, sel, look, hidden, onMore, onClose }: { name: string; sel: Clause[]; look: LabelStyle; hidden: boolean; onMore: () => void; onClose: () => void }) {
  const lf = useLf();
  const toast = useSay();
  const pick = (act: GuidedAction): void => {
    const cat = lf.catalog;
    if (!cat) return;
    const meta = { sel, exc: [] as Clause[], act };
    lf.addRule(newGuidedRule(lf.newId('g'), meta, cat, lf.nextPriority(), Date.now()), tr('lootfilter_guided_ChipPop.act_1_pick', { act: VERB[act] }));
    onClose();
    toast({ text: tr('lootfilter_guided_ChipPop.act_name_write_it_when', { act: VERB[act], name }), kind: 'ok', ttl: 8000, action: { label: tr('lootfilter_guided_ChipPop.undo'), run: () => lf.undo() } });
  };
  return (
    <AnchorPop width={260} className="gd-pop gd-chippop" role="menu" aria-label={tr('lootfilter_guided_ChipPop.change_name', { name })}>
      <div className="gd-chippop-hd">
        <span className="gd-chippop-look" style={{ background: GROUND_DESERT }}>
          <LabelChip name={name} style={look} hidden={hidden} hiddenLook="dashed" scale={0.42} fxInside title={name} />
        </span>
        <span className="gd-chippop-name">{hidden ? tr('lootfilter_guided_ChipPop.hidden_now') : tr('lootfilter_guided_ChipPop.shown_now')}</span>
      </div>
      {ROWS.map((r) => (
        <button key={r.act} type="button" className="gd-radio gd-chippop-row" role="menuitem" onClick={() => pick(r.act)}>
          <Icon name={r.icon} size={15} style={{ color: 'var(--text-muted)' }} />
          <span style={{ flex: 1 }}>{r.label}</span>
        </button>
      ))}
      <div className="gd-chippop-sep" />
      <button type="button" className="gd-radio gd-chippop-row" role="menuitem" onClick={onMore}>
        <Icon name="wand" size={15} style={{ color: 'var(--text-muted)' }} />
        <span style={{ flex: 1 }}>{tr('lootfilter_guided_ChipPop.more_options')}</span>
      </button>
    </AnchorPop>
  );
}
