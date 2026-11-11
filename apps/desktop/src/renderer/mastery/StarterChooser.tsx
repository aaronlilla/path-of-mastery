// First launch: Pick a league start. Cards come from the bundled, qualified starter pack through main ('mastery:starters');
// nothing is fetched, no sign-in is needed. A Build-only starter opens as a normal library build.
import { useEffect, useMemo, useState } from 'react';
import { Segmented } from '../ui';
import { call } from './bridge';
import './starters.css';
import { tr } from '../i18n';

export type StarterCard = { starterId: string; title: string; creatorName: string; budget: string; playstyles: string[]; lanes: string[]; league: string; patch: string; note: string };
type State = { current: StarterCard[]; archiveCount: number; emptyMessage: string | null; actions: string[] };
const PLAY = ['starter', 'all', 'melee', 'ranged', 'minion', 'caster'] as const;
const LABEL: Record<(typeof PLAY)[number], string> = { starter: tr('mastery_StarterChooser.starter_cheap'), all: tr('mastery_StarterChooser.all'), melee: tr('mastery_StarterChooser.melee'), ranged: tr('mastery_StarterChooser.ranged'), minion: tr('mastery_StarterChooser.minion'), caster: tr('mastery_StarterChooser.caster') };

export function StarterChooser(p: {
  onFollow(starterId: string): Promise<void>;
  onNewBuild(): void;
  onImportBuild(): void;
  /** Timeline entry points: left out while Timelines/Marketplace are switched off (areaGate.ts), and then their buttons are not shown. */
  onImportTimeline?(): void;
  onOpenBuilds(): void;
  onCreateTimeline?(): void;
  onBrowse?(): void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);
  const [play, setPlay] = useState<(typeof PLAY)[number]>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { call<State>('mastery:starters', { method: 'state' }).then(setState, () => setFailed(true)); }, []);

  const shown = useMemo(() => (state?.current ?? []).filter((c) =>
    (play === 'all' || play === 'starter' ? true : c.playstyles.includes(play)) &&
    (play !== 'starter' || c.budget === 'cheap') &&
    (!query.trim() || `${c.title} ${c.creatorName}`.toLowerCase().includes(query.trim().toLowerCase()))), [state, play, query]);
  const league = state?.current[0] ? `${state.current[0].league} / ${state.current[0].patch}` : null;

  return (
    <section className="starter-chooser" aria-labelledby="starter-h">
      <header className="starter-head">
        <span className="eyebrow">{tr('mastery_StarterChooser.league_start')}</span>
        <h1 id="starter-h" className="starter-h">{tr('mastery_StarterChooser.pick_a_league_start')}</h1>
        <p className="starter-p">{tr('mastery_StarterChooser.follow_a_guide_s_build_to')} {league ? tr('mastery_StarterChooser.league', { league: league }) : ''}</p>
      </header>
      <div className="starter-filters">
        <Segmented ariaLabel={tr('mastery_StarterChooser.playstyle')} value={play} onChange={setPlay} options={PLAY.map((v) => ({ value: v, label: LABEL[v] }))} />
        <input className="input" aria-label={tr('mastery_StarterChooser.search_league_starts')} placeholder={tr('mastery_StarterChooser.search_league_starts_2')} value={query} onChange={(e) => setQuery(e.target.value)} />
        {p.onBrowse && <button type="button" className="btn" onClick={p.onBrowse}>{tr('mastery_StarterChooser.browse_all_timelines')}</button>}
      </div>
      {!state && !failed && <p role="status" className="starter-p">{tr('mastery_StarterChooser.loading')}</p>}
      {failed && <p role="alert" className="starter-p">{tr('mastery_StarterChooser.starters_could_not_load_you_can')}</p>}
      {state && state.current.length === 0 && (
        <p className="starter-p" role="status">{state.emptyMessage ?? tr('mastery_StarterChooser.no_league_starts_are_available_for')}</p>
      )}
      {state && state.current.length > 0 && shown.length === 0 && (
        <p className="starter-p" role="status">{tr('mastery_StarterChooser.no_league_starts_match_these_filters')} <button type="button" className="btn" onClick={() => { setPlay('all'); setQuery(''); }}>{tr('mastery_StarterChooser.clear_filters')}</button></p>
      )}
      <ul className="starter-grid">
        {shown.map((c) => (
          <li key={c.starterId} className="starter-card" data-starter={c.starterId}>
            <h2 className="starter-title">{c.title.replace(/: league start$/i, '')}</h2>
            <p className="starter-meta">{c.creatorName} / {c.league} {c.patch}</p>
            <p className="starter-meta">{c.lanes.join(' / ')} / {c.budget} / {c.playstyles.join(', ')}</p>
            {open === c.starterId && <p className="starter-note">{c.note}  {tr('mastery_StarterChooser.not_tested_by_path_of_mastery')}</p>}
            <div className="starter-actions">
              <button type="button" className="btn gold" disabled={busy !== null} onClick={() => { setBusy(c.starterId); p.onFollow(c.starterId).finally(() => setBusy(null)); }}>
                {busy === c.starterId ? tr('mastery_StarterChooser.opening') : tr('mastery_StarterChooser.follow')}
              </button>
              <button type="button" className="btn" aria-expanded={open === c.starterId} onClick={() => setOpen(open === c.starterId ? null : c.starterId)}>{tr('mastery_StarterChooser.details')}</button>
            </div>
          </li>
        ))}
      </ul>
      <footer className="starter-foot">
        <button type="button" className="btn" onClick={p.onNewBuild}>{tr('mastery_StarterChooser.new_build')}</button>
        <button type="button" className="btn" onClick={p.onImportBuild}>{tr('mastery_StarterChooser.import_a_build')}</button>
        {p.onImportTimeline && <button type="button" className="btn" onClick={p.onImportTimeline}>{tr('mastery_StarterChooser.import_a_timeline')}</button>}
        <button type="button" className="btn" onClick={p.onOpenBuilds}>{tr('mastery_StarterChooser.open_builds')}</button>
        {p.onCreateTimeline && <button type="button" className="btn" onClick={p.onCreateTimeline}>{tr('mastery_StarterChooser.create_a_timeline')}</button>}
      </footer>
    </section>
  );
}
