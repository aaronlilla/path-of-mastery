import { useState } from 'react';
import type { AssetRef } from '@pom/mastery-contracts';
import { Dialog, Segmented } from '../../ui.js';
import { ItemArt } from '../../documents/ItemCard.js';
import type { EditorArt } from '../editor/PracticalPanel.js';
import { MAP_SUPPORT_TEXT, type MapSupport } from '../../../shared/atlas/quickPlan.js';
import type { QuickRequest } from './quickBuild.js';
import './quick.css';
import { fromMain, tr } from '../../i18n';

/** `icons`: the mechanic's notables that carry art, in order; the tile shows the first one whose sprite resolves. */
export type QuickMechanic = { targetId: string; name: string; icons: { nodeId: string; asset: AssetRef }[] };

/** The plan name from the picks, until the player types their own. */
export function quickName(names: readonly string[]): string {
  if (!names.length) return tr('atlas_quick_QuickPlan.atlas_plan');
  if (names.length <= 2) return names.join(' + ');
  return tr('atlas_quick_QuickPlan.join_length_more', { names: names.slice(0, 2).join(' + '), value: names.length - 2 });
}

/**
 * New plan, in one screen: pick mechanics (in order), map support and points, then Build tree makes a named plan with
 * the whole tree filled. Blank tree makes the same named plan with no points spent; the link opens tree link import.
 * Quick plan builds on the active tree data; when there is more than one to choose from, "Choose tree data" opens the
 * original new-plan screen that asks which one.
 */
export function QuickPlan({ showMechanics = true, mechanics, maximum, art, busy, error, onBuild, onBlank, onImport, onChooseData, onCancel }: {
  /** False while the mechanic optimizer is switched off (shared/leagueContent.ts): no Mechanics field; map support and fill stay. */
  showMechanics?: boolean; mechanics: QuickMechanic[]; maximum: number; art?: EditorArt; busy: boolean; error: string;
  onBuild: (req: QuickRequest) => void; onBlank: (name: string, points: number) => void; onImport: () => void; onChooseData?: () => void; onCancel: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]), [support, setSupport] = useState<MapSupport>('some'), [fill, setFill] = useState(true);
  const [ownName, setOwnName] = useState<string | null>(null), [pointsText, setPointsText] = useState(String(maximum || ''));
  const byId = new Map(mechanics.map(m => [m.targetId, m] as const));
  const pickedNames = picked.map(id => byId.get(id)?.name ?? id);
  const name = ownName ?? quickName(pickedNames);
  const points = Number(pointsText), pointsOk = pointsText.trim() !== '' && Number.isSafeInteger(points) && points >= 1 && (!maximum || points <= maximum);
  const nameOk = name.trim().length > 0 && [...name].length <= 120;
  const toggle = (id: string) => setPicked(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id]);
  const build = () => { if (pointsOk && nameOk && !busy) onBuild({ name: name.trim(), mechanicIds: picked, mechanicNames: pickedNames, support, points, fill }); };
  return <Dialog title={tr('atlas_quick_QuickPlan.new_atlas_plan')} size="large" onCancel={onCancel} confirmLabel={busy ? tr('atlas_quick_QuickPlan.building') : tr('atlas_quick_QuickPlan.build_tree')} confirmDisabled={!pointsOk || !nameOk || busy} confirmBusy={busy} onConfirm={build}
    altLabel={tr('atlas_quick_QuickPlan.blank_tree')} altDisabled={!pointsOk || !nameOk || busy} onAlt={() => onBlank(name.trim(), points)}
    note={<><button type="button" className="btn ghost quick-import" disabled={busy} onClick={onImport}>{tr('atlas_quick_QuickPlan.import_a_tree_link')}</button>
      {onChooseData && <button type="button" className="btn ghost quick-import" disabled={busy} onClick={onChooseData}>{tr('atlas_quick_QuickPlan.choose_tree_data')}</button>}</>}>
    <div className="quick-plan">
      <label className="quick-field quick-name">{tr('atlas_quick_QuickPlan.name')}<input className="field" aria-label={tr('atlas_quick_QuickPlan.plan_name')} value={name} maxLength={120} onChange={e => setOwnName(e.target.value)} /></label>
      {showMechanics && <div className="quick-field"><span className="quick-label" id="quick-mechanics-label">{tr('atlas_quick_QuickPlan.mechanics')} <small>{picked.length ? tr('atlas_quick_QuickPlan.length_picked_in_this_order', { count: picked.length }) : tr('atlas_quick_QuickPlan.pick_the_ones_you_run')}</small></span>
        <div className="quick-tiles" role="group" aria-labelledby="quick-mechanics-label">
          {mechanics.map(m => {
            const at = picked.indexOf(m.targetId);
            return <button type="button" key={m.targetId} className="quick-tile" aria-pressed={at >= 0} title={m.name} onClick={() => toggle(m.targetId)}>
              <ItemArt art={{ name: m.name, src: m.icons.reduce<string | undefined>((src, icon) => src ?? art?.(icon.asset, icon.nodeId), undefined) }} />
              <span className="quick-tile-name">{m.name}</span>
              {at >= 0 && <span className="quick-order" aria-label={tr('atlas_quick_QuickPlan.pick_at', { value: at + 1 })}>{at + 1}</span>}
            </button>;
          })}
          {!mechanics.length && <p>{tr('atlas_quick_QuickPlan.mechanic_names_are_loading_you')}</p>}
        </div></div>}
      <div className="quick-row">
        <div className="quick-field"><span className="quick-label">{tr('atlas_quick_QuickPlan.map_support')}</span>
          <Segmented ariaLabel={tr('atlas_quick_QuickPlan.map_support')} value={support} onChange={setSupport} options={[{ value: 'none', label: tr('atlas_quick_QuickPlan.none') }, { value: 'some', label: tr('atlas_quick_QuickPlan.some') }, { value: 'max', label: tr('atlas_quick_QuickPlan.max') }]} />
          <small className="quick-help">{fromMain('ml_atlas_quick', MAP_SUPPORT_TEXT[support])}</small></div>
        <label className="quick-field quick-points">{tr('atlas_quick_QuickPlan.points')}<input className="field" inputMode="numeric" aria-label={tr('atlas_quick_QuickPlan.points')} aria-invalid={!pointsOk || undefined} value={pointsText} onChange={e => setPointsText(e.target.value)} />
          <small className="quick-help">{pointsOk ? (maximum ? tr('atlas_quick_QuickPlan.maximum_maximum', { maximum }) : '') : maximum ? tr('atlas_quick_QuickPlan_2.enter_1_to', { maximum: maximum }) : tr('atlas_quick_QuickPlan_2.enter_a_whole_number')}</small></label>
      </div>
      <label className="quick-check"><input type="checkbox" checked={fill} onChange={e => setFill(e.target.checked)} />{tr('atlas_quick_QuickPlan.fill_leftover_points')}<small className="quick-help">{showMechanics ? tr('atlas_quick_QuickPlan.after_your_mechanics_more_of') : tr('atlas_quick_QuickPlan.after_map_support_quantity_rarity')}</small></label>
      {error && <p role="alert">{error}</p>}
    </div>
  </Dialog>;
}
