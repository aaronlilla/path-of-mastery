import { Icon } from '../../../ui';
import { useLf } from '../../lfStore';
import type { LfNav } from '../../LootFilterArea';
import { FloatMenu } from './FloatMenu';
import { useInboxCount } from './useInbox';
import { tr } from '../../../i18n';

export { AskPanel } from './AskChat';

/** The bell: real notices only (a newer NeverSink release). Suggestions from play need the game log, which is not connected. */
export function InboxMenu({ at, nav, onClose }: { at: { x: number; y: number }; nav: LfNav; onClose: () => void }) {
  const lf = useLf();
  const newer = lf.update?.newer ? lf.update.latest : null;
  const count = useInboxCount();
  const go = (v: string): void => {
    onClose();
    nav.setAdvancedView(v);
  };
  return (
    <FloatMenu at={at} onClose={onClose} width={400} label={tr('lootfilter_advanced_shell_Ask.adapt_inbox')}>
      <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ color: 'var(--text-strong)', font: '600 14px Geist' }}>{tr('lootfilter_advanced_shell_Ask.notices')}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{count ? tr('lootfilter_advanced_shell_Ask.count_suggestions', { count: count }) : tr('lootfilter_advanced_shell_Ask.nothing_new')}</span>
      </div>
      {newer && (
        <div style={{ padding: 10, borderRadius: 10, background: 'rgba(var(--shadow-rgb),calc(.25*var(--shadow-k)))', display: 'flex', flexDirection: 'column', gap: 6, margin: '0 2px 4px' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{tr('lootfilter_advanced_shell_Ask.neversink')}</span>
          <span style={{ color: 'var(--text-strong)', lineHeight: 1.4 }}>{tr('lootfilter_advanced_shell_Ask.neversink_tag_is_out_you', { tag: newer.tag, baseVersion: lf.baseVersion })}</span>
          <div style={{ display: 'flex' }}>
            <button type="button" className="adv-sh-btn sm gold" onClick={() => go('update')}>
              <Icon name="eye" size={14} />
              {tr('lootfilter_advanced_shell_Ask.review')}
            </button>
          </div>
        </div>
      )}
      <div style={{ padding: '4px 10px 8px', color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.5 }}>{tr('lootfilter_advanced_shell_Ask.suggestions_come_from_neversink_rele')}</div>
      <button type="button" className="adv-sh-btn sm" style={{ margin: '0 2px 2px' }} onClick={() => go('adapt')}>
        <Icon name="inbox" size={14} />
        {tr('lootfilter_advanced_shell_Ask.open_full_inbox')}
      </button>
    </FloatMenu>
  );
}
