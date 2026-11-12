import { useMemo, useState } from 'react';
import { Segmented } from '../ui';
import { ItemArt } from '../documents/ItemCard';
import { knownLabel } from '../documents/model.js';
import type { TimelineSourceRow } from './types.js';

export function ClipLibrary({ sources, onAdd, onBrowse, onNewNote, onClose, onAddTimeline }: {
  sources: TimelineSourceRow[]; onAdd(row: TimelineSourceRow): void; onBrowse?(kind: string): void;
  onNewNote(): void; onClose(): void; onAddTimeline?: () => void;
}) {
  const [ownership, setOwnership] = useState('own'), [kind, setKind] = useState('build'), [query, setQuery] = useState('');
  const rows = useMemo(() => sources.filter(row => row.ownership === ownership && row.source.fallbackSnapshot.kind === kind &&
    row.source.fallbackSnapshot.payload.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [sources, ownership, kind, query]);
  return <aside className="timeline-library-panel" aria-label="Library">
    <header><h2>Library</h2><button className="icon-btn" onClick={onClose} aria-label="Close Library">×</button></header>
    <Segmented value={ownership} onChange={setOwnership} options={[{ value: 'own', label: 'Own' }, { value: 'saved', label: 'Saved' }]} ariaLabel="Clip ownership" />
    <Segmented value={kind} onChange={setKind} options={[{ value: 'build', label: 'Builds' }, { value: 'atlas', label: 'Atlas' }, { value: 'filter', label: 'Filters' }, { value: 'notes', label: 'Notes' }]} ariaLabel="Clip type" />
    <input className="field" aria-label="Search clips..." placeholder="Search clips..." value={query} onChange={event => setQuery(event.target.value)} />
    {!rows.length && <p>{ownership === 'saved' ? 'Save an item from Marketplace to use it here.' : `No ${kind === 'filter' ? 'filters' : kind === 'atlas' ? 'atlas plans' : kind === 'build' ? 'builds' : 'notes'} saved yet.`}</p>}
    <div className="timeline-source-list">{rows.map(row => <article key={row.id} className="timeline-source-row">
      <span className="timeline-source-title"><ItemArt art={{ name: row.source.fallbackSnapshot.payload.title, src: row.art }} /><strong>{row.source.fallbackSnapshot.payload.title}</strong></span>
      <span>{knownLabel(row.source.ref.stamp.leagueId)} / Version {row.revisionLabel}</span><span>{row.stages} available stages{row.archived ? ' / Archived' : ''}</span>
      {!row.cached && <span>Download needed</span>}
      {row.guideAvailable === false && <p>No progression guide. Add as a snapshot or open build to create one.</p>}
      <div><button className="btn" draggable={row.cached} onDragStart={event => { event.dataTransfer.setData('application/x-pom-timeline-source', row.id); event.dataTransfer.effectAllowed = 'copy'; }} aria-label={`Drag ${row.source.fallbackSnapshot.payload.title}`} disabled={!row.cached}>Drag handle</button>
        <button className="btn" disabled={!row.cached} onClick={() => onAdd(row)}>Add to lane</button></div>
    </article>)}</div>
    {kind === 'notes' && <button className="btn" onClick={onNewNote}>New note</button>}
    {ownership === 'saved' && onAddTimeline && <button className="btn" onClick={onAddTimeline}>Add lanes from timeline</button>}
    {onBrowse && <button className="btn" onClick={() => onBrowse(kind)}>Browse Marketplace</button>}
  </aside>;
}
