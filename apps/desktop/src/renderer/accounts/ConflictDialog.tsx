import { useEffect, useState } from 'react';
import type { ConflictChoice, SyncConflict } from '../../shared/accounts.js';
import { artFor } from '../gameArt.js';
import { exactNumber } from '../format';
import { Dialog, Icon } from '../ui';
import { engineStats, itemInSlot, type CompareStats } from './xmlStats';
import { acctText, useAcct, useAcctCall } from './useAccount';
import { tr } from '../i18n';

interface Side {
  stats: CompareStats | null;
  gloves: string;
}

const ROWS: { label: string; get: (s: Side) => string }[] = [
  { label: tr('accounts_ConflictDialog.combined_dps'), get: (s) => (s.stats?.fullDps != null ? exactNumber(Math.round(s.stats.fullDps)) : '–') },
  { label: tr('accounts_ConflictDialog.life'), get: (s) => (s.stats?.life != null ? exactNumber(Math.round(s.stats.life)) : '–') },
  { label: tr('accounts_ConflictDialog.passives'), get: (s) => (s.stats ? String(s.stats.passives) : '–') },
  { label: tr('accounts_ConflictDialog.gloves'), get: (s) => s.gloves || tr('accounts_ConflictDialog_2.none') },
];

const MON = [tr('accounts_ConflictDialog_2.jan'), tr('accounts_ConflictDialog_2.feb'), tr('accounts_ConflictDialog_2.mar'), tr('accounts_ConflictDialog_2.apr'), tr('accounts_ConflictDialog_2.may'), tr('accounts_ConflictDialog_2.jun'), tr('accounts_ConflictDialog_2.jul'), tr('accounts_ConflictDialog_2.aug'), tr('accounts_ConflictDialog_2.sep'), tr('accounts_ConflictDialog_2.oct'), tr('accounts_ConflictDialog_2.nov'), tr('accounts_ConflictDialog_2.dec')];
/** "today 15:21", "yesterday 15:21" or "Sep 12 21:40": the day and time a copy was last edited. */
function editedAt(ms: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const gap = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (gap === 0) return tr('accounts_ConflictDialog_2.today', { hm: hm });
  if (gap === 1) return tr('accounts_ConflictDialog_2.yesterday', { hm: hm });
  return `${MON[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "<Build> changed on two devices": both copies side by side, differences in bold. */
export function ConflictDialog({ conflict, onClose }: { conflict: SyncConflict; onClose: () => void }) {
  const a = useAcct();
  const call = useAcctCall();
  const [pick, setPick] = useState<'pc' | 'cloud'>('pc');
  const [sides, setSides] = useState<{ mine: Side; theirs: Side } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const t = await a.api.conflictTexts(conflict.localId);
      if (!alive) return;
      if (!t.ok || !t.value) {
        setSides({ mine: { stats: null, gloves: '' }, theirs: { stats: null, gloves: '' } });
        return;
      }
      const mine = await engineStats(t.value.mine);
      const theirs = await engineStats(t.value.theirs);
      if (alive) setSides({ mine: { stats: mine, gloves: itemInSlot(t.value.mine, 'Gloves') }, theirs: { stats: theirs, gloves: itemInSlot(t.value.theirs, 'Gloves') } });
    })();
    return () => {
      alive = false;
    };
  }, [a.api, conflict.localId]);

  const resolve = async (choice: ConflictChoice) => {
    setBusy(true);
    await call(a.api.resolve(conflict.localId, choice));
    setBusy(false);
    onClose();
  };

  const cards: { id: 'pc' | 'cloud'; name: string; icon: string; when: string; side: Side | null; other: Side | null }[] = [
    { id: 'pc', name: tr('accounts_ConflictDialog_2.this_pc'), icon: 'monitor', when: tr('accounts_ConflictDialog.edited_editedat', { editedAt: editedAt(conflict.mine.editedAt) }) + (a.sync?.state === 'offline' ? ' · ' + tr('h_rA_acct.offline_suffix') : ''), side: sides?.mine ?? null, other: sides?.theirs ?? null },
    { id: 'cloud', name: tr('accounts_ConflictDialog_2.cloud', { deviceName: acctText(conflict.theirs.deviceName) }), icon: 'cloud', when: tr('accounts_ConflictDialog.edited_editedat', { editedAt: editedAt(conflict.theirs.editedAt) }), side: sides?.theirs ?? null, other: sides?.mine ?? null },
  ];

  return (
    <Dialog
      size="medium"
      icon="sync"
      title={tr('accounts_ConflictDialog.this_build_changed_on_two')}
      subtitle={tr('accounts_ConflictDialog.both_copies_were_edited_while')}
      cancelLabel={tr('accounts_ConflictDialog.decide_later')}
      altLabel={tr('accounts_ConflictDialog.keep_both')}
      altIcon="files"
      confirmLabel={pick === 'pc' ? tr('accounts_ConflictDialog.keep_this_pc') : tr('accounts_ConflictDialog.keep_cloud')}
      confirmIcon={pick === 'pc' ? 'monitor' : 'cloud'}
      confirmBusy={busy}
      onCancel={onClose}
      onAlt={() => void resolve('both')}
      onConfirm={() => void resolve(pick === 'pc' ? 'mine' : 'theirs')}
    >
      <div className="acct-cf" role="radiogroup" aria-label={tr('accounts_ConflictDialog.copy_to_keep')}>
        {cards.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={pick === c.id} className="ac-side" data-lg="tile" data-on={pick === c.id} onClick={() => setPick(c.id)}>
            <span className="ac-top">
              <Icon name={c.icon} size={16} style={{ color: 'var(--text-3)' }} />
              <span className="ac-nm">{c.name}</span>
              <span className="ac-ring"><i /></span>
            </span>
            <span className="ac-when">{c.when}</span>
            <span className="ac-rule" />
            {ROWS.map((r) => {
              const v = c.side ? r.get(c.side) : '…';
              const diff = !!c.side && !!c.other && v !== r.get(c.other);
              const art = r.label === 'Gloves' && c.side?.gloves ? artFor(c.side.gloves) : undefined;
              return (
                <span key={r.label} className="ac-r">
                  <span className="ac-l">{r.label}</span>
                  <span className="ac-v" style={{ color: diff ? 'var(--text-strong)' : 'var(--text-muted)', fontWeight: diff ? 600 : 400 }}>
                    {art && <img src={art} alt="" />}
                    {v}
                  </span>
                </span>
              );
            })}
          </button>
        ))}
      </div>
      <div className="acct-cf-note">
        <Icon name="info" size={13} />
        {tr('accounts_ConflictDialog.differences_are_highlighted_the_copy')}
      </div>
    </Dialog>
  );
}
