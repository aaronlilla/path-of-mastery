import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AtlasAiPort } from '../../../shared/atlas/suggestions/ai.js';
import type { LedgerStorage } from '../../../shared/atlas/suggestions/ledger.js';
import type { SustainGroups } from '../../../shared/atlas/suggestions/mechanics.js';
import type { Proposal } from '../../../shared/atlas/suggestions/proposal.js';
import type { ArtResolver } from '../canvas/art.js';
import type { EditorArt } from '../editor/PracticalPanel.js';
import type { AtlasEditorSession } from '../editor/session.js';
import { OptimizerController, type OptimizerPort } from './controller.js';
import { RailController } from './railController.js';
import { OptimizerPanel } from './OptimizerPanel.js';
import { ResultActions, ResultPreview } from './ResultPreview.js';
import type { TreePreview } from '../AtlasArea.js';
import { SuggestionsRail } from './SuggestionsRail.js';
import { PlanWithAi } from './PlanWithAi.js';
import { nextToast, stepKey, untouched, type Toast } from './banner.js';
import './optimizer.css';
import { tr } from '../../i18n';

export type OptimizerEnv = {
  session: AtlasEditorSession; port: OptimizerPort; ai: AtlasAiPort | null; ledger: LedgerStorage | null;
  names?: Record<string, string>; sustain?: SustainGroups | null; art?: EditorArt; nodeArt?: ArtResolver;
  aiAccess: boolean; signedIn: boolean; online: boolean;
  /** Unlock and sign-in belong to the shell. */
  onUnlock: () => void; onSignIn: () => void;
};
type Mode = 'closed' | 'optimize' | 'wizard';

/**
 * Props for AtlasArea. Spread the result into AtlasArea's props:
 * `<AtlasArea {...baseProps} onOptimizer={o.onOptimizer} onPlanWithAi={o.onPlanWithAi} suggestions={o.suggestions} optimizer={o.optimizer} />`
 */
/** An "Applied ... Undo" banner belongs to one plan step and one history entry: `cursor` is the plan's history cursor when the
 * change was made, `applied` the entry the change created once it is saved, `plan` the exact plan object the session held at
 * that moment. It shows only on that step while nothing has changed since: any later edit (even unsaved text still waiting to
 * be saved) replaces the plan object or starts a save, and the banner goes away, so its Undo can never undo something else.
 * `undo: false` is a plain notice (no Undo button). */

export function useAtlasOptimizer(env: OptimizerEnv) {
  const [mode, setMode] = useState<Mode>('closed'), [wizardResult, setWizardResult] = useState(false), [view, setView] = useState<'list' | 'warm'>('list'), [result, setResult] = useState(false), [toast, setToastState] = useState<Toast | null>(null);
  const session = useSyncExternalStore(env.session.subscribe, env.session.snapshot, env.session.snapshot);
  // Called right after the change is handed to the session; its save normally is still in flight. If the save already
  // finished, the current entry is the change itself.
  const setToast = (text: string, undo = true) => {
    const s = env.session.state, cursor = s.record?.history.cursor ?? null, done = s.save === 'saved';
    // plan: the plan right after the change (edit() updates it at once); while its save is pending, any newer edit,
    // typing included, replaces this object.
    setToastState(text ? { text, key: stepKey(s), cursor, applied: done ? cursor : null, plan: s.plan, undo } : null);
  };
  useEffect(() => { if (toast) { const next = nextToast(session, toast); if (next !== toast) setToastState(next); } }, [session, toast]);
  // The banner's Undo re-checks the live session at click time and undoes only its own entry.
  const undoApplied = (t: Toast) => { setToastState(null); if (untouched(env.session.state, t)) void built.c.undo(); };
  const refs = useRef<{ c: OptimizerController; r: RailController } | null>(null);
  const built = useMemo(() => {
    refs.current?.r.dispose(); refs.current?.c.dispose();
    const c = new OptimizerController({ session: env.session, port: env.port, ...(env.names ? { names: env.names } : {}), sustain: env.sustain ?? null });
    const r = new RailController({ controller: c, ai: env.ai, storage: env.ledger, online: () => env.online });
    refs.current = { c, r }; return refs.current;
  }, [env.session, env.port, env.ai, env.ledger, env.names, env.sustain]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { refs.current?.r.dispose(); refs.current?.c.dispose(); }, []);
  const rail = useSyncExternalStore(built.r.subscribe, built.r.snapshot, built.r.snapshot);
  const opt = useSyncExternalStore(built.c.subscribe, built.c.snapshot, built.c.snapshot);
  useEffect(() => { if (opt.proposal && opt.status !== 'idle') setResult(true); }, [opt.proposal, opt.status]);
  const open = (m: Mode) => { setMode(m); setResult(false); setWizardResult(false); built.c.discard(); };
  // The open result: the optimizer's (result panel open), or a pinned/hovered suggestion. It previews as a ghost on the
  // main tree, its explanation sits at the top of the side column and its Apply bar stays pinned at the column's bottom.
  const showResult = mode === 'optimize' && result && !!opt.proposal;
  const resultProps = { controller: built.c, nodeArt: env.nodeArt, onChangeBudget: () => { setResult(false); document.getElementById('opt-budget')?.focus(); },
    onBack: () => setResult(false), onApplied: (text: string) => setToast(text) };
  const railProps = { controller: built.c, proposal: rail.active, nodeArt: env.nodeArt, onChangeBudget: () => undefined, onBack: () => built.r.closePreview(), extraActions: false,
    onApplied: (text: string) => { built.r.closePreview(); setToast(text); } }; // applied: the suggestion's preview is done
  // A result belongs to the plan and step it was computed for: on any other plan or step (Save as copy keeps step ids)
  // it is neither drawn nor offered for Apply.
  const ours = (p: Proposal | null | undefined): p is Proposal => !!p && p.contract.baseRevision.objectId === session.record?.source.objectId && p.stepId === session.selected;
  const candidate = showResult ? opt.proposal : mode === 'closed' ? rail.active : mode === 'wizard' ? opt.proposal : null;
  const shown = ours(candidate) ? candidate : null;
  useEffect(() => { if (rail.active && !ours(rail.active)) built.r.closePreview(); }); // a pinned suggestion does not follow to another plan or step
  const treePreview: TreePreview | null = shown ? { objectId: shown.contract.baseRevision.objectId, stepId: shown.stepId, baseIds: shown.baseAllocatedIds, afterIds: shown.afterIds,
    onDiscard: () => { if (shown === rail.active) built.r.closePreview(); else { built.c.discard(); setResult(false); } } } : null;
  const wizardProps = { controller: built.c, nodeArt: env.nodeArt, onChangeBudget: () => setWizardResult(false), onBack: () => setWizardResult(false), extraActions: false,
    onApplied: (text: string) => { setWizardResult(false); setToast(text); } };
  const sideFooter: ReactNode = !shown ? null : showResult ? <ResultActions {...resultProps} /> : mode === 'wizard' && wizardResult ? <ResultActions {...wizardProps} /> : mode === 'closed' && rail.pinned ? <ResultActions {...railProps} /> : null; // a hover preview has no Apply bar: the chip itself applies
  const node: ReactNode = <div className="opt-area">
    {toast && stepKey(session) === toast.key && <p role="status" className="opt-toast">{toast.text}{toast.undo && <> <button type="button" className="btn" disabled={!untouched(session, toast)} onClick={() => undoApplied(toast)}>{tr('atlas_optimizer_OptimizerArea.undo')}</button></>}</p>}
    <div className="opt-main">
      {mode === 'optimize' && <div className="opt-stack">
        {showResult && <ResultPreview {...resultProps} />}
        <OptimizerPanel controller={built.c} art={env.art} online={env.online} view={view} onView={setView} onWarmCold={() => setView('warm')} onClose={() => { built.c.cancel(); setMode('closed'); setResult(false); }} />
      </div>}
      {mode === 'wizard' && <PlanWithAi controller={built.c} ai={env.ai} aiAccess={env.aiAccess} signedIn={env.signedIn} online={env.online} art={env.art} nodeArt={env.nodeArt} onUnlock={env.onUnlock} onSignIn={env.onSignIn}
        onFreeOptimizer={() => open('optimize')} onClose={() => setMode('closed')} onDone={text => setToast(text, false)} result={wizardResult} onResult={setWizardResult} />}
      {mode === 'closed' && ours(rail.active) && <ResultPreview {...railProps} />}
      {mode !== 'wizard' && <SuggestionsRail rail={built.r} ent={{ aiAccess: env.aiAccess, signedIn: env.signedIn, online: env.online, onUnlock: env.onUnlock, onSignIn: env.onSignIn, onChooseSustain: () => open('optimize'), onDetails: () => undefined }} onApplied={() => setToast(tr('atlas_optimizer_OptimizerArea.applied_the_suggestion_to_your'))} />}
    </div>
  </div>;
  return {
    controller: built.c, rail: built.r,
    onOptimizer: () => open('optimize'),
    onPlanWithAi: () => open('wizard'),
    suggestions: { count: rail.count, isOpen: rail.open, open: () => { built.r.setOpen(true); } },
    optimizer: node, treePreview, sideFooter,
    /** Optimize mechanics or Plan with AI is open (the rail alone does not count). */
    panelOpen: mode !== 'closed',
  };
}
