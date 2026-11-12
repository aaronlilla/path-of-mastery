import { useState } from 'react';
import { Dialog } from '../ui';
import { tr } from '../i18n';

/** The Set Name dialog: "Enter name for this skill set:", Save once the name has a letter in it. */
export function NameDialog({ mode, title, onSave, onCancel }: { mode: 'new' | 'copy' | 'rename'; title: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(title);
  const ok = /\S/.test(v);
  return (
    <Dialog size="small" title={mode === 'rename' ? tr('skills_SetsDialog.rename') : tr('skills_SetsDialog.set_name')} confirmLabel={tr('skills_SetsDialog.save')} confirmIcon="check" confirmDisabled={!ok} onCancel={onCancel} onConfirm={() => ok && onSave(v)}>
      <div className="sk-dlg">
        <label className="sk-dlg-lbl" htmlFor="sk-set-name">
          {tr('skills_SetsDialog.enter_name_for_this_skill')}
        </label>
        <input id="sk-set-name" className="sk-dlg-in" value={v} maxLength={100} autoFocus spellCheck={false} aria-label={tr('skills_SetsDialog.skill_set_name')} onChange={(e) => setV(e.target.value)} />
      </div>
    </Dialog>
  );
}
