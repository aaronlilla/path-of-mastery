// Start: the root of the Builds area when nothing is saved yet, or when the Library's League starts button asks for it.
// One screen replaces the old league-start chooser and the class-arc welcome: the class arc
// (large windows), the four ways to begin, the bundled league-start guides ('mastery:starters', no network, no sign-in)
// and what to do after the first build. League names come from the starter pack, never from this file.
import { useEffect, useMemo, useState } from 'react';
import { ClaudeMark } from '../ClaudeMark';
import { timelinesEnabled } from '../areaGate';
import { ATLAS_MECHANICS, LEAGUE_STARTERS, LEVELING_GUIDE } from '../../shared/leagueContent';
import { call } from '../mastery/bridge';
import { Icon, Kbd, Segmented } from '../ui';
import { ClassArc } from './ClassArc';
import './start.css';
import { tr } from '../i18n';

type StarterCard = { starterId: string; title: string; creatorName: string; budget: string; playstyles: string[]; lanes: string[]; league: string; patch: string; note: string };
type StarterState = { current: StarterCard[]; archiveCount: number; emptyMessage: string | null; actions: string[] };
const PLAY = ['starter', 'all', 'melee', 'ranged', 'minion', 'caster'] as const;
const LABEL: Record<(typeof PLAY)[number], string> = { starter: tr('home_Start.starter_cheap'), all: tr('home_Start_2.all'), melee: tr('home_Start_2.melee'), ranged: tr('home_Start_2.ranged'), minion: tr('home_Start_2.minion'), caster: tr('home_Start_2.caster') };

/** Where the builds folder read stands: still reading, read, or failed with the reason. */
export type LibraryRead = { state: 'loading' } | { state: 'ready' } | { state: 'error'; error: string };

export interface StartProps {
  lib: LibraryRead;
  version: string;
  signedIn: boolean;
  /** Set when builds exist (Start was opened from the Library): shows Back to your builds. */
  onBack?: (() => void) | undefined;
  /** Opens the Builds Archive (old-league builds), so it is in the header of the empty Builds screen too. */
  onArchive?: (() => void) | undefined;
  onPickClass: (className: string) => void;
  onNewBuild: () => void;
  onImportText: (text: string) => void;
  onOpenImport: (tab?: number) => void;
  onAssistant: () => void;
  onFollow: (starterId: string) => Promise<void>;
  onLootFilter: () => void;
  onAtlas: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onCheckUpdate: () => void;
  onSignIn: () => void;
  onRetry: () => void;
  onChooseFolder: () => void;
  onShowFolder: () => void;
}

/** The pack's own "none for this league" sentence, unless it points to Timelines while that area is switched off. */
const emptyText = (m: string | null) => (m && !(/timeline/i.test(m) && !timelinesEnabled()) ? m : tr('home_Start.no_league_starts_are_available'));

export function Start(p: StartProps) {
  const [starters, setStarters] = useState<StarterState | null>(null);
  const [failed, setFailed] = useState(false);
  const [play, setPlay] = useState<(typeof PLAY)[number]>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  useEffect(() => {
    if (!LEAGUE_STARTERS) return; // switched off (shared/leagueContent.ts): main does not serve the pack
    let alive = true;
    call<StarterState>('mastery:starters', { method: 'state' }).then((s) => alive && setStarters(s), () => alive && setFailed(true));
    return () => void (alive = false);
  }, []);

  const shown = useMemo(
    () =>
      (starters?.current ?? []).filter(
        (c) =>
          (play === 'all' || play === 'starter' ? true : c.playstyles.includes(play)) &&
          (play !== 'starter' || c.budget === 'cheap') &&
          (!query.trim() || `${c.title} ${c.creatorName}`.toLowerCase().includes(query.trim().toLowerCase())),
      ),
    [starters, play, query],
  );
  const first = starters?.current[0];
  const eyebrow = first ? tr('home_Start.path_of_exile_1_touppercase', { league: first.league.toUpperCase(), patch: first.patch }) : 'PATH OF EXILE 1';
  const loading = p.lib.state === 'loading';
  const busyProps = loading ? { disabled: true, 'aria-busy': true as const } : {};

  return (
    <div className="start" data-screen-label="Start">
      <div className="start-scroll scroll-y">
        <div className="start-col">
          {p.onBack && (
            <button type="button" className="start-back" onClick={p.onBack}>
              <Icon name="chevron-left" size={14} />
              {tr('home_Start.back_to_your_builds')}
            </button>
          )}
          <header className="start-head">
            {p.onArchive && <button type="button" className="btn start-archive" onClick={p.onArchive}><Icon name="history" size={14} />{tr('home_Start.archive')}</button>}
            <span className="eyebrow">{eyebrow}</span>
            <h1 className="start-h">{tr('home_Start.start_a_build')}</h1>
            <p className="start-sub">{LEAGUE_STARTERS ? tr('home_Start.pick_a_class_bring_a') : tr('home_Start.pick_a_class_or_bring')}</p>
          </header>

          {p.lib.state !== 'error' && (
            <div className="start-arc">
              <ClassArc onPick={p.onPickClass} />
            </div>
          )}

          {p.lib.state === 'error' ? (
            <div className="start-error" role="alert">
              <Icon name="warning" size={20} />
              <div className="tx">
                <b>{tr('home_Start.could_not_read_your_builds')}</b>
                <span className="why">{p.lib.error}</span>
              </div>
              <div className="acts">
                <button type="button" className="btn gold" onClick={p.onRetry}>
                  <Icon name="refresh" size={15} />
                  {tr('home_Start.try_again')}
                </button>
                <button type="button" className="btn" onClick={p.onChooseFolder}>{tr('home_Start.choose_another_folder')}</button>
                <button type="button" className="btn" onClick={p.onShowFolder}>{tr('home_Start.show_folder')}</button>
              </div>
            </div>
          ) : (
            <div className="start-tiles" aria-label={tr('home_Start.ways_to_start')}>
              <div className="start-tile primary">
                <button type="button" className="tile-main" onClick={p.onNewBuild} {...busyProps}>
                  <span className="t"><Icon name="plus" size={16} />{tr('home_Start.new_build')}</span>
                  <span className="d">{tr('home_Start.pick_a_class_the_tree')}</span>
                  <Kbd onGold>Ctrl N</Kbd>
                </button>
              </div>
              <div className="start-tile">
                <button type="button" className="tile-main" onClick={() => p.onOpenImport()} {...busyProps}>
                  <span className="t">{tr('home_Start.import_a_build')}</span>
                  <span className="d">{tr('home_Start.a_build_code_or_a')}</span>
                  <Kbd>Ctrl I</Kbd>
                </button>
                <div className="paste-box">
                  <input
                    value={paste}
                    disabled={loading}
                    onChange={(e) => setPaste(e.target.value)}
                    onPaste={(e) => {
                      const t = e.clipboardData.getData('text');
                      if (t.trim()) { e.preventDefault(); p.onImportText(t); }
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && paste.trim()) p.onImportText(paste); }}
                    placeholder={tr('home_Start.paste_code_or_link')}
                    spellCheck={false}
                    aria-label={tr('home_Start.paste_a_build_code_or')}
                  />
                </div>
              </div>
              <div className="start-tile">
                <button type="button" className="tile-main" onClick={() => p.onOpenImport(1)} {...busyProps}>
                  <span className="t">{tr('home_Start.import_a_character')}</span>
                  <span className="d">{tr('home_Start.pull_one_from_pathofexile_com')}</span>
                </button>
              </div>
              <div className="start-tile">
                <button type="button" className="tile-main" onClick={p.onAssistant} {...busyProps}>
                  <span className="t"><ClaudeMark size={15} />{tr('home_Start.ask_the_assistant')}</span>
                  <span className="d">{tr('home_Start.say_how_you_want_to')}</span>
                  <Kbd>Ctrl J</Kbd>
                </button>
              </div>
            </div>
          )}

          {LEAGUE_STARTERS && <section className="starter-chooser start-leagues" aria-labelledby="start-leagues-h">
            <div className="start-sec-head">
              <span id="start-leagues-h" className="lbl">{tr('home_Start.league_starts')}</span>
              <span className="rule" />
              <Segmented ariaLabel={tr('home_Start.playstyle')} value={play} onChange={setPlay} options={PLAY.map((v) => ({ value: v, label: LABEL[v] }))} />
              <input className="input start-find" aria-label={tr('home_Start.search_league_starts')} placeholder={tr('home_Start.search_league_starts_2')} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {!starters && !failed && <p role="status" className="start-note">{tr('home_Start.loading')}</p>}
            {failed && <p role="alert" className="start-note">{tr('home_Start.starters_could_not_load_you')}</p>}
            {starters && starters.current.length === 0 && <p className="start-note" role="status">{emptyText(starters.emptyMessage)}</p>}
            {starters && starters.current.length > 0 && shown.length === 0 && (
              <p className="start-note" role="status">
                {tr('home_Start.no_league_starts_match_these', { value: ' ' })}
                <button type="button" className="btn sm" onClick={() => { setPlay('all'); setQuery(''); }}>{tr('home_Start.clear_filters')}</button>
              </p>
            )}
            {shown.length > 0 && (
              <ul className="start-cards">
                {shown.map((c) => (
                  <li key={c.starterId} className="starter-card" data-starter={c.starterId}>
                    <h2 className="starter-title">{c.title.replace(/: league start$/i, '')}</h2>
                    <p className="starter-meta">{c.creatorName} · {c.league} {c.patch}</p>
                    <p className="starter-meta">{c.lanes.length === 1 && c.lanes[0] === 'Build' ? tr('home_Start.build_only') : c.lanes.join(' / ')} · {c.budget} · {c.playstyles.join(', ')}</p>
                    {open === c.starterId && <p className="starter-note">{tr('home_Start.note_not_tested_by_path', { note: c.note })}</p>}
                    <div className="starter-actions">
                      <button type="button" className="btn gold sm" disabled={busy !== null} onClick={() => { setBusy(c.starterId); p.onFollow(c.starterId).finally(() => setBusy(null)); }}>
                        {busy === c.starterId ? tr('home_Start.opening') : tr('home_Start.follow')}
                      </button>
                      <button type="button" className="btn sm" aria-expanded={open === c.starterId} onClick={() => setOpen(open === c.starterId ? null : c.starterId)}>{tr('home_Start.details')}</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>}

          <section className="start-after" aria-labelledby="start-after-h">
            <div className="start-sec-head">
              <span id="start-after-h" className="lbl">{tr('home_Start.after_your_first_build')}</span>
              <span className="rule" />
            </div>
            <div className="start-links">
              {LEVELING_GUIDE && (
                <button type="button" className="start-link" disabled title={tr('home_Start.open_a_build_first')}>
                  <Icon name="list" size={16} />
                  <span className="t">{tr('home_Start.leveling_guide')}</span>
                  <span className="d">{tr('home_Start.open_a_build_first')}</span>
                </button>
              )}
              <button type="button" className="start-link" onClick={p.onLootFilter}>
                <Icon name="filter" size={16} />
                <span className="t">{tr('home_Start.loot_filter')}</span>
                <span className="d">{tr('home_Start.written_for_your_build_with')}</span>
              </button>
              <button type="button" className="start-link" onClick={p.onAtlas}>
                <Icon name="globe" size={16} />
                <span className="t">{tr('home_Start.atlas_planner')}</span>
                <span className="d">{ATLAS_MECHANICS ? tr('home_Start.plan_your_atlas_tree_with') : tr('home_Start.plan_your_atlas_tree')}</span>
              </button>
            </div>
          </section>
        </div>
      </div>
      <footer className="start-foot">
        <button type="button" className="link" onClick={p.onOpenSettings}>
          <Icon name="settings" size={15} />
          {tr('home_Start.options')}
        </button>
        <button type="button" className="link" onClick={p.onOpenAbout}>
          <Icon name="info" size={15} />
          {tr('home_Start.about')}
        </button>
        <button type="button" className="link" onClick={p.onCheckUpdate}>
          <Icon name="cloud-down" size={15} />
          {tr('home_Start.check_for_update')}
        </button>
        <span className="sp" />
        {!p.signedIn && (
          <span className="signin">
            {tr('home_Start.have_cloud_builds_v2', { value: ' ' })}
            <button type="button" className="link gold" onClick={p.onSignIn}>
              {tr('home_Start.sign_in')}
            </button>{tr('home_Start.v1_to_bring_them_here', { value: ' ' })}
          </span>
        )}
        <span className="dot" />
        <span className="ver">{tr('home_Start.v_version', { version: p.version })}</span>
      </footer>
    </div>
  );
}
