import { CommunityList } from './community';
import type { CommunityBuild } from '../shared/community.js';
import { artFor } from './gameArt.js';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, BuildEntry, FolderEntry, LibraryListing } from '../shared/library.js';
import type { BuildSyncStatus } from '../shared/accounts.js';
import { classKey, classPortrait, GHOSTS } from './art';
import { compactNumber, exactNumber, folderLabel, formatWhen, levelLabel, matchesQuery } from './format';
import { ActionMenu, type MenuAction } from './menu';
import { Icon, Kbd, PortalMenu } from './ui';
import { SyncBadge } from './accounts/SyncBadge';
import { useAcct } from './accounts/useAccount';
import { ArchivePanel } from './documents/ArchivePanel';
import { currentBuildLeague, oldBuilds } from './documents/archiveBuilds';
import { tr } from './i18n';

export interface LibraryProps {
  listing: LibraryListing | null;
  settings: AppSettings;
  folder: string;
  setFolder: (f: string) => void;
  blocked: boolean;
  onOpen: (b: BuildEntry) => void;
  onNewBuild: () => void;
  onImport: () => void;
  /** Opens Start (league-start guides, class arc) with a way back here. */
  /** Absent while league starts are switched off (shared/leagueContent.ts): no League starts button. */
  onLeagueStarts?: () => void;
  onNewFolder: () => void;
  /** Copies an archived build onto the current tree version; returns an error text, or null when the copy was made. */
  onArchiveCopy: (b: BuildEntry, name: string) => Promise<string | null>;
  onRename: (b: BuildEntry) => void;
  onDuplicate: (b: BuildEntry) => void;
  onMove: (b: BuildEntry) => void;
  /** A build was dropped on a folder (or the Builds root, ''). */
  onMoveTo: (b: BuildEntry, folder: string) => void;
  onDelete: (b: BuildEntry) => void;
  onCopyCode: (b: BuildEntry) => void;
  onRenameFolder: (f: FolderEntry) => void;
  onDeleteFolder: (f: FolderEntry) => void;
  onOpenTrash: () => void;
  onReveal: () => void;
  onPatchSettings: (patch: Partial<AppSettings>) => void;
  /** Cloud: put a build in the cloud, take it out, show its versions, resolve its conflict, send every local build. */
  onSyncToCloud?: (b: BuildEntry) => void;
  onStopSync?: (b: BuildEntry) => void;
  onHistory?: (b: BuildEntry) => void;
  onResolve?: (b: BuildEntry) => void;
  onSyncAll?: () => void;
  /** Community builds: open one as a new local build; show the player's own published builds. */
  onOpenCommunity?: (b: CommunityBuild) => void;
  onManageCommunity?: () => void;
}

const DRAG_TYPE = 'application/x-pom-build';

const SORTS: { id: AppSettings['librarySort']; label: string }[] = [
  { id: 'edited', label: tr('Library.last_edited') },
  { id: 'name', label: tr('Library.name') },
  { id: 'class', label: tr('Library.class') },
  { id: 'level', label: tr('Library.level') },
];

export const LibrarySearchInput = forwardRef<HTMLInputElement, { value: string; onChange: (v: string) => void }>(function LibrarySearchInput({ value, onChange }, ref) {
  // The example in the hint is dropped in a narrow window, so the placeholder is never cut mid-word.
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1000);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 1000);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return (
    <div className="lib-search" data-lg="tile" data-r="bl-search">
      <Icon name="search" size={17} />
      <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} placeholder={narrow ? tr('Library.search_builds_classes_or_skills') : tr('Library.search_builds_classes_or_skills_2')} spellCheck={false} aria-label={tr('Library.search_builds')} />
      {value ? (
        <button type="button" className="clear" aria-label={tr('Library.clear_search')} onClick={() => onChange('')}>
          <Icon name="x" size={14} />
        </button>
      ) : (
        <Kbd>Ctrl F</Kbd>
      )}
    </div>
  );
});

export function Library(props: LibraryProps & { searchRef: React.RefObject<HTMLInputElement> }) {
  const { listing, settings, folder, setFolder } = props;
  const acct = useAcct();
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const closeSort = useCallback(() => setSortOpen(false), []);

  const builds = listing?.builds ?? [];
  const folders = listing?.folders ?? [];
  const searching = query.trim() !== '';
  const subfolders = useMemo(() => folders.filter((f) => f.path.slice(0, f.path.lastIndexOf('/') + 1).replace(/\/$/, '') === folder), [folders, folder]);
  const isCloud = useCallback((b: BuildEntry) => acct.signedIn && !!acct.statusOf(b.id), [acct]);
  const sortBuilds = useCallback(
    (pool: BuildEntry[]) => {
    const by = settings.librarySort;
    const cmpName = (a: BuildEntry, b: BuildEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    return [...pool].sort((a, b) => {
      if (by === 'name') return cmpName(a, b);
      if (by === 'class') return (a.info.ascendClassName || a.info.className).localeCompare(b.info.ascendClassName || b.info.className) || cmpName(a, b);
      if (by === 'level') return b.info.level - a.info.level || cmpName(a, b);
      return b.mtimeMs - a.mtimeMs;
    });
    },
    [settings.librarySort],
  );
  // Cloud builds show in their own section whatever folder is open; the rest are the folder's local builds.
  const cloudBuilds = useMemo(() => sortBuilds(builds.filter((b) => isCloud(b) && (!searching || matchesQuery(b, query)))), [builds, isCloud, query, searching, sortBuilds]);
  const localBuilds = useMemo(() => sortBuilds((searching ? builds.filter((b) => matchesQuery(b, query)) : builds.filter((b) => b.folder === folder)).filter((b) => !isCloud(b))), [builds, folder, isCloud, query, searching, sortBuilds]);
  const visible = useMemo(() => [...cloudBuilds, ...localBuilds], [cloudBuilds, localBuilds]);

  useEffect(() => {
    if (!visible.some((b) => b.id === sel)) setSel(visible[0]?.id ?? null);
  }, [visible, sel]);

  // Arrow keys, Enter, F2 and Delete work on the selected build when nothing else has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (props.blocked) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const i = visible.findIndex((b) => b.id === sel);
      const cur = visible[i];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        const b = visible[n];
        if (b) {
          setSel(b.id);
          document.querySelector(`[data-build-id="${CSS.escape(b.id)}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Enter' && cur && !(t instanceof HTMLButtonElement)) {
        e.preventDefault();
        props.onOpen(cur);
      } else if (e.key === 'F2' && cur) {
        e.preventDefault();
        props.onRename(cur);
      } else if (e.key === 'Delete' && cur) {
        e.preventDefault();
        props.onDelete(cur);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const total = builds.length;
  const [archive, setArchive] = useState(false);
  // Dragging a build onto a folder chip, a crumb or the Builds root moves it there.
  const dropProps = (path: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropOn !== path) setDropOn(path);
    },
    onDragLeave: () => setDropOn((p) => (p === path ? null : p)),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      setDropOn(null);
      if (!id) return;
      e.preventDefault();
      const b = builds.find((x) => x.id === id);
      if (b && b.folder !== path) props.onMoveTo(b, path);
    },
  });
  const crumbs = folder ? folder.split('/') : [];
  const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  const buildActions = (b: BuildEntry): MenuAction[] => [
    { label: tr('Library.open'), icon: 'external', run: () => props.onOpen(b) },
    { label: tr('Library.duplicate'), icon: 'files', run: () => props.onDuplicate(b) },
    { label: tr('Library.rename'), icon: 'edit', meta: 'F2', run: () => props.onRename(b) },
    { label: tr('Library.move_to_folder'), icon: 'folder', run: () => props.onMove(b) },
    { label: tr('Library.show_in_explorer'), icon: 'folder', run: () => void window.pom.lib.reveal(b.id) },
    { label: tr('Library.copy_build_code'), icon: 'copy', run: () => props.onCopyCode(b) },
    ...(acct.signedIn
      ? isCloud(b)
        ? [
            { label: tr('Library.version_history'), icon: 'history', run: () => props.onHistory?.(b) },
            { label: tr('Library.stop_syncing_keep_on_this'), icon: 'cloud-off', run: () => props.onStopSync?.(b) },
          ]
        : [{ label: tr('Library.sync_to_cloud'), icon: 'cloud', run: () => props.onSyncToCloud?.(b) }]
      : []),
    { sep: true },
    { label: tr('Library.delete'), icon: 'trash', danger: true, meta: 'Del', run: () => props.onDelete(b) },
  ];
  const sortLabel = SORTS.find((s) => s.id === settings.librarySort)?.label ?? tr('Library.last_edited');

  return (
    <div className="lib" data-screen-label="Build Library">
      {archive && <ArchivePanel area="Builds" current={currentBuildLeague} rows={oldBuilds(builds)} emptyText={tr('Library.no_archived_builds_every_build')} onClose={() => setArchive(false)}
        onCopy={(row, name) => props.onArchiveCopy(builds.find((b) => b.id === row.id)!, name)} />}
      <div className="lib-ghost" aria-hidden>
        {GHOSTS.map((g, i) => (
          <span key={i} style={{ backgroundImage: `url(${g.src})`, marginTop: g.mt }} />
        ))}
      </div>
      <div className="lib-wash" />
      <div className="lib-main scroll-y" data-r="bl-main">
        <div className="lib-head" data-r="bl-head">
          <div className="titles">
            <span className="eyebrow">{tr('Library.library_count_builds', { count: total })}</span>
            <span className="lib-h1" data-r="bl-h1">{tr('Library.your_builds')}</span>
          </div>
          <button type="button" className="btn lg" data-lg="control" data-r="bl-btn" onClick={props.onNewFolder}>
            <Icon name="folder-plus" size={16} />
            {tr('Library.new_folder')}
          </button>
          <button type="button" className="btn lg" data-lg="control" data-r="bl-btn" onClick={() => setArchive(true)}>
            <Icon name="history" size={16} />
            {tr('Library.archive')}
          </button>
          {props.onLeagueStarts && (
            <button type="button" className="btn lg" data-lg="control" data-r="bl-btn" onClick={props.onLeagueStarts}>
              <Icon name="flag" size={16} />
              {tr('Library.league_starts')}
            </button>
          )}
          <button type="button" className="btn lg" data-lg="control" data-r="bl-btn" onClick={props.onImport}>
            <Icon name="import" size={16} />
            {tr('Library.import')}
            <Kbd>Ctrl I</Kbd>
          </button>
          <button type="button" className="btn lg gold" data-r="bl-btn" onClick={props.onNewBuild}>
            <Icon name="plus" size={14} />
            {tr('Library.new_build')}
            <Kbd onGold>Ctrl N</Kbd>
          </button>
        </div>
        <div className="lib-tools" data-r="bl-tools">
          <LibrarySearchInput ref={props.searchRef} value={query} onChange={setQuery} />
          <div style={{ position: 'relative', flex: 'none' }}>
            <button ref={sortBtn} type="button" className="lib-sort" data-lg="tile" data-r="bl-sort" aria-haspopup="listbox" aria-expanded={sortOpen} aria-label={tr('Library.sort_builds')} onClick={() => setSortOpen((v) => !v)}>
              <span className="two">
                <small>{tr('Library.sort')}</small>
                <span className="ellipsis">{sortLabel}</span>
              </span>
              <Icon name="chevron-down" size={12} />
            </button>
            <PortalMenu anchor={sortBtn} open={sortOpen} onClose={closeSort} align="right" role="listbox" label={tr('Library.sort_builds')} minWidth={190}>
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="option"
                  aria-selected={s.id === settings.librarySort}
                  className="menu-item"
                  onClick={() => {
                    props.onPatchSettings({ librarySort: s.id });
                    setSortOpen(false);
                  }}
                >
                  <span className="grow">{s.label}</span>
                  {s.id === settings.librarySort && <Icon name="check" size={14} style={{ color: 'var(--gold-text)' }} />}
                </button>
              ))}
            </PortalMenu>
          </div>
          <div className="view-toggle" data-lg="tile" role="group" aria-label={tr('Library.view')}>
            <button type="button" title={tr('Library.grid')} aria-label={tr('Library.grid')} aria-pressed={settings.libraryView === 'grid'} onClick={() => props.onPatchSettings({ libraryView: 'grid' })}>
              <Icon name="grid" size={14} />
            </button>
            <button type="button" title={tr('Library.list')} aria-label={tr('Library.list')} aria-pressed={settings.libraryView === 'list'} onClick={() => props.onPatchSettings({ libraryView: 'list' })}>
              <Icon name="list" size={14} />
            </button>
          </div>
          {/* The design's toolbar ends with the view toggle; this menu (Recently deleted) only appears once something is in the trash. The builds folder opens from the path on the Local row. */}
          {listing && listing.trashCount > 0 && (
            <ActionMenu
              title={tr('Library.more_library_actions')}
              className="lib-more"
              trigger={<Icon name="more" size={16} />}
              actions={[
                { label: tr('Library.recently_deleted'), icon: 'trash', meta: listing && listing.trashCount > 0 ? String(listing.trashCount) : undefined, run: props.onOpenTrash },
                { label: tr('Library.open_the_builds_folder'), icon: 'folder-open', run: props.onReveal },
              ]}
            />
          )}
        </div>

        {acct.signedIn && (cloudBuilds.length > 0 || !searching) && (
          <section className="sec acct-cloud" aria-label={tr('Library.cloud_builds')}>
            <div className="sec-head">
              <span className="lbl">{tr('Library.cloud')}</span>
              <span className="crumb">
                {tr('Library.synced_to_view_count_builds', { count: cloudBuilds.length, view: cloudUser(acct.view) })}
              </span>
              <span className="rule" />
            </div>
            {cloudBuilds.length === 0 ? (
              <div className="acct-cloud-empty" data-lg="tile">
                <Icon name="cloud" size={20} />
                <span className="tx">
                  <b>{tr('Library.nothing_in_the_cloud_yet')}</b>
                  <span>{tr('Library.builds_you_sync_appear_here')}</span>
                </span>
                {builds.length > 0 && (
                  <button type="button" className="btn gold sm" onClick={props.onSyncAll}>
                    <Icon name="cloud" size={14} />
                    {tr('Library.sync_all_count_local_builds', { count: builds.length })}
                  </button>
                )}
              </div>
            ) : (
              <div className={settings.libraryView === 'grid' ? 'cards' : 'rows'} {...(settings.libraryView === 'grid' ? {} : { 'data-lg': 'panel', 'data-card': '' })}>
                {cloudBuilds.map((b) => settings.libraryView === 'list' ? (
                  <BuildRow key={b.id} b={b} sel={sel === b.id} showFolder={!!b.folder} sync={acct.statusOf(b.id)} onResolve={() => props.onResolve?.(b)} onSelect={() => setSel(b.id)} onOpen={() => props.onOpen(b)} actions={buildActions(b)} />
                ) : (
                  <BuildCard key={b.id} b={b} sel={sel === b.id} showFolder={!!b.folder} sync={acct.statusOf(b.id)} onResolve={() => props.onResolve?.(b)} onSelect={() => setSel(b.id)} onOpen={() => props.onOpen(b)} actions={buildActions(b)} />
                ))}
              </div>
            )}
          </section>
        )}
        {settings.communityBuilds && !searching && (
          <section className="sec" aria-label={tr('Library.community_builds')}>
            <div className="sec-head">
              <span className="lbl">{tr('Library.community')}</span>
              <span className="crumb">{tr('Library.builds_other_players_published_or')}</span>
              <span className="rule" />
            </div>
            <div className="folders">
              {[['poe.ninja builds', 'https://poe.ninja/builds'], ['pobb.in', 'https://pobb.in/']].map(([label, url]) => (
                <button key={url} type="button" className="folder" onClick={() => void window.pom.app.openExternal(url!)}>
                  <Icon name="external" size={16} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            {props.onOpenCommunity && <CommunityList onOpen={props.onOpenCommunity} onManage={() => props.onManageCommunity?.()} />}
          </section>
        )}
        <section className="sec">
          <div className="sec-head">
            <span className="lbl">{searching ? tr('Library.results') : tr('Library.local')}</span>
            {searching ? (
              <span className="crumb">{tr('Library.count_builds_match', { count: visible.length })} “{query.trim()}”</span>
            ) : (
              <span className="crumb">
                <button type="button" className={'up' + (folder ? ' can' : '')} data-drop={dropOn === '' || undefined} title={folder ? tr('h_rb_Lib.up_to', { name: folderLabel(parentOf(folder)) }) : undefined} onClick={() => folder && setFolder(parentOf(folder))} {...dropProps('')}>
                  {tr('Library.builds')}{crumbs.length ? ' › ' : ''}
                </button>
                {crumbs.map((c, i) => {
                  const path = crumbs.slice(0, i + 1).join('/');
                  const last = i === crumbs.length - 1;
                  return last ? (
                    <b key={path}>{c}</b>
                  ) : (
                    <button key={path} type="button" className="up can" data-drop={dropOn === path || undefined} onClick={() => setFolder(path)} {...dropProps(path)}>
                      {c} ›{' '}
                    </button>
                  );
                })}
              </span>
            )}
            <span className="rule" />
            <button type="button" className="path" title={tr('Library.open_the_builds_folder')} onClick={props.onReveal}>
              {listing ? listing.root.replace(/\\/g, '/') : ''}
            </button>
          </div>

          {!searching && (
            <div className="folders">
              {subfolders.map((f) => (
                <FolderChip key={f.path} f={f} drop={dropOn === f.path} dropProps={dropProps(f.path)} onOpen={() => setFolder(f.path)} onRename={() => props.onRenameFolder(f)} onDelete={() => props.onDeleteFolder(f)} />
              ))}
              <button type="button" className="folder add" onClick={props.onNewFolder}>
                <Icon name="plus" size={14} />
                {tr('Library.new_folder')}
              </button>
            </div>
          )}

          {localBuilds.length === 0 ? (
            <div className="lib-empty-list">
              <b>{searching ? (cloudBuilds.length ? tr('Library.no_local_only_builds_match') : tr('Library.nothing_matches_trim', { query: query.trim() })) : folder ? tr('Library.this_folder_is_empty') : cloudBuilds.length ? tr('Library.every_build_is_in_the') : tr('Library.no_builds_here_yet')}</b>
              <span>{searching ? tr('Library.try_a_class_name_a') : cloudBuilds.length && !folder ? tr('Library.builds_that_only_live_on') : tr('Library.create_a_build_or_import')}</span>
              {props.onLeagueStarts && (
                <button type="button" className="btn sm" onClick={props.onLeagueStarts}>
                  <Icon name="flag" size={14} />
                  {tr('Library.league_starts')}
                </button>
              )}
            </div>
          ) : (
            <div className={settings.libraryView === 'grid' ? 'cards' : 'rows'} {...(settings.libraryView === 'grid' ? {} : { 'data-lg': 'panel', 'data-card': '' })}>
              {localBuilds.map((b) =>
                settings.libraryView === 'grid' ? (
                  <BuildCard key={b.id} b={b} sel={sel === b.id} showFolder={searching} onSelect={() => setSel(b.id)} onOpen={() => props.onOpen(b)} actions={buildActions(b)} />
                ) : (
                  <BuildRow key={b.id} b={b} sel={sel === b.id} showFolder={searching} onSelect={() => setSel(b.id)} onOpen={() => props.onOpen(b)} actions={buildActions(b)} />
                ),
              )}
            </div>
          )}
        </section>
      </div>
      <div className="lib-foot" data-r="bl-foot">
        <span className="sp" />
        <span style={{ color: 'var(--text-muted)' }}>{tr('Library.count_builds', { count: total })}</span>
        <span className="dot" />
        <button type="button" className="link gold" onClick={props.onImport}>
          <Icon name="import" size={15} />
          {tr('Library.import_more')}
        </button>
        <span className="sp" />
      </div>
    </div>
  );
}

function FolderChip({ f, drop, dropProps, onOpen, onRename, onDelete }: { f: FolderEntry; drop: boolean; dropProps: React.HTMLAttributes<HTMLElement>; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
  return (
    <div style={{ position: 'relative', display: 'flex' }} className="folder-wrap" {...dropProps}>
      <button type="button" className="folder" data-drop={drop || undefined} onClick={onOpen} title={tr('Library.open_name', { name: f.name })}>
        <Icon name="folder" size={16} />
        <span>{f.name}</span>
        <span className="n">{tr('Library.count_builds_2', { count: f.count })}</span>
      </button>
      <span className="folder-more">
        <ActionMenu
          title={tr('Library.folder_actions_for_name', { name: f.name })}
          className="btn sm icon ghost"
          trigger={<Icon name="more" size={16} />}
          actions={[
            { label: tr('Library.rename_folder'), icon: 'edit', run: onRename },
            { label: tr('Library.delete_folder'), icon: 'trash', danger: true, run: onDelete },
          ]}
        />
      </span>
    </div>
  );
}

function dragStart(b: BuildEntry) {
  return (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, b.id);
    e.dataTransfer.setData('text/plain', b.name);
    e.dataTransfer.effectAllowed = 'move';
  };
}

function Portrait({ b, size }: { b: BuildEntry; size: 32 | 56 }) {
  const k = classKey(b.info);
  return <span className={'portrait s' + size} style={{ backgroundImage: `url(${classPortrait(k)})`, ['--cls' as string]: `var(--class-${k})` }} />;
}

function cloudUser(v: ReturnType<typeof useAcct>['view']): string {
  const a = v?.auth;
  const email = a && (a.state === 'signedIn' || a.state === 'restoring') ? a.user.email : '';
  const at = email.indexOf('@');
  return at > 0 ? `${email.slice(0, Math.min(at, 8))}@…` : email || tr('Library_2.your_account');
}

function BuildRow({ b, sel, showFolder, sync, onResolve, onSelect, onOpen, actions }: { b: BuildEntry; sel: boolean; showFolder: boolean; sync?: BuildSyncStatus | undefined; onResolve?: () => void; onSelect: () => void; onOpen: () => void; actions: MenuAction[] }) {
  return (
    <div className="row" {...(sel ? { 'data-sel': '', 'data-lg': 'tile' } : {})} data-build-id={b.id} role="button" tabIndex={0} draggable onDragStart={dragStart(b)} onClick={onSelect} onDoubleClick={onOpen}>
      <Portrait b={b} size={32} />
      <span className="name">
        {b.name}
        {showFolder && b.folder && <span style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 10, fontSize: 12.5 }}>{folderLabel(b.folder)}</span>}
        {sync && <SyncBadge status={sync} onResolve={onResolve} inRow />}
      </span>
      <div className="acts">
        <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
          <Icon name="external" size={14} />
          {tr('Library.open')}
        </button>
        <ActionMenu title={tr('Library.copy_rename_move_delete')} trigger={<Icon name="more" size={16} />} actions={actions} />
      </div>
      <span data-r="bl-meta" className={'meta' + (b.info.valid ? '' : ' bad')}>{levelLabel(b.info)}</span>
      <span data-r="bl-date" className="date">{formatWhen(b.mtimeMs)}</span>
    </div>
  );
}

function BuildCard({ b, sel, showFolder, sync, onResolve, onSelect, onOpen, actions }: { b: BuildEntry; sel: boolean; showFolder: boolean; sync?: BuildSyncStatus | undefined; onResolve?: () => void; onSelect: () => void; onOpen: () => void; actions: MenuAction[] }) {
  const hasStats = b.info.dps !== undefined || b.info.life !== undefined;
  return (
    <div className="card" data-lg="tile" {...(sel ? { 'data-sel': '' } : {})} data-build-id={b.id} role="button" tabIndex={0} draggable onDragStart={dragStart(b)} onClick={onOpen} onMouseEnter={onSelect} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); }}>
      <div className="top">
        <Portrait b={b} size={56} />
        <div className="tt">
          <span className="nm">
            {artFor(b.info.mainSkill, 'gems') && <img className="gem" src={artFor(b.info.mainSkill, 'gems')} alt="" aria-hidden="true" />}
            <span className="nmt">{b.name}</span>
          </span>
          <span className={'sub' + (b.info.valid ? '' : ' bad')}>{levelLabel(b.info)}</span>
        </div>
      </div>
      {hasStats ? (
        <div className="stats">
          <span className="st"><span className="k">{tr('Library.dps')}</span><b className="dps" {...(b.info.dps !== undefined ? { title: exactNumber(b.info.dps) } : {})}>{b.info.dps !== undefined ? compactNumber(b.info.dps) : '—'}</b></span>
          <span className="st"><span className="k">{tr('Library.life')}</span><b className="life" {...(b.info.life !== undefined ? { title: exactNumber(b.info.life) } : {})}>{b.info.life !== undefined ? compactNumber(b.info.life) : '—'}</b></span>
          <span className="st"><span className="k">{tr('Library.edited')}</span><span className="v">{formatWhen(b.mtimeMs)}</span></span>
        </div>
      ) : null}
      {(!hasStats || sync || (showFolder && b.folder) || b.info.stamp) && (
        <div className="bot">
          {b.info.stamp && <span className="chip" title={tr('Library.league_start_for_league_game', { league: b.info.stamp.league, patch: b.info.stamp.patch })}>{b.info.stamp.league} {b.info.stamp.patch}</span>}
          {sync && <SyncBadge status={sync} onResolve={onResolve} />}
          {showFolder && b.folder && <span className="chip">{folderLabel(b.folder)}</span>}
          {!hasStats && sync?.status !== 'conflict' && <span className="when">{formatWhen(b.mtimeMs)}</span>}
        </div>
      )}
      <div className="more">
        <ActionMenu title={tr('Library.copy_rename_move_delete')} trigger={<Icon name="more" size={16} />} actions={actions} />
      </div>
    </div>
  );
}
