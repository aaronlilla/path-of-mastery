import { createContext, useContext } from 'react';
import type { CatalogItem, TierInfo } from '../../../../shared/lootfilter/catalog.js';
import type { PickerKind } from './Pickers';

/**
 * What is selected in the Advanced screens, and the actions every view can ask of the shell. The shell
 * (AdvancedApp) owns the state; views import `useSelection()` for the small contract and `useAdvShell()` for
 * the rest (menus, explain, move to tier, toasts with Undo).
 */

export type Selection = { kind: 'item'; name: string } | { kind: 'tier'; key: string } | { kind: 'rule'; id: string };

export type InspectorTab = 'style' | 'items' | 'conditions' | 'history';

export type Ground = 'dark' | 'bright';

export interface AdvShell {
  selected: Selection | null;
  select(s: Selection | null): void;
  /** Opens (and shows) the Inspector, on a tab when given. */
  openInspector(tab?: InspectorTab): void;
  closeInspector(): void;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  setInspectorTab(t: InspectorTab): void;

  /** The ground behind label previews. */
  ground: Ground;
  setGround(g: Ground): void;

  /** Opens the Explain drawer for an item name (any base type). */
  explain(name: string): void;
  /** Right-click or "..." menu for an item or a tier, at viewport coordinates. */
  openItemMenu(at: { x: number; y: number }, name: string): void;
  openTierMenu(at: { x: number; y: number }, key: string): void;
  /** The Move to tier menu for an item. */
  openMove(at: { x: number; y: number } | null, name: string): void;
  /** Moves an item into a tier (a drop, or a pick in the Move menu), asking first when that would hide something valuable. */
  moveToTier(name: string, tier: TierInfo): void;
  /** Hides or shows one item, asking first when it is worth real currency. */
  setItemHidden(item: CatalogItem, hide: boolean): void;
  isLocked(name: string): boolean;
  toggleLock(name: string): void;
  /** Opens a section of Customize (a NeverSink type) and optionally a tier. */
  goSection(type: string, tierKey?: string): void;
  /** A toast with an Undo that always undoes the latest change. */
  toastUndo(text: string): void;
  /** A plain note that changed nothing, so it has no Undo. */
  toastInfo(text: string): void;
  /** Opens the Inspector with one of the pickers (colour, sound, icon, beam) already showing. */
  openPicker(kind: PickerKind): void;
  openAsk(): void;
  openPalette(): void;
  openSettings(): void;
  /** Opens the import result dialog after a filter text was imported. */
  showImportResult(r: ImportResult): void;
}

export interface ImportResult {
  name: string;
  game: string;
  basedOn: string;
  rules: string;
  problems: string;
  note?: string;
  onOpen?: () => void;
}

export const AdvShellCtx = createContext<AdvShell | null>(null);

export function useAdvShell(): AdvShell {
  const v = useContext(AdvShellCtx);
  if (!v) throw new Error('useAdvShell outside AdvancedApp');
  return v;
}

/** The small contract: the selected item or tier, select(), openInspector(). */
export function useSelection(): {
  selected: Selection | null;
  selectedItem: string | null;
  selectedTier: string | null;
  select(s: Selection | null): void;
  openInspector(tab?: InspectorTab): void;
} {
  const s = useAdvShell();
  return {
    selected: s.selected,
    selectedItem: s.selected?.kind === 'item' ? s.selected.name : null,
    selectedTier: s.selected?.kind === 'tier' ? s.selected.key : null,
    select: s.select,
    openInspector: s.openInspector,
  };
}
