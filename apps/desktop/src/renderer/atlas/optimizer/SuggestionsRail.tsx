import { useState, useSyncExternalStore } from 'react';
import { Switch } from '../../ui.js';
import type { Suggestion } from '../../../shared/atlas/suggestions/rules.js';
import type { RailController } from './railController.js';
import { tr } from '../../i18n';

export type RailEntitlement = { aiAccess: boolean; signedIn: boolean; online: boolean; onUnlock: () => void; onSignIn: () => void; onChooseSustain: () => void; onDetails: (row: Suggestion) => void };
// No lock marker in Atlas; sign-in wording follows the AI gate ("Sign in to use ...").
const aiText = (code: string | null) => code === 'AI_ACCESS_REQUIRED' ? tr('atlas_optimizer_SuggestionsRail.ai_suggestions_are_not_turned') : code === 'SIGN_IN_REQUIRED' ? tr('atlas_optimizer_SuggestionsRail.sign_in_to_use_ai') : code === 'HUMAN_CHECK_REQUIRED' ? tr('atlas_optimizer_SuggestionsRail.network_features_paused_complete_a') : tr('atlas_optimizer_SuggestionsRail.ai_advice_is_unavailable');

/** Rule rows are free. AI is one quiet switch, off until the player turns it on. */
export function SuggestionsRail({ rail, ent, onApplied }: { rail: RailController; ent: RailEntitlement; onApplied?: () => void }) {
  const s = useSyncExternalStore(rail.subscribe, rail.snapshot, rail.snapshot);
  const [expanded, setExpanded] = useState(false), [confirm, setConfirm] = useState(false), [notice, setNotice] = useState('');
  const rows = expanded ? [...s.shown, ...s.more] : s.shown;
  if (!s.open) return <button type="button" className="btn opt-collapsed" onClick={() => rail.setOpen(true)}>{tr('atlas_optimizer_SuggestionsRail.suggestions_count', { count: s.count })}</button>;
  // Success goes to the host's plan-scoped banner (it has Undo and hides on another plan); errors stay here.
  const apply = async (row: Suggestion) => { const err = await rail.apply(row); if (err || !onApplied) setNotice(err ?? tr('atlas_optimizer_SuggestionsRail.applied_ctrl_z_undoes_it')); else { setNotice(''); onApplied(); } };
  const toggleAi = async (on: boolean) => {
    if (on && !ent.aiAccess) { if (!ent.signedIn) ent.onSignIn(); else ent.onUnlock(); return; }
    await rail.setAi(on);
  };
  return <aside className="opt-rail" aria-label={tr('atlas_optimizer_SuggestionsRail.suggestions')} onMouseEnter={() => rail.setHold(true)} onMouseLeave={() => rail.setHold(false)} onKeyDown={e => { if (e.key === 'Escape') rail.closePreview(); }}>
    <header className="opt-head"><h2>{tr('atlas_optimizer_SuggestionsRail.suggestions')}</h2><button type="button" className="btn ghost" aria-label={tr('atlas_optimizer_SuggestionsRail.close_suggestions')} onClick={() => rail.setOpen(false)}>{tr('atlas_optimizer_SuggestionsRail.x')}</button></header>
    {s.warnings.map(w => <p key={w.id} role="alert" className="opt-warning" data-tone={w.tone}>{w.text}</p>)}
    {s.ruleWarning && <p className="opt-note">{s.ruleWarning}</p>}
    {!rows.length && <p>{tr('atlas_optimizer_SuggestionsRail.no_suggestions_for_this_step')}</p>}
    <ul className="opt-chips">{rows.map(row => <li key={row.id} className="opt-chip-row" onMouseEnter={() => void rail.preview(row)} onMouseLeave={() => void rail.preview(null)}
      onFocus={() => void rail.preview(row)} onBlur={() => void rail.preview(null)}
      onKeyDown={e => { if (e.key === 'Delete' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); rail.dismiss(row); } }}>
      <span className="opt-tag" data-origin={row.origin}>{row.origin === 'AI' ? tr('atlas_optimizer_SuggestionsRail.ai') : tr('atlas_optimizer_SuggestionsRail.rule')}</span>
      {row.kind === 'path' ? <button type="button" className="opt-chip-body" onClick={() => void apply(row)} aria-label={tr('atlas_optimizer_SuggestionsRail.text_apply', { text: row.text })}>{row.text}</button>
        : <span className="opt-chip-body info">{row.text}</span>}
      {row.reason && <small className="opt-reason">"{row.reason}" <em>{row.detail}</em></small>}
      <span className="opt-chip-actions">
        {row.kind === 'path' && <button type="button" className="btn" onClick={() => { void rail.preview(row, true); ent.onDetails(row); }}>{tr('atlas_optimizer_SuggestionsRail.details')}</button>}
        {row.action === 'choose-sustain' && <button type="button" className="btn" onClick={ent.onChooseSustain}>{tr('atlas_optimizer_SuggestionsRail.choose_sustain')}</button>}
        <button type="button" className="btn" aria-label={tr('atlas_optimizer_SuggestionsRail.dismiss_suggestion')} onClick={() => rail.dismiss(row)}>{tr('atlas_optimizer_SuggestionsRail.dismiss')}</button></span>
    </li>)}</ul>
    {!expanded && s.more.length > 0 && <button type="button" className="btn" onClick={() => setExpanded(true)}>{tr('atlas_optimizer_SuggestionsRail.show_length_more', { count: s.more.length })}</button>}
    {notice && <p role="status">{notice}</p>}
    <footer className="opt-rail-foot">
      <Switch checked={s.aiOn} label={tr('atlas_optimizer_SuggestionsRail.ai_suggestions')} onChange={on => void toggleAi(on)} />
      {s.aiStatus === 'checking' && <small role="status">{tr('atlas_optimizer_SuggestionsRail.checking_your_account')}</small>}
      {s.aiStatus === 'working' && <small role="status">{tr('atlas_optimizer_SuggestionsRail.updating')}</small>}
      {s.aiStatus === 'offline' && <small>{tr('atlas_optimizer_SuggestionsRail.connect_to_request_ai_suggestions')}</small>}
      {(s.aiStatus === 'denied' || s.aiStatus === 'unavailable') && <small role="alert">{aiText(s.aiCode)}</small>}
      {!s.aiOn && s.aiStatus === 'idle' && !ent.aiAccess && !ent.signedIn && <small>{tr('atlas_optimizer_SuggestionsRail.sign_in_to_use_ai')}</small>}
      {s.dismissedCount > 0 || true ? (confirm
        ? <span className="opt-confirm" role="alertdialog" aria-label={tr('atlas_optimizer_SuggestionsRail.show_dismissed_suggestions_again')}>{tr('atlas_optimizer_SuggestionsRail.show_dismissed_suggestions_again')} <button type="button" className="btn gold" onClick={() => { rail.reset(); setConfirm(false); }}>{tr('atlas_optimizer_SuggestionsRail.show_again')}</button><button type="button" className="btn" onClick={() => setConfirm(false)}>{tr('atlas_optimizer_SuggestionsRail.cancel')}</button></span>
        : <button type="button" className="btn" onClick={() => setConfirm(true)}>{tr('atlas_optimizer_SuggestionsRail.reset_dismissed_suggestions')}</button>) : null}
    </footer>
  </aside>;
}
