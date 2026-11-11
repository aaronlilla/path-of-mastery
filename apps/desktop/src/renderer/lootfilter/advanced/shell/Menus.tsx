import { useCallback } from 'react';
import type { TierInfo } from '../../../../shared/lootfilter/catalog.js';
import { rgba } from '../../../../shared/lootfilter/styles.js';
import { Icon } from '../../../ui';
import { useLf } from '../../lfStore';
import { FloatMenu } from './FloatMenu';
import { itemRule, resetTarget, setTierHidden, tierHidden, tierKeyOfItem, tierRule, tagOf } from './edits';
import type { PickerKind } from './Pickers';
import { useAdvShell } from './selection';
import { tr } from '../../../i18n';

export function ItemMenu({ at, name, onClose, openPicker }: { at: { x: number; y: number }; name: string; onClose: () => void; openPicker: (k: PickerKind) => void }) {
  const lf = useLf();
  const sh = useAdvShell();
  const item = lf.catalog?.byName.get(name);
  if (!item) return null;
  const r = lf.evaluateCatalogItem(item);
  const hidden = r ? !r.visible : item.hidden;
  const locked = sh.isLocked(name);
  const own = itemRule(lf.doc.rules, name);
  const run = (f: () => void) => () => {
    onClose();
    f();
  };
  const row = (label: string, key: string, go: () => void, o: { sub?: boolean; danger?: boolean; icon?: string } = {}) => (
    <button key={label} type="button" role="menuitem" className={'menu-item' + (o.danger ? ' danger' : '')} onClick={run(go)}>
      {o.icon && <Icon name={o.icon} size={14} />}
      <span className="grow">{label}</span>
      {o.sub && <Icon name="chevron-right" size={9} />}
      <span className="meta">{key}</span>
    </button>
  );
  return (
    <FloatMenu at={at} onClose={onClose} width={250} label={tr('lootfilter_advanced_shell_Menus.actions_for_name', { name })}>
      <div className="menu-head" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: 11.5, color: 'var(--text-muted)' }}>
        <span className="ellipsis" style={{ display: 'block' }}>{name}</span>
      </div>
      {row(tr('lootfilter_advanced_shell_Menus.move_to_tier'), 'M', () => sh.openMove(at, name), { sub: true })}
      {row(tr('lootfilter_advanced_shell_Menus.change_look'), 'L', () => sh.openInspector('style'))}
      {row(tr('lootfilter_advanced_shell_Menus_2.sound'), 'S', () => openPicker('snd'), { sub: true })}
      {row(hidden ? tr('lootfilter_advanced_shell_Menus.show_normally') : tr('lootfilter_advanced_shell_Menus_2.hide'), 'H', () => sh.setItemHidden(item, !hidden))}
      {row(locked ? tr('lootfilter_advanced_shell_Menus_2.unlock') : tr('lootfilter_advanced_shell_Menus_2.lock'), 'K', () => sh.toggleLock(name))}
      <div className="menu-sep" />
      {own && row(tr('lootfilter_advanced_shell_Menus_2.reset_to_neversink'), '', () => {
        resetTarget(lf, { kind: 'item', item }, tr('lootfilter_advanced_shell_Menus.reset_name', { name }));
        sh.toastUndo(tr('lootfilter_advanced_shell_Menus.reset_name_to_neversink', { name }));
      })}
      {row(tr('lootfilter_advanced_shell_Menus.jump_to_rule'), 'J', () => sh.goSection(item.type, tierKeyOfItem(lf.doc.rules, item)))}
      {row(tr('lootfilter_advanced_shell_Menus_2.explain'), 'E', () => sh.explain(name))}
    </FloatMenu>
  );
}

export function TierMenu({ at, tierKey, onClose, openPicker }: { at: { x: number; y: number }; tierKey: string; onClose: () => void; openPicker: (k: PickerKind) => void }) {
  const lf = useLf();
  const sh = useAdvShell();
  const tier = lf.catalog?.tierByKey.get(tierKey);
  if (!tier) return null;
  const off = tierHidden(lf.doc.rules, tier);
  const own = tierRule(lf.doc.rules, tagOf(tier));
  const run = (f: () => void) => () => {
    onClose();
    f();
  };
  return (
    <FloatMenu at={at} onClose={onClose} width={240} label={tr('lootfilter_advanced_shell_Menus.actions_for_label', { label: tier.label })}>
      <div className="menu-head" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: 11.5, color: 'var(--text-muted)' }}>{tier.label}</div>
      <button type="button" role="menuitem" className="menu-item" onClick={run(() => { sh.select({ kind: 'tier', key: tier.key }); sh.openInspector('style'); })}>
        <Icon name="palette" size={14} />
        <span className="grow">{tr('lootfilter_advanced_shell_Menus.change_look')}</span>
        <span className="meta">{tr('lootfilter_advanced_shell_Menus.l')}</span>
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={run(() => { sh.select({ kind: 'tier', key: tier.key }); openPicker('snd'); })}>
        <Icon name="volume-low" size={14} />
        <span className="grow">{tr('lootfilter_advanced_shell_Menus.sound')}</span>
        <span className="meta">{tr('lootfilter_advanced_shell_Menus.s')}</span>
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={run(() => { const l = setTierHidden(lf, tier, !off); sh.toastUndo(l); })}>
        <Icon name={off ? 'eye' : 'eye-off'} size={14} />
        <span className="grow">{off ? tr('lootfilter_advanced_shell_Menus.show_this_tier') : tr('lootfilter_advanced_shell_Menus.hide_this_tier')}</span>
        <span className="meta">{tr('lootfilter_advanced_shell_Menus.h')}</span>
      </button>
      <div className="menu-sep" />
      <button type="button" role="menuitem" className="menu-item" disabled={!own} style={{ opacity: own ? 1 : 0.5 }} onClick={run(() => { resetTarget(lf, { kind: 'tier', tier }, tr('lootfilter_advanced_shell_Menus.reset_label', { label: tier.label })); sh.toastUndo(tr('lootfilter_advanced_shell_Menus.reset_label_to_neversink', { label: tier.label })); })}>
        <Icon name="reset" size={14} />
        <span className="grow">{tr('lootfilter_advanced_shell_Menus.reset_to_neversink')}</span>
      </button>
    </FloatMenu>
  );
}

export function MoveMenu({ at, name, onPick, onClose }: { at: { x: number; y: number }; name: string; onPick: (t: TierInfo) => void; onClose: () => void }) {
  const lf = useLf();
  const item = lf.catalog?.byName.get(name);
  const type = lf.catalog?.types.find((x) => x.type === item?.type);
  const curKey = item ? tierKeyOfItem(lf.doc.rules, item) : '';
  const tiers = type?.tiers ?? [];
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (/^[1-9]$/.test(e.key)) {
        const t = tiers[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          onPick(t);
        }
      }
    },
    [tiers, onPick],
  );
  if (!item || !type) return null;
  return (
    <FloatMenu at={at} onClose={onClose} width={340} label={tr('lootfilter_advanced_shell_Menus.move_to_tier')} onKey={onKey}>
      <div className="menu-head" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: 11.5, color: 'var(--text-muted)' }}>
        <span className="ellipsis" style={{ display: 'block' }}>{tr('lootfilter_advanced_shell_Menus.name_press_a_number', { name })}</span>
      </div>
      {tiers.map((t, i) => (
        <button key={t.key} type="button" role="menuitem" className="menu-item adv-sh-move-row" style={t.key === curKey ? { background: 'rgba(var(--accent-rgb),.1)' } : undefined} onClick={() => onPick(t)}>
          <span className="meta" style={{ marginLeft: 0, width: 14 }}>{i < 9 ? i + 1 : ''}</span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, alignItems: 'flex-start' }}>
            <span className="ellipsis" style={{ maxWidth: '100%' }}>{t.label}{t.kind === 'Hide' ? tr('lootfilter_advanced_shell_Menus.hidden') : ''}</span>
            {t.key === curKey && <span style={{ color: 'var(--gold-text)', fontSize: 11 }}>{tr('lootfilter_advanced_shell_Menus.current_tier')}</span>}
          </span>
          <span style={{ padding: '3px 5px', borderRadius: 5, background: 'radial-gradient(120% 90% at 50% 40%,#2a2419,#0d0b08)', display: 'flex' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 20, boxSizing: 'border-box', border: `1px solid ${rgba(t.style.bd ?? [0, 0, 0, 0])}`, background: rgba(t.style.bg ?? [0, 0, 0, 150]), color: rgba(t.style.fg ?? [200, 200, 200]), font: "400 13px/1 'Fontin SmallCaps','Cormorant SC',Georgia,serif", opacity: t.kind === 'Hide' ? 0.45 : 1 }}>{tr('lootfilter_advanced_shell_Menus.aa')}</span>
          </span>
        </button>
      ))}
    </FloatMenu>
  );
}
