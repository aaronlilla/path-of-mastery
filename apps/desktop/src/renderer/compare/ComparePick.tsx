import { useState, type ReactNode } from 'react';
import { Dialog, Icon } from '../ui';
import { tr } from '../i18n';

export interface PickRow {
  value: string;
  label: string;
  sub: string;
  icon: string;
}

export interface PickSection {
  title: string;
  rows: PickRow[];
}

/**
 * "Compare with…": the builds this one can be compared with, in the order of the design (loadouts of this build, saved
 * versions, other builds, import). The setup of the compared build and the re-import of the current character, which
 * the design has no place for, sit under the lists.
 */
export function ComparePick({ sections, initial, onCompare, onImport, onClose, setup, extra }: { sections: PickSection[]; initial: string; onCompare: (value: string) => void; onImport: () => void; onClose: () => void; setup?: ReactNode; extra?: ReactNode }) {
  const [sel, setSel] = useState(initial);
  return (
    <Dialog size="medium" icon="compare" tone="primary" title={tr('compare_ComparePick.compare_with')} subtitle={tr('compare_ComparePick.the_compare_tab_shows_the')} cancelLabel={tr('compare_ComparePick.cancel')} confirmLabel={tr('compare_ComparePick.compare')} confirmIcon="compare" confirmDisabled={!sel} onCancel={onClose} onConfirm={() => sel && onCompare(sel)}>
      <div className="cmp-pick">
      <div className="cmp-pick-list" role="listbox" aria-label={tr('compare_ComparePick.compare_with_2')}>
        {sections.map((s) => (
          <div key={s.title} className="cmp-pick-sec">
            <div className="cmp-pick-h">{s.title}</div>
            {s.rows.map((r) => (
              <button key={r.value} type="button" role="option" aria-selected={sel === r.value} className={'cmp-pick-row' + (sel === r.value ? ' on' : '')} onClick={() => setSel(r.value)} onDoubleClick={() => onCompare(r.value)}>
                <Icon name={r.icon} size={16} />
                <span className="n ellipsis">{r.label}</span>
                <span className="s ellipsis">{r.sub}</span>
                {sel === r.value && <span className="ck"><Icon name="check" size={15} /></span>}
              </button>
            ))}
            {s.title === 'OTHER BUILDS' && (
              <button type="button" className="cmp-pick-row" onClick={onImport}>
                <Icon name="import" size={16} />
                <span className="n ellipsis">{tr('compare_ComparePick.import_a_build')}</span>
                <span className="s ellipsis">{tr('compare_ComparePick.paste_a_code_or_a')}</span>
              </button>
            )}
          </div>
        ))}
      </div>
        {setup && (
          <div className="cmp-pick-sec">
            <div className="cmp-pick-h">{tr('compare_ComparePick.setup_of_the_compared_build')}</div>
            {setup}
          </div>
        )}
        {extra && (
          <div className="cmp-pick-sec">
            <div className="cmp-pick-h">{tr('compare_ComparePick.this_build')}</div>
            {extra}
          </div>
        )}
      </div>
    </Dialog>
  );
}
