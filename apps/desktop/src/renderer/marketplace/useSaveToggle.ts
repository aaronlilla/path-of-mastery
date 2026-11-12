import { useRef, useState } from 'react';
import type { PublicItemPayload } from '@pom/mastery-contracts';
import { useToast } from '../ui.js';
import type { MarketplaceServices } from './services.js';
import type { SavedReference } from '../../main/marketplace/cache.js';
import { SaveGenerations, saveView, type SaveLocal } from './presenter.js';

/**
 * Save toggle: the first press saves the pinned revision, the next press takes the reference off with an Undo toast.
 * `shared` is the viewer's Saved index entry for this item. It is the truth for the card and the detail page alike; the local answer only covers
 * the moment until the index is refreshed (saveView).
 */
export function useSaveToggle(item: PublicItemPayload, services: MarketplaceServices, shared: { objectId: string } | undefined, onSaved?: (r: SavedReference) => void) {
  const toast = useToast();
  const [local, setLocal] = useState<SaveLocal | null>(null);
  const generations = useRef(new SaveGenerations()), generation = generations.current.of(shared);
  const latest = useRef(generation); latest.current = generation;
  const remember = (saved: boolean, objectId: string | null) => setLocal({ saved, objectId, generation: latest.current });
  const { saved, objectId } = saveView(shared, generation, local);
  const [busy, setBusy] = useState(false), [note, setNote] = useState('');
  const toggle = async () => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      if (!saved) { const ref = await services.save(item); remember(true, ref.objectId); onSaved?.(ref); return; }
      if (!services.unsave) return;
      const id = objectId ?? (await services.save(item)).objectId; // saved elsewhere (Follow): saving again only finds the same reference
      await services.unsave(id); remember(false, null);
      toast({ text: 'Removed from Saved.', kind: 'info', key: 'saved-removed', action: { label: 'Undo', run: () => { void services.undoUnsave?.(id).then(() => remember(true, id), () => setNote('Could not undo. Save it again.')); } } });
    } catch { setNote(saved ? 'Could not remove it. Try again.' : 'Could not save. Try again.'); } finally { setBusy(false); }
  };
  return { saved, busy, note, toggle, markSaved: () => remember(true, objectId) };
}
