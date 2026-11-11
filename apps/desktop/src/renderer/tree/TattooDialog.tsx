// "Replace Modifier of Node": right-click a tattoo-eligible node, pick a tattoo, Add it; Reset Node puts the original back.
import { useMemo, useState } from 'react';
import { Dialog, Select } from '../ui';
import { descriptionOf, label, tattoosFor, type Tattoo, type TattooTarget } from './tattoos';
import { tr } from '../i18n';

/** The tattoo last picked for a node name, like upstream's `defaultTattoo`. */
const lastPick = new Map<string, string>();

export function TattooDialog({ all, node, tattooed, count, countTip, onAdd, onReset, onCancel }: { all: Tattoo[]; node: TattooTarget; tattooed: boolean; count: number; countTip: string; onAdd: (t: Tattoo) => void; onReset: () => void; onCancel: () => void }) {
  const [legacy, setLegacy] = useState(false);
  const list = useMemo(() => tattoosFor(all, node, legacy), [all, node, legacy]);
  const [key, setKey] = useState(() => lastPick.get(node.name) ?? '');
  const cur = list.find((t) => t.key === key) ?? list[0];
  return (
    <Dialog
      size="medium"
      icon="info"
      title={tr('tree_TattooDialog.replace_modifier_of_node')}
      subtitle={node.name}
      confirmLabel={tr('tree_TattooDialog.add')}
      confirmDisabled={!cur}
      altLabel={tattooed ? tr('tree_TattooDialog.reset_node') : undefined}
      altIcon="reset"
      onCancel={onCancel}
      onConfirm={() => {
        if (!cur) return;
        lastPick.set(node.name, cur.key);
        onAdd(cur);
      }}
      onAlt={() => {
        lastPick.delete(node.name);
        onReset();
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--text-2)' }}>{tr('tree_TattooDialog.modifier')}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Select ariaLabel={tr('tree_TattooDialog.tattoo_modifier')} value={cur?.key ?? ''} options={list.length ? list.map((t) => ({ value: t.key, label: label(t) })) : [{ value: '', label: tr('tree_TattooDialog.no_tattoo_fits_this_node') }]} width="100%" onChange={setKey} />
          </div>
        </div>
        {cur && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, color: 'var(--mod-passive, var(--text))', lineHeight: 1.4 }}>
            {descriptionOf(cur).map((l, i) => <span key={i}>{l}</span>)}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, color: 'var(--text-2)', fontSize: 13 }}>
          <span title={countTip || tr('tree_TattooDialog.no_tattoos_on_this_tree')} aria-label={tr('tree_TattooDialog.tattoo_count')} style={{ color: count > 50 ? 'var(--negative-text)' : undefined }}>{tr('tree_TattooDialog.tattoo_count_count_50', { count })}</span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={legacy} onChange={(e) => setLegacy(e.target.checked)} />
            {tr('tree_TattooDialog.show_legacy_tattoos')}
          </label>
        </div>
      </div>
    </Dialog>
  );
}
