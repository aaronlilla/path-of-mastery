import { useCallback, useEffect, useState } from 'react';
import type { ClientLogInfo } from '../../shared/lootfilter/ipcTypes.js';
import { suggestFromPlay, summarize, type PlaySuggestion, type PlaySummary } from '../../shared/lootfilter/play.js';
import { useLf } from './lfStore';
import { tr } from '../i18n';

export interface Play {
  loading: boolean;
  info: ClientLogInfo | null;
  summary: PlaySummary;
  suggestions: PlaySuggestion[];
  refresh(): void;
  /** Applies a strictness suggestion. */
  applySuggestion(s: PlaySuggestion): void;
}

/** What the game's Client.txt says about recent play: areas and levels. It holds no drops. */
export function usePlay(): Play {
  const lf = useLf();
  const [info, setInfo] = useState<ClientLogInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    setLoading(true);
    void window.pom.lootFilter.clientLog().then((r) => {
      setInfo(r.ok ? r.value : { found: false, path: '', areas: [], note: r.ok ? undefined : r.error });
      setLoading(false);
    });
  }, []);
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lf.settings.clientLogPath]);
  const summary = summarize(info?.areas ?? []);
  const suggestions = suggestFromPlay(summary, lf.doc.setup.strictness, lf.hidden);
  return {
    loading,
    info,
    summary,
    suggestions,
    refresh,
    applySuggestion: (s) => lf.edit(tr('lootfilter_usePlay.strictness_title', { title: s.title }), (d) => ({ ...d, setup: { ...d.setup, strictness: s.toStrictness } })),
  };
}
