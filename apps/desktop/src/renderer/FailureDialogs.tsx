// The three dialogs that answer a problem: an update is on offer, the builds folder cannot be used, a save failed.
import { useState } from 'react';
import type { BuildsDirProblem, UpdateOffer } from '../shared/library.js';
import { Dialog } from './ui';
import { plainSaveReason } from './saveReason';
import { fromMain, tr } from './i18n';

const LAYER_LABEL: Record<UpdateOffer['layers'][number]['layer'], string> = { app: 'Application', engine: tr('FailureDialogs.calculation_engine'), interface: 'Interface' };
const shown = (v: string) => (v === 'dev' ? tr('FailureDialogs_2.this_build') : /^\d/.test(v) ? `v${v}` : v);

const tile = { borderRadius: 12, background: 'rgba(var(--shadow-rgb),calc(.3*var(--shadow-k)))', border: '1px solid rgba(var(--line-rgb),.07)', padding: 4, display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 260, overflow: 'auto' } as const;
const mono = { font: "500 12.5px 'Geist Mono'", color: 'var(--text-2)', overflowWrap: 'anywhere' } as const;

/** Update Available: what would change, with the release notes. Update runs the existing update pass; Later keeps things as they are. */
export function UpdateAvailableDialog({ offer, busy, error, onUpdate, onLater }: { offer: UpdateOffer; busy: boolean; error: string | null; onUpdate: () => void; onLater: () => void }) {
  return (
    <Dialog size="medium" width={720} icon="info" title={tr('FailureDialogs.update_available')} cancelLabel={tr('FailureDialogs.later')} confirmLabel={tr('FailureDialogs.update')} confirmIcon="download" confirmBusy={busy} confirmDisabled={busy} onCancel={onLater} onConfirm={onUpdate}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-screen-label="Dialog / Update Available">
        <div style={tile}>
          {offer.layers.map((l) => (
            <div key={l.layer} style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ color: 'var(--gold-text)', font: "600 13px 'Geist Mono'" }}>{shown(l.next)}</span>
                <span style={{ color: 'var(--text-2)' }}>{LAYER_LABEL[l.layer]}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('FailureDialogs.now_current', { current: shown(l.current) })}</span>
              </div>
              {l.notes.map((n, i) => (
                <div key={i} style={{ color: 'var(--text-3)', lineHeight: 1.5, paddingLeft: 12 }}>{n}</div>
              ))}
            </div>
          ))}
        </div>
        {error && <div role="alert" style={{ color: 'var(--neg, #e06c6c)', lineHeight: 1.5 }}>{error}</div>}
      </div>
    </Dialog>
  );
}

/** Change Settings Path, shown at startup when the chosen builds folder cannot be used. A folder is required, so there is no Cancel. */
export function SettingsPathDialog({ problem, defaultPath, onChoose, onDefault }: { problem: BuildsDirProblem; defaultPath: string; onChoose: () => Promise<string | null>; onDefault: () => void }) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const choose = async () => {
    setBusy(true);
    try {
      setPicked(await onChoose());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      size="medium"
      width={640}
      icon="warning"
      title={tr('FailureDialogs.change_settings_path')}
      cancelLabel={null}
      hideClose
      altLabel={tr('FailureDialogs.use_default_folder')}
      altIcon="folder"
      altDisabled={busy}
      confirmLabel={tr('FailureDialogs.choose_folder')}
      confirmIcon="folder"
      confirmBusy={busy}
      confirmDisabled={busy}
      onCancel={() => {}}
      onAlt={onDefault}
      onConfirm={() => void choose()}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-screen-label="Dialog / Change Settings Path">
        <span style={{ color: 'var(--text-3)', lineHeight: 1.55 }}>
          {tr('FailureDialogs.your_builds_folder_cannot_be', { reason: fromMain('ml_io_errors', problem.reason) })}<br />
          {tr('FailureDialogs.current_path')} <span style={mono}>{problem.path}</span><br />
          {tr('FailureDialogs.if_this_location_is_managed')}
        </span>
        <span style={{ ...mono, color: 'var(--text-muted)' }}>{tr('FailureDialogs.until_you_choose_builds_are', { defaultPath })}</span>
        {picked && <span role="status" style={mono}>{tr('FailureDialogs.saved_picked_restarting', { picked })}</span>}
      </div>
    </Dialog>
  );
}

/** Error: failed save. The changes stay open; Retry save saves again, Export recovery file writes them where the
 *  user picks, Save as… picks another place in the library. The reason is plain words; the raw error sits behind Details. */
export function SaveFailedDialog({ path, error, busy, exported, onRetry, onExport, onSaveAs, onDismiss }: { path: string; error: string; busy: boolean; exported: string | null; onRetry: () => void; onExport: () => void; onSaveAs?: () => void; onDismiss: () => void }) {
  return (
    <Dialog icon="warning" title={tr('FailureDialogs.save_failed')} subtitle={tr('FailureDialogs.your_changes_are_still_open')} cancelLabel={tr('FailureDialogs.close')} altLabel={tr('FailureDialogs.export_recovery_file')} altIcon="download" altDisabled={busy} confirmLabel={tr('FailureDialogs.retry_save')} confirmIcon="refresh" confirmBusy={busy} confirmDisabled={busy} onCancel={onDismiss} onAlt={onExport} onConfirm={onRetry}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-screen-label="Dialog / Error">
        <span role="alert" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>{plainSaveReason(error)}</span>
        <span style={mono}>{path}</span>
        {exported && <span role="status" style={{ color: 'var(--text-2)' }}>{tr('FailureDialogs.recovery_file_saved')} <span style={mono}>{exported}</span></span>}
        {onSaveAs && <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={onSaveAs}>{tr('FailureDialogs.save_as')}</button>}
        <details style={{ color: 'var(--text-muted)' }}>
          <summary style={{ cursor: 'pointer' }}>{tr('FailureDialogs.details')}</summary>
          <span style={mono}>{error}</span>
        </details>
      </div>
    </Dialog>
  );
}
