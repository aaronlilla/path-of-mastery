import { useSyncExternalStore } from 'react';
import type { CharacterRow, Realm } from '../../shared/characterImport.js';
import { ITEMS_AND_SKILLS, TREE_AND_JEWELS } from '../../shared/characterImport.js';
import { fromMain } from '../i18n';

/** The character selected in the Import/Export tab, kept so the Compare tab's "Re-import Current" can read it again. */
export interface SelectedCharacter {
  source: 'account' | 'name';
  realm: Realm;
  account: string;
  character: CharacterRow;
}

const chosen = new Map<'account' | 'name', SelectedCharacter>();
let last: 'account' | 'name' | null = null;
let snapshot: SelectedCharacter | null = null;
const listeners = new Set<() => void>();

/** Called by the Import/Export tab whenever its selection changes (null: nothing selected). */
export function rememberCharacter(source: 'account' | 'name', sel: SelectedCharacter | null): void {
  const had = chosen.get(source);
  if (sel) {
    if (had && had.character.name === sel.character.name && had.realm === sel.realm && had.account === sel.account) return;
    chosen.set(source, sel);
    last = source;
  } else if (had) {
    chosen.delete(source);
    if (last === source) last = [...chosen.keys()][0] ?? null;
  } else return;
  snapshot = last ? (chosen.get(last) ?? null) : null;
  listeners.forEach((l) => l());
}

export function useSelectedCharacter(): SelectedCharacter | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/** Reads the character again (passive tree, jewels, items and skills, with upstream's "delete" boxes on) and applies it to the build text. */
export async function reimportCharacter(sel: SelectedCharacter, xml: string): Promise<{ ok: true; xml: string; notes: string[] } | { ok: false; error: string }> {
  let cur = xml;
  const notes: string[] = [];
  for (const parts of [{ ...TREE_AND_JEWELS, deleteJewels: true }, { ...ITEMS_AND_SKILLS, deleteItems: true, deleteSkills: true }]) {
    const f = await window.pom.character.fetch({ source: sel.source, realm: sel.realm, account: sel.account, character: sel.character, parts });
    if (!f.ok) return { ok: false, error: fromMain('ml_io_errors', f.error) };
    const a = await window.pom.character.apply(cur, f.value, parts);
    if (!a.ok) return { ok: false, error: fromMain('ml_io_errors', a.error) };
    cur = a.value.xml;
    notes.push(...a.value.notes);
  }
  return { ok: true, xml: cur, notes };
}
