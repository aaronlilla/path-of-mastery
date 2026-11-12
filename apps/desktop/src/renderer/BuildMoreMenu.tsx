// The build header's More menu, as the design draws it: the link button opens Save As, Copy share link, Compare with and
// Version history. At the design's narrower header widths Save As leaves the header too, the button becomes "...", and the
// level mode (Auto or Manual) joins the menu from the same width.
import { useRef, useState } from 'react';
import { Icon, PortalMenu } from './ui';
import { tr } from './i18n';

export interface BuildMoreMenuProps {
  /** Header stage from the design: 0 and 1 are wide (Save As and share sit in the header), 2 and up are narrow. */
  stage: number;
  auto: boolean;
  signedIn: boolean;
  /** The button the share card hangs from when it opens from this menu. */
  btnRef: React.RefObject<HTMLButtonElement>;
  onNewBuild: () => void;
  onSaveAs: () => void;
  onShare: () => void;
  onSimilar: () => void;
  onCompare: () => void;
  onHistory: () => void;
  /** Opens the Loot Filter on the Build Filter for this build. The item is left out when the host does not pass it. */
  onLootFilter?: () => void;
  /** Opens the Publish to community dialog. */
  onPublish?: () => void;
  onAuto: (auto: boolean) => void;
}

export function BuildMoreMenu(p: BuildMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const wrap = useRef<HTMLDivElement>(null);
  const item = (label: string, icon: string, run: () => void, extra?: { meta?: string; kbd?: string; disabled?: boolean; title?: string; danger?: boolean }) => (
    <button key={label} type="button" role="menuitem" className={'menu-item' + (extra?.danger ? ' danger' : '')} disabled={extra?.disabled} title={extra?.title} onClick={() => { close(); run(); }}>
      <Icon name={icon} size={15} />
      <span className="grow">{label}</span>
      {extra?.kbd && <span className="kbdk">{extra.kbd}</span>}
      {extra?.meta && <span className="meta">{extra.meta}</span>}
    </button>
  );
  return (
    <div ref={wrap} style={{ position: 'relative', flex: 'none' }} onClick={(e) => e.stopPropagation()}>
      <button ref={p.btnRef} type="button" className="btn icon" data-lg="control" title={tr('BuildMoreMenu.more_new_build_save_as')} aria-label={tr('BuildMoreMenu.more')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="more" size={14} />
      </button>
      <PortalMenu anchor={p.btnRef} open={open} onClose={close} align="left" label={tr('BuildMoreMenu.more')} minWidth={300} className="bw-more">
        {item(tr('BuildMoreMenu.new_build'), 'plus', p.onNewBuild, { kbd: 'Ctrl N' })}
        {item(tr('BuildMoreMenu.save_as'), 'file-plus', p.onSaveAs, { kbd: 'Ctrl Shift S' })}
        {item(tr('BuildMoreMenu.version_history'), 'history', p.onHistory, p.signedIn ? { kbd: 'Ctrl H' } : { title: tr('BuildMoreMenu.version_history_is_kept_for') })}
        <div className="menu-sep" />
        {item(tr('BuildMoreMenu.copy_share_link'), 'link', p.onShare)}
        {p.onPublish && item(tr('BuildMoreMenu.publish_to_community'), 'share', p.onPublish)}
        <div className="menu-sep" />
        {item(tr('BuildMoreMenu.compare_with'), 'compare', p.onCompare)}
        {item(tr('BuildWorkspace.similar_builds'), 'search', p.onSimilar, { title: tr('BuildWorkspace.community_builds_with_the_same') })}
        {p.onLootFilter && item(tr('BuildMoreMenu.make_a_loot_filter_for'), 'filter', p.onLootFilter)}
        <div className="menu-sep" />
        <div className="bw-more-row">
          <span>{tr('BuildMoreMenu.passive_points')}</span>
          <div className="seg" data-lg="tile" role="group" aria-label={tr('BuildMoreMenu.character_level_mode')} title={tr('BuildMoreMenu.passive_point_allocation')}>
            <button type="button" aria-pressed={p.auto} onClick={() => p.onAuto(true)}>{tr('BuildMoreMenu.auto')}</button>
            <button type="button" aria-pressed={!p.auto} onClick={() => p.onAuto(false)}>{tr('BuildMoreMenu.manual')}</button>
          </div>
        </div>
      </PortalMenu>
    </div>
  );
}
