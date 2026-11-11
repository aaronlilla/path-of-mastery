// The next-league preview's controls in the build workspace (look A): the "3.29 live | 3.30 preview" switch by the tab
// row with its popover, and the "3.30 PREVIEW" tag by the build name.
import { useRef, useState } from 'react';
import { PortalMenu } from '../ui';
import { noteText, usePreview } from './preview';
import type { PreviewNote } from '../../shared/preview.js';
import './preview.css';
import { tr } from '../i18n';

function ago(iso: string | null): string {
  if (!iso) return tr('preview_PreviewControls.at_an_unknown_time');
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return tr('preview_PreviewControls.at_an_unknown_time');
  if (s < 3600) return tr('preview_PreviewControls.min_ago', { s: Math.max(1, Math.round(s / 60)) });
  if (s < 86400) return tr('preview_PreviewControls.h_ago', { s: Math.round(s / 3600) });
  const d = Math.round(s / 86400);
  return d === 1 ? tr('preview_PreviewControls.t_1_day_ago') : tr('preview_PreviewControls.days_ago', { d: d });
}

export function PreviewTag() {
  const pv = usePreview();
  if (!pv.on) return null;
  return <span className="pv-tag" title={tr('preview_PreviewControls.numbers_use_ggg_s_patch_notes', { next: pv.next })}>{pv.next}  {tr('preview_PreviewControls.preview')}</span>;
}

export function PreviewSwitch() {
  const pv = usePreview();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  if (!pv.info) return null;
  return (
    <>
      <div className="pv-switch" ref={anchor} role="group" aria-label={tr('preview_PreviewControls.patch_data')}>
        <span className="cap">{tr('preview_PreviewControls.patch_data')}</span>
        <span className="seg">
          <button type="button" aria-pressed={!pv.on} onClick={() => { pv.setOn(false); setOpen(false); }}>{pv.live}  {tr('preview_PreviewControls.live')}</button>
          <button type="button" aria-pressed={pv.on} onClick={() => { pv.setOn(true); setOpen(true); }}>{pv.next}  {tr('preview_PreviewControls.preview_2')}</button>
        </span>
      </div>
      <PortalMenu anchor={anchor} open={open && pv.on} onClose={() => setOpen(false)} label={tr('preview_PreviewControls.patch_data')} role="dialog" minWidth={300} className="pv-pop">
        <div className="pv-pop-body">
          <b>{tr('preview_PreviewControls.patch_data')}</b>
          <p>{tr('h_c_Pv.numbers_use', { next: pv.next, live: pv.live })}</p>
          <div className="row">
            <span className="when" title={pv.info.checkedAt ?? ''}>{tr('preview_PreviewControls.notes_checked')} {ago(pv.info.checkedAt)}</span>
            <button type="button" className="btn sm" onClick={() => { pv.setOn(false); setOpen(false); }}>{tr('preview_PreviewControls.turn_off_preview')}</button>
          </div>
        </div>
      </PortalMenu>
    </>
  );
}

/** The note block under a changed gem's or unique's tooltip: the patch-note lines behind the change. */
export function PvNoteBox({ notes }: { notes: PreviewNote[] }) {
  const pv = usePreview();
  if (!pv.info) return null;
  const info = pv.info;
  return (
    <div className="pv-note" style={{ borderTop: 0, marginTop: 0, paddingTop: 2 }}>
      <span className="tag">{pv.next}  {tr('preview_PreviewControls.note')}</span>
      {notes.map((n, i) => <span key={i} className="ln">{noteText(info, n)}</span>)}
    </div>
  );
}
