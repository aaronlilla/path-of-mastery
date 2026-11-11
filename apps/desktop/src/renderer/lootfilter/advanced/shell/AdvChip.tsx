import type { CSSProperties, DragEvent, MouseEvent } from 'react';
import type { CatalogItem } from '../../../../shared/lootfilter/catalog.js';
import { LABEL_DESIGN_PX } from '../../../../shared/lootfilter/styles.js';
import { LabelChip } from '../../LabelChip';
import { itemPriceText, useLf } from '../../lfStore';
import { useAdvShell } from './selection';
import { tr } from '../../../i18n';
import { strictName } from '../../names';

export const DRAG_MIME = 'application/x-pom-item';

/** Items hidden at the next strictness level, from NeverSink's own seven files. */
export function hiddenNext(maskOf: Record<string, number> | undefined, name: string, strictness: number): boolean {
  if (!maskOf || strictness >= 6) return false;
  const m = maskOf[name];
  return m !== undefined && ((m >> (strictness + 1)) & 1) === 1;
}

/**
 * A catalog item drawn the way the game draws it, wired to the Advanced shell: click selects and opens the
 * Inspector, double-click explains, right-click and the "..." button open the actions menu.
 */
export function AdvChip({
  item,
  ghost,
  draggable,
  fontPx,
  small,
  noMenu,
  noPrice,
  onDragState,
  styleOverride,
}: {
  item: CatalogItem;
  /** Draw the item faded with a "Hidden at <next level>" tag when the next strictness would hide it. */
  ghost?: boolean;
  draggable?: boolean;
  fontPx?: number;
  small?: boolean;
  noMenu?: boolean;
  noPrice?: boolean;
  onDragState?: (name: string | null) => void;
  styleOverride?: CSSProperties;
}) {
  const lf = useLf();
  const sh = useAdvShell();
  const r = lf.evaluateCatalogItem(item);
  const hidden = r ? !r.visible : item.hidden;
  const mine = !!r?.matched.some((b) => b.ruleId);
  const strict = lf.doc.setup.strictness;
  const priceText = noPrice || hidden || !lf.settings.showPrices ? undefined : itemPriceText(lf.prices, item.name, lf.settings.currencyUnit);
  const next = !!ghost && !hidden && hiddenNext(lf.hidden?.mask, item.name, strict);
  const level = strictName(Math.min(6, strict + 1));
  const hidTag = hidden ? (r?.decided?.ruleId ? tr('lootfilter_advanced_shell_AdvChip.hidden_by_your_rule') : tr('lootfilter_advanced_shell_AdvChip.hidden_at_name', { name: strictName(strict) })) : undefined;
  const selected = sh.selected?.kind === 'item' && sh.selected.name === item.name;
  const bright = sh.ground === 'bright';
  const gt = bright ? 'rgba(24,20,14,.86)' : 'rgba(255,240,215,.62)';
  const open = (e: MouseEvent): void => {
    e.stopPropagation();
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    sh.openItemMenu({ x: b.left, y: b.bottom + 4 }, item.name);
  };
  return (
    <LabelChip
      name={item.name}
      style={r?.style ?? item.style}
      fontPx={fontPx ?? (small ? 18 : LABEL_DESIGN_PX)}
      {...(!fontPx && !small ? { autoFit: true } : {})}
      hidden={hidden}
      hiddenLook="fade"
      bright={bright}
      selected={selected}
      changed={mine}
      locked={sh.isLocked(item.name)}
      title={`${item.name}${hidden ? ` (${tr('lootfilter_guided_Home.hidden')})` : ''}${mine ? ` · ${tr('lootfilter_guided_Home.changed_by_you')}` : ''}`}
      {...(priceText ? { price: priceText } : {})}
      {...(hidTag ? { hidTag } : {})}
      {...(next ? { extra: <span style={{ flex: 'none', font: '500 10.5px Geist', padding: '1px 5px', borderRadius: 4, border: `1px dashed ${gt}`, color: gt, whiteSpace: 'nowrap' }}>{tr('lootfilter_advanced_shell_AdvChip.hidden_at_level', { level })}</span> } : {})}
      style_={{ ...(next ? { opacity: 0.55 } : {}), ...(draggable ? { cursor: 'grab' } : {}), ...(styleOverride ?? {}) }}
      onClick={(e) => {
        e.stopPropagation();
        sh.select({ kind: 'item', name: item.name });
        sh.openInspector();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        sh.explain(item.name);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        sh.select({ kind: 'item', name: item.name });
        sh.openItemMenu({ x: e.clientX, y: e.clientY }, item.name);
      }}
      {...(!noMenu ? { onMenu: open, menuLabel: tr('lootfilter_advanced_shell_AdvChip.actions_for_name', { name: item.name }) } : {})}
      {...(draggable
        ? {
            draggable: true,
            onDragStart: (e: DragEvent) => {
              try {
                e.dataTransfer.setData('text/plain', item.name);
                e.dataTransfer.setData(DRAG_MIME, item.name);
                e.dataTransfer.effectAllowed = 'move';
              } catch {
                // the drag still works inside the page
              }
              onDragState?.(item.name);
            },
            onDragEnd: () => onDragState?.(null),
          }
        : {})}
    />
  );
}
