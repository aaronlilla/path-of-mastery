import type { FilterDoc } from '../../shared/lootfilter/types.js';
import type { LootFilterState } from '../../shared/lootfilter/ipcTypes.js';
import { tr } from '../i18n';

/** A recovery file from the Save failed dialog holds the whole saved state (the shape of filters.json): its filters, active first. */
export function readRecovery(text: string): FilterDoc[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const s = raw as Partial<LootFilterState> | null;
  if (!s || s.version !== 1 || !Array.isArray(s.filters)) return null;
  const docs = s.filters.filter((f): f is FilterDoc => !!f && typeof f.id === 'string' && typeof f.name === 'string' && Array.isArray(f.rules) && !!f.setup);
  if (!docs.length) return null;
  const active = docs.find((f) => f.id === s.activeId) ?? docs[0]!;
  return [active, ...docs.filter((f) => f !== active)];
}

type Imported = { kind: string; message: string };

/** "Open recovery file": only a recovery file is imported. Anything else (a .filter, a rule pack) changes nothing and shows the error. */
export async function openRecovery(
  file: { name: string; text: string },
  importAny: (name: string, text: string) => Promise<Imported>,
  toast: (t: { text: string; kind: 'ok' | 'error' }) => void,
): Promise<void> {
  if (!readRecovery(file.text)) return void toast({ text: tr('lootfilter_recovery.that_is_not_a_recovery'), kind: 'error' });
  const res = await importAny(file.name, file.text);
  toast({ text: res.kind === 'recovery' ? res.message : tr('lootfilter_recovery.that_is_not_a_recovery'), kind: res.kind === 'recovery' ? 'ok' : 'error' });
}
