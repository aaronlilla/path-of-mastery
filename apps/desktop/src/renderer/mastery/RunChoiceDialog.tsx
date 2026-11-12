// Starting a Marketplace Run while another Run is open: the app's own dialog asks Replace or Resume (it used window.confirm).
import { useEffect, useState } from 'react';
import { Dialog } from '../ui';
import { tr } from '../i18n';

type Choice = 'replace' | 'keep' | null;
type Listener = (open: boolean) => void;
let resolver: ((choice: Choice) => void) | null = null;
const listeners = new Set<Listener>();
export const runChoice = {
  /** Resolves 'replace', 'keep' (leave the open Run alone), or null when the person closes the dialog. */
  ask(): Promise<Choice> {
    resolver?.(null);
    return new Promise<Choice>(resolve => { resolver = resolve; for (const l of listeners) l(true); });
  },
  finish(choice: Choice): void {
    const r = resolver; resolver = null;
    for (const l of listeners) l(false);
    r?.(choice);
  },
  subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
};

export function RunChoiceHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => runChoice.subscribe(setOpen), []);
  if (!open) return null;
  return <Dialog title={tr('mastery_RunChoiceDialog.a_run_is_already_open')} subtitle={tr('mastery_RunChoiceDialog.only_one_run_can_be_open')} icon="sync" size="small"
    confirmLabel={tr('mastery_RunChoiceDialog.replace_with_this_timeline')} altLabel={tr('mastery_RunChoiceDialog.keep_current_run')} cancelLabel="Cancel"
    onConfirm={() => runChoice.finish('replace')} onAlt={() => runChoice.finish('keep')} onCancel={() => runChoice.finish(null)}>
    <p>{tr('mastery_RunChoiceDialog.replace_saves_your_progress_in_the')}</p>
  </Dialog>;
}
