// What upstream asks when a build is opened: a tree version it does not know (Unknown Passive Tree Version) and a game
// version other than the live one (Game Version, with Convert and Cancel). Cancel and OK close the build, as upstream does.
import { useEffect, useState } from 'react';
import { gateFor, LIVE_TARGET_VERSION, type Gate } from '../shared/buildGates';
import { setBuildAttr } from './buildSkills';
import type { EngineBuild } from './engineBuild';
import { loadVersionEntries } from './treeKinds';
import { Dialog, useToast } from './ui';
import { tr } from './i18n';

const LATEST_DISPLAY = '3.29';

export function BuildOpenGates({ buildId, xml, eng, onClose }: { buildId: string; xml: string; eng: EngineBuild; onClose: () => void }) {
  const toast = useToast();
  const [gate, setGate] = useState<Gate>(null);
  const [busy, setBusy] = useState(false);
  // Asked once when the build opens (the text changes after that as the player edits).
  useEffect(() => {
    let live = true;
    void loadVersionEntries().then((v) => {
      if (live && v.length) setGate(gateFor(xml, v.map((x) => x.value)));
    });
    return () => {
      live = false;
    };
  }, [buildId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (gate === 'unknown-tree') {
    return (
      <Dialog icon="warning" title={tr('BuildOpenGates.unknown_passive_tree_version')} confirmLabel={tr('BuildOpenGates.ok')} cancelLabel={null} onCancel={onClose} onConfirm={onClose}>
        <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.5 }} data-screen-label="Dialog / Unknown Passive Tree Version">
          {tr('BuildOpenGates.the_build_you_are_trying')}
          <br />{tr('BuildOpenGates.you_may_need_to_update')}
        </p>
      </Dialog>
    );
  }
  if (gate === 'game-version') {
    return (
      <Dialog
        size="medium"
        icon="warning"
        title={tr('BuildOpenGates.game_version')}
        confirmLabel={tr('BuildOpenGates.convert_to_latest_display', { LATEST_DISPLAY })}
        confirmBusy={busy}
        onCancel={onClose}
        onConfirm={async () => {
          setBusy(true);
          try {
            await eng.editXml((x) => setBuildAttr(x, 'targetVersion', LIVE_TARGET_VERSION), true);
            setGate(null);
          } catch (e) {
            setBusy(false);
            toast({ text: tr('BuildOpenGates.converting_the_build_did_not', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
          }
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--text)', lineHeight: 1.5 }} data-screen-label="Dialog / Game Version">
          <p style={{ margin: 0 }}>
            <b style={{ color: 'var(--gold-text)' }}>{tr('BuildOpenGates.info')}</b> {tr('BuildOpenGates.you_are_trying_to_load')}
          </p>
          <p style={{ margin: 0 }}>
            <b style={{ color: 'var(--warning-text)' }}>{tr('BuildOpenGates.warning')}</b> {tr('BuildOpenGates.converting_a_build_to_a')}
          </p>
        </div>
      </Dialog>
    );
  }
  return null;
}
