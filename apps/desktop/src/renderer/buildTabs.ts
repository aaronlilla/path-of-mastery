// The open build's tab row, shared by the workspace, Ctrl+Alt 1 to 9 and the palette. A switched-off tab (shared/leagueContent.ts)
// is left out, and the shortcut numbers follow the visible tabs in order.
import { LEVELING_GUIDE } from '../shared/leagueContent.js';
import type { TabId } from './types.js';
import { tr } from './i18n';

type Tab = { id: TabId; label: string; icon: string; key?: string; search?: string };

const ALL: Tab[] = [
  { id: 'tree', label: tr('BuildWorkspace.tab_tree'), icon: 'tree', search: 'tree' },
  { id: 'skills', label: tr('BuildWorkspace.tab_skills'), icon: 'gem', search: 'gem' },
  { id: 'items', label: tr('BuildWorkspace.tab_items'), icon: 'body-armour', search: 'item' },
  { id: 'calcs', label: tr('BuildWorkspace.tab_calcs'), icon: 'calcs', search: 'dps' },
  { id: 'fight', label: tr('h_f_Tabs.fight'), icon: 'timer', search: 'boss kill time ttk simulation' },
  { id: 'config', label: tr('BuildWorkspace.tab_config'), icon: 'config', search: 'config settings' },
  { id: 'compare', label: tr('BuildWorkspace.tab_compare'), icon: 'compare', search: 'diff' },
  { id: 'party', label: tr('BuildWorkspace.tab_party'), icon: 'party', search: 'aura' },
  { id: 'notes', label: tr('BuildWorkspace.tab_notes'), icon: 'notes' },
  { id: 'leveling', label: tr('BuildWorkspace.tab_leveling'), icon: 'path', search: 'leveling guide follow along gems' },
];

/** The visible tabs, left to right; Ctrl+Alt N opens TABS[N - 1]. */
export const TABS: Tab[] = ALL.filter((t) => LEVELING_GUIDE || t.id !== 'leveling').map((t, i) => ({ ...t, key: `Ctrl Alt ${i + 1}` }));

/** False for a tab that is switched off, so a restored or requested tab falls back instead of opening it. */
export const tabVisible = (id: TabId): boolean => id === 'import' || TABS.some((t) => t.id === id);

/** The palette's tab rows: every visible tab plus Import/Export (no shortcut). */
export const PALETTE_TABS: Array<[TabId, string, string, string?]> = [
  ...TABS.map((t): [TabId, string, string, string?] => [t.id, t.label, t.key ?? '', t.search]),
  ['import', tr('BuildWorkspace.import_export'), '', 'import share export'],
];
