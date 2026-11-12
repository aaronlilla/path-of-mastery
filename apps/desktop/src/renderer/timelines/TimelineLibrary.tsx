import { useMemo, useRef, useState } from 'react';
import { Segmented } from '../ui';
import { ItemCard } from '../documents/ItemCard';
import { rangeLabel } from '../../shared/timelines/editor/model.js';
import type { TimelineLibraryProps } from './types.js';
import { useAreaFind } from './useAreaFind';

export function TimelineLibrary(props: TimelineLibraryProps) {
  const [query, setQuery] = useState(''), [sort, setSort] = useState('edited'), [view, setView] = useState('grid'), [tab, setTab] = useState('mine'), [archive, setArchive] = useState(false), [dismissed, setDismissed] = useState(props.starterDismissed ?? false);
  const search = useRef<HTMLInputElement>(null), root = useRef<HTMLElement>(null);
  useAreaFind(root, () => search.current?.focus());
  const rows = useMemo(() => props.rows.filter(row => (archive ? !row.activeLeague : tab === 'old' ? !row.activeLeague : tab === 'saved' ? row.saved : row.activeLeague && !row.saved) &&
    row.timeline.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => sort === 'name' ? a.timeline.title.localeCompare(b.timeline.title) : sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.card.updatedAt.localeCompare(a.card.updatedAt)), [props.rows, query, sort, tab, archive]);
  return <section ref={root} className="timelines-area" onKeyDown={event => {
    const target = event.target as HTMLElement;
    if (target.matches('input,textarea,select,[contenteditable="true"]')) return;
    if (event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); }
    if (event.ctrlKey && event.key.toLowerCase() === 'i') { event.preventDefault(); props.onImport(); }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); props.onNew(); }
    const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.mastery-card-open')], index = cards.indexOf(target as HTMLButtonElement);
    if (index >= 0 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); cards[(index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + cards.length) % cards.length]?.focus(); }
    if (index >= 0 && ['F2', 'Delete'].includes(event.key)) { event.preventDefault(); props.onAction(rows[index]!, event.key === 'F2' ? 'rename' : 'delete'); }
  }}>
    <header className="timeline-header">{archive ? <div><span className="eyebrow">Old leagues</span><h1>Archive</h1></div> : <h1>Timelines</h1>}<div>{archive ? <button className="btn" onClick={() => setArchive(false)}>Current league</button> : <button className="btn" onClick={() => { setArchive(true); props.onArchive(); }}>Archive</button>}<button className="btn" onClick={props.onImport}>Import</button><button className="btn primary" onClick={props.onNew}>New timeline</button></div></header>
    {!archive && <Segmented value={tab} onChange={setTab} options={[{ value: 'mine', label: 'My timelines' }, { value: 'saved', label: 'Saved' }, { value: 'old', label: 'Old leagues' }]} ariaLabel="Timeline library" />}
    <div className="timeline-toolbar"><input ref={search} className="field" aria-label="Search timelines..." placeholder="Search timelines..." value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="Sort timelines" value={sort} onChange={event => setSort(event.target.value)}><option value="edited">Last edited</option><option value="name">Name</option><option value="created">Created</option></select>
      <Segmented value={view} onChange={setView} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]} ariaLabel="Timeline view" /></div>
    {props.state === 'offline' && <p role="status">Offline. Local changes are saved on this PC.</p>}
    {props.state === 'loading' && <p role="status">Updating...</p>}
    {props.state === 'error' && <p role="alert">Could not load timelines. <button className="btn" onClick={props.onRetry}>Retry</button></p>}
    {!rows.length && props.state !== 'loading' && <p>{archive ? 'No archived timelines. Timelines from old leagues appear here.' : 'No timelines yet.'}</p>}
    {!rows.length && props.state === 'loading' && <div className="timeline-card-list" aria-busy="true"><div className="timeline-card-skeleton" /><div className="timeline-card-skeleton" /></div>}
    <div className="timeline-card-list" data-view={view}>{rows.map(row => <div key={row.id}>
      <ItemCard item={row.card} view={view as 'grid' | 'list'} onOpen={() => props.onOpen(row)} onAction={action => props.onAction(row, action)} menuActions={['duplicate', 'rename', 'share', 'publish', 'delete']} primary={{ label: row.resume ? 'Resume' : 'Run', run: () => props.onRun(row) }} />
      <span>{row.timeline.lanes.length} lanes / {rangeLabel(row.timeline.clips.length ? { start: Math.min(...row.timeline.clips.map(clip => clip.range.start)), endExclusive: Math.max(...row.timeline.clips.map(clip => clip.range.endExclusive)) } : { start: 1, endExclusive: 101 })}</span>
      {row.resume && <p className="timeline-resume">Resume {row.timeline.title}{row.resumeAt ? ` at ${row.resumeAt}` : ''}</p>}
      {row.runVersion && row.editedVersion && row.runVersion !== row.editedVersion && <p>Run version {row.runVersion}; edited version {row.editedVersion} available</p>}
    </div>)}</div>
    {!dismissed && !archive && <div className="timeline-starter"><button className="btn primary" onClick={props.onStarter}>Pick a league start</button><button className="btn" onClick={() => { setDismissed(true); props.onDismissStarter?.(); }}>Dismiss</button></div>}
    <button className="btn" onClick={props.onTrash}>Recently deleted</button>
  </section>;
}
