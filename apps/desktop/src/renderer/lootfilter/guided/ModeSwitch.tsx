import { Icon } from '../../ui';
import type { LfMode } from '../LootFilterArea';
import './guided.css';
import { tr } from '../../i18n';

/** Simple | Full, the same control in both headers: Full is a place you can leave. */
export function ModeSwitch({ mode, setMode }: { mode: LfMode; setMode: (m: LfMode) => void }) {
  return (
    <div className="gd-modes" role="tablist" aria-label={tr('lootfilter_guided_ModeSwitch.mode')}>
      <button type="button" role="tab" aria-selected={mode === 'guided'} title={tr('lootfilter_guided_ModeSwitch.your_changes_in_plain_words')} onClick={() => mode !== 'guided' && setMode('guided')}>
        <Icon name="sparkle" size={14} />
        {tr('lootfilter_guided_ModeSwitch.simple')}
      </button>
      <button type="button" role="tab" aria-selected={mode === 'advanced'} title={tr('lootfilter_guided_ModeSwitch.every_tier_and_rule')} onClick={() => mode !== 'advanced' && setMode('advanced')}>
        <Icon name="layout" size={14} />
        {tr('lootfilter_guided_ModeSwitch.full')}
      </button>
    </div>
  );
}
