import { useEffect, useRef, useState } from 'react';
import { dataLabel } from '../canvas/model.js';
import { Dialog, Select } from '../../ui.js';
import type { AtlasEditorSession } from './session.js';
import { fromMain, tr } from '../../i18n';

export function EditHistory({ session, close }: { session: AtlasEditorSession; close: () => void }) {
  const { record, preview } = session.state, events = record!.history.events;
  const [index, setIndex] = useState(-1), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState('1x'), [scroll, setScroll] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const first = Math.max(0, Math.floor(scroll / 64) - 2), visible = events.slice(first, first + 12);
  const choose = (i: number) => { if (!events[i]) return; setIndex(i); void session.preview(events[i]!.transactionId); };
  const returnCurrent = () => { setPlaying(false); setIndex(-1); session.returnCurrent(); };
  useEffect(() => () => session.returnCurrent(), [session]);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => { const next = index + 1; if (next >= events.length) setPlaying(false); else choose(next); }, speed === '4x' ? 250 : 1000);
    return () => clearTimeout(timer);
  }, [playing, index, speed, events.length]);
  return <Dialog title={tr('atlas_editor_EditHistory.edit_history')} size="large" onCancel={() => { if (preview) returnCurrent(); else close(); }} cancelLabel={tr('atlas_editor_EditHistory.close')} confirmLabel={tr('atlas_editor_EditHistory.restore_this_revision')} confirmDisabled={!preview || preview.source.revisionId === record!.source.revisionId || record!.ownership !== 'owned'} onConfirm={async () => { setPlaying(false); await session.restorePreview(); setIndex(-1); }}>
    <div className="atlas-row-actions"><button type="button" className="btn" disabled={!session.canUndo || !!preview || record!.ownership !== 'owned'} onClick={() => void session.historyAction('undo')}>{tr('atlas_editor_EditHistory.undo')}</button><button type="button" className="btn" disabled={!session.canRedo || !!preview || record!.ownership !== 'owned'} onClick={() => void session.historyAction('redo')}>{tr('atlas_editor_EditHistory.redo')}</button><span>{tr('atlas_editor_EditHistory.current_version')}{(() => { const at = events.findIndex(e => e.transactionId === record!.history.cursor); return at >= 0 ? tr('atlas_editor_EditHistory_2.edit_of', { at: at + 1, events: events.length }) : ''; })()}</span></div>
    {!events.length && <p>{record!.ownership === 'saved' ? tr('atlas_editor_EditHistory.this_creator_did_not_include') : tr('atlas_editor_EditHistory.no_edit_history_is_available')}</p>}
    <div ref={list} className="atlas-history-list" tabIndex={0} role="listbox" aria-label={tr('atlas_editor_EditHistory.edit_transactions')} onScroll={e => setScroll(e.currentTarget.scrollTop)} onKeyDown={e => {
      const next = e.key === 'ArrowDown' ? Math.min(events.length - 1, index + 1) : e.key === 'ArrowUp' ? Math.max(0, index - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? events.length - 1 : null;
      if (next !== null) { e.preventDefault(); choose(next); list.current?.scrollTo({ top: next * 64 }); }
    }}><div style={{ height: first * 64 }} />{visible.map((event, i) => <button type="button" className="atlas-history-event" key={event.transactionId} role="option" aria-selected={index === first + i} aria-posinset={first + i + 1} aria-setsize={events.length} onClick={() => { setPlaying(false); choose(first + i); }}>
      <time dateTime={event.createdAt}>{Number.isNaN(Date.parse(event.createdAt)) ? event.createdAt : new Date(event.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</time><span>{fromMain('ml_atlas_history', event.label)}</span>{event.transactionId === record!.history.cursor && <small>{tr('atlas_editor_EditHistory.current')}</small>}{event.branchId !== events.find(e => e.transactionId === record!.history.tip)?.branchId && <small>{tr('atlas_editor_EditHistory.other_branches')}</small>}
    </button>)}<div style={{ height: Math.max(0, events.length - first - visible.length) * 64 }} /></div>
    <div className="atlas-replay" aria-label={tr('atlas_editor_EditHistory.replay')} onKeyDown={e => { if (e.key === ' ' && e.target instanceof HTMLInputElement) { e.preventDefault(); setPlaying(v => !v); } }}><span>{tr('atlas_editor_EditHistory.replay')}</span>
      <button type="button" className="btn" disabled={!events.length} aria-label={tr('atlas_editor_EditHistory.first_edit')} onClick={() => { setPlaying(false); choose(0); }}>|&lt;</button>
      <button type="button" className="btn" disabled={!events.length} onClick={() => { if (index >= events.length - 1) setIndex(-1); setPlaying(v => !v); }}>{playing ? tr('atlas_editor_EditHistory.pause') : tr('atlas_editor_EditHistory.play')}</button>
      <input type="range" aria-label={tr('atlas_editor_EditHistory.replay_transaction')} min="0" max={Math.max(0, events.length - 1)} value={Math.max(0, index)} disabled={!events.length} onChange={e => { setPlaying(false); choose(Number(e.target.value)); }} /><span>{tr('atlas_editor_EditHistory.index_of_length', { index: index < 0 ? '–' : index + 1, count: events.length })}</span>
      <Select width={80} ariaLabel={tr('atlas_editor_EditHistory.replay_speed')} value={speed} onChange={setSpeed} options={['1x', '4x'].map(value => ({ value, label: value }))} />
    </div>
    {preview && <><p>{tr('atlas_editor_EditHistory.preview_only_your_current_plan')}</p><p>{tr('atlas_editor_EditHistory.source_data_datasetid', { datasetId: dataLabel(preview.view.document.payload.dataset.datasetId) })}</p><button type="button" className="btn" onClick={returnCurrent}>{tr('atlas_editor_EditHistory.return_to_current')}</button></>}
    {session.state.error && <p role="alert">{fromMain('ml_atlas_errors', session.state.error)}<button type="button" className="btn" onClick={() => { if (index >= 0) choose(index); }}>{tr('atlas_editor_EditHistory.retry')}</button></p>}
  </Dialog>;
}
