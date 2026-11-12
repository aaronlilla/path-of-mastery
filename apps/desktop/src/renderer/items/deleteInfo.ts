import type { ItemsModel } from '../../shared/itemsXml.js';
import { tr } from '../i18n';

/**
 * Where an item is equipped, in the words upstream's Delete Item confirmation uses (`ItemListClass:OnSelDelete`):
 * "Ring 1", "Ring 1 in set 'Endgame'" (a set that is not the active one), "an Abyssal Socket", or
 * "passive tree 'Default'". Null when the item is not equipped anywhere.
 */
export function equippedWhere(model: ItemsModel, id: number): string | null {
  const label = (slot: string) => (/Abyssal/i.test(slot) ? tr('items_deleteInfo.an_abyssal_socket') : slot);
  const ordered = [...model.sets].sort((a, b) => (a.id === model.activeSet ? -1 : b.id === model.activeSet ? 1 : 0));
  for (const s of ordered) {
    for (const [name, ref] of s.slots) {
      if (ref.itemId === id) return s.id === model.activeSet ? label(name) : tr('items_deleteInfo.in_set', { name: label(name), Default: s.title || 'Default' });
    }
  }
  for (const sp of model.specs) {
    for (const itemId of sp.sockets.values()) if (itemId === id) return tr('items_deleteInfo.passive_tree', { Default: sp.title || 'Default' });
  }
  return null;
}
