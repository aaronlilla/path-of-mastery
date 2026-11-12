import { useEffect, useState } from 'react';
import type { SharedBuild } from '../../shared/accounts.js';
import { artFor } from '../gameArt.js';
import { classKey, classPortrait } from '../art';
import { Dialog, Icon } from '../ui';
import { formatWhen } from '../format';
import { useAcct } from './useAccount';
import { tr } from '../i18n';

/** Opens a build somebody shared by link: what it is, then a copy in the player's own library. */
export function SharedBuildDialog({ token, onClose, onOpen }: { token: string; onClose: () => void; onOpen: (b: SharedBuild) => void }) {
  const a = useAcct();
  const [state, setState] = useState<{ k: 'loading' } | { k: 'gone'; why: string } | { k: 'ok'; b: SharedBuild }>({ k: 'loading' });
  useEffect(() => {
    let alive = true;
    void a.api.sharedOpen(token).then((r) => {
      if (!alive) return;
      if (!r.ok) setState({ k: 'gone', why: r.error });
      else if (!r.value) setState({ k: 'gone', why: tr('accounts_SharedBuildDialog.this_link_does_not_open') });
      else setState({ k: 'ok', b: r.value });
    });
    return () => {
      alive = false;
    };
  }, [a.api, token]);

  const b = state.k === 'ok' ? state.b : null;
  const cls = b ? b.ascendClassName || b.className : '';
  const key = b ? classKey({ className: b.className, ascendClassName: b.ascendClassName }) : 'scion';
  const gem = b ? artFor(b.mainSkill, 'gems') : undefined;
  return (
    <Dialog
      size="small"
      icon="share"
      title={tr('accounts_SharedBuildDialog.shared_build')}
      subtitle={state.k === 'loading' ? tr('accounts_SharedBuildDialog.opening_the_link') : state.k === 'gone' ? undefined : tr('accounts_SharedBuildDialog.somebody_shared_this_build_with')}
      cancelLabel={b ? tr('accounts_SharedBuildDialog.cancel') : tr('accounts_SharedBuildDialog.close')}
      confirmLabel={b ? tr('accounts_SharedBuildDialog.open_as_a_new_build') : null}
      confirmIcon="external"
      onCancel={onClose}
      onConfirm={() => b && onOpen(b)}
    >
      {state.k === 'gone' && (
        <div className="acct-shared-gone">
          <Icon name="unlink" size={18} />
          <span>{state.why}</span>
        </div>
      )}
      {b && (
        <div className="acct-shared">
          <span className="portrait" style={{ backgroundImage: `url(${classPortrait(key)})`, ['--cls' as string]: `var(--class-${key})` }} />
          <span className="tx">
            <span className="nm">
              {gem && <img src={gem} alt="" />}
              {b.name}
            </span>
            <span className="sub">{tr('accounts_SharedBuildDialog.level_level_cls', { level: b.level, cls })}{b.mainSkill ? ` · ${b.mainSkill}` : ''}</span>
            <span className="sub">{tr('accounts_SharedBuildDialog.shared_updatedat', { updatedAt: formatWhen(b.updatedAt) })}</span>
          </span>
        </div>
      )}
      {b && (
        <div className="acct-shared-note">
          <Icon name="info" size={13} />
          {b.allowDuplicate ? tr('accounts_SharedBuildDialog.the_copy_goes_in_your') : tr('accounts_SharedBuildDialog.the_owner_turned_off_duplicating')}
        </div>
      )}
    </Dialog>
  );
}
