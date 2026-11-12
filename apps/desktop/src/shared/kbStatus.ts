/** What the window knows about the game knowledge base (main/kb/service.ts fills it). */
export interface KbUiStatus {
  /** Game patch of the datamined tables, e.g. "3.29.3.3". */
  dataPatch: string | null;
  /** Live patch from the last check; null when never checked. */
  livePatch: string | null;
  behind: boolean;
  /** Plain words, e.g. "data is 3.29.3.3, live is 3.29.4.0"; null when current. */
  behindBy: string | null;
  lastRefresh: string | null;
  lastCheck: string | null;
  refreshing: boolean;
  lastError: string | null;
}

/** The badge text and tone for the assistant header. */
export function kbBadge(s: KbUiStatus | null): { text: string; title: string; tone: 'ok' | 'behind' | 'busy' | 'none' } {
  if (!s || !s.dataPatch) return { text: 'Game data: loading', title: 'The game knowledge base is loading.', tone: 'none' };
  if (s.refreshing) return { text: `Data for patch ${s.dataPatch}`, title: 'Updating the game data in the background.', tone: 'busy' };
  if (s.behind) return { text: `Data for patch ${s.dataPatch}`, title: `${s.behindBy ?? 'Newer game data exists'}. Click to update now.`, tone: 'behind' };
  return { text: `Data for patch ${s.dataPatch}`, title: `The game data is current${s.lastCheck ? ` (checked ${s.lastCheck})` : ''}.`, tone: 'ok' };
}
