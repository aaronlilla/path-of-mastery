// The Tree tab's small confirmation dialogs, with upstream's wording.
import { Dialog } from '../ui';
import { convertedSentence, type ConvertDrop } from '../../shared/treeUi';
import { fromMain, tr } from '../i18n';

const P = { margin: 0, color: 'var(--text)', lineHeight: 1.5 } as const;

/** Reset Tree/Tattoos: one warning, three choices. */
export function ResetTreeDialog({ tattoos, onReset, onRemoveTattoos, onCancel }: { tattoos: number; onReset: () => void; onRemoveTattoos: () => void; onCancel: () => void }) {
  return (
    <Dialog icon="warning" title={tr('tree_TreeDialogs.reset_tree_tattoos')} confirmLabel={tr('tree_TreeDialogs.reset_tree')} confirmIcon="reset" altLabel={tr('tree_TreeDialogs.remove_all_tattoos')} altIcon="trash" altDisabled={tattoos === 0} onCancel={onCancel} onConfirm={onReset} onAlt={onRemoveTattoos}>
      <p style={P}>
        {tr('tree_TreeDialogs.warning_resetting_your_passive_tree')}
      </p>
      {tattoos === 0 && <p style={{ ...P, color: 'var(--text-muted)', marginTop: 8 }}>{tr('tree_TreeDialogs.this_tree_has_no_tattoos')}</p>}
    </Dialog>
  );
}

export type { ConvertDrop };

/** The message after Convert: which version, what the new tree dropped and why, and a way to take it back. */
export function TreeConvertedDialog({ display, dropped, onClose, onUndo }: { display: string; dropped: ConvertDrop | null; onClose: () => void; onUndo: () => void }) {
  const sentence = fromMain('ml_misc_converted', convertedSentence(display, dropped));
  const lost = !!dropped && (dropped.points > 0 || dropped.ascendancy > 0);
  return (
    <Dialog icon={lost ? 'warning' : 'info'} title={tr('tree_TreeDialogs.tree_converted')} confirmLabel={tr('tree_TreeDialogs.ok')} cancelLabel={null} altLabel={lost ? tr('tree_TreeDialogs.undo') : undefined} altIcon="undo" onAlt={onUndo} onCancel={onClose} onConfirm={onClose}>
      <p style={P}>
        {tr('tree_TreeDialogs.the_tree_has_been_converted', { display })}
        {sentence && <><br /><b>{sentence}</b></>}
        <br />
        <br />{tr('tree_TreeDialogs.you_can_switch_back_to')}{lost ? tr('tree_TreeDialogs.or_press_undo_ctrl_z') : ''}.
      </p>
    </Dialog>
  );
}

/** A build whose tree version this app does not have (upstream's "Unknown Passive Tree Version" message). */
export function UnknownVersionCard({ version }: { version: string }) {
  return (
    <div className="tt-card" role="alert" style={{ top: '50%' }}>
      <b>{tr('tree_TreeDialogs.unknown_passive_tree_version')}</b>
      <span>{tr('tree_TreeDialogs.the_build_you_are_trying', { version: version.replace(/_/g, '.') })}</span>
      <span>{tr('tree_TreeDialogs.you_may_need_to_update')}</span>
    </div>
  );
}
