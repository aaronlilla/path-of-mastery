import { useEffect, useRef, useState } from 'react';
import { Icon, PortalMenu } from '../ui';
import { knownLabel, stampLines, type Art, type ItemCardModel, type LifecycleAction } from './model.js';
import './documents.css';
import { tr } from '../i18n';

export function ItemArt({ art }: { art: Art }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [art.src]);
  return art.src && !failed ? <img className="mastery-art" src={art.src} alt={art.name} onError={() => setFailed(true)} />
    : <span className="mastery-art mastery-art-missing" role="img" aria-label={tr('documents_ItemCard.name_art_unavailable', { name: art.name })} />;
}
/** An ISO timestamp -> a local date and time such as `Oct 19, 2026, 10:57 AM` (this PC's locale and time zone); unparseable text stays as is. */
export function readableDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
const actions: { action: LifecycleAction; label: string }[] = [
  { action: 'duplicate', label: tr('documents_ItemCard.duplicate') }, { action: 'rename', label: tr('documents_ItemCard.rename') }, { action: 'move', label: tr('documents_ItemCard.move_to_folder') },
  { action: 'edit_history', label: tr('documents_ItemCard.edit_history') }, { action: 'account_history', label: tr('documents_ItemCard.account_version_history') },
  { action: 'send', label: tr('documents_ItemCard.send_to_timeline') }, { action: 'share', label: tr('documents_ItemCard.share') }, { action: 'publish', label: tr('documents_ItemCard.publish') },
  { action: 'copy_league', label: tr('documents_ItemCard.copy_to_league') }, { action: 'delete', label: tr('documents_ItemCard.delete') },
];
export function ItemCard({ item, onOpen, onAction, primary, view = 'grid', menuActions }: {
  item: ItemCardModel; onOpen: () => void; onAction?: (action: LifecycleAction) => void;
  /** Limits the More menu to these actions (an area that cannot do the others hides them instead of toasting). */
  menuActions?: LifecycleAction[];
  primary?: { label: 'Run' | 'Resume' | 'Follow' | 'Save'; run: () => void; disabledReason?: string }; view?: 'grid' | 'list';
}) {
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const closeMenu = () => { setMenu(false); more.current?.focus(); };
  const summary = item.summary;
  return <article className="mastery-item-card" data-view={view} aria-label={item.title}
    onContextMenu={(e) => { if (item.ownership === 'owned' && onAction) { e.preventDefault(); more.current?.focus(); setMenu(true); } }}
    onKeyDown={(e) => {
      if (item.ownership === 'owned' && onAction && (e.key === 'ContextMenu' || e.key === 'F10' && e.shiftKey)) {
        e.preventDefault(); more.current?.focus(); setMenu(true); return;
      }
      if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const target = e.target as HTMLElement;
      const parent = target.closest('[role="menu"]');
      if (!parent) return;
      const entries = [...parent.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
      const i = entries.indexOf(target);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? entries.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      e.preventDefault(); entries[next]?.focus();
    }}>
    <button type="button" className="mastery-card-open" onClick={onOpen} aria-label={tr('documents_ItemCard.open_title', { title: item.title })}>
      <span className="mastery-card-title"><ItemArt art={item.art} /><span title={item.title}>{item.title}</span></span>
      <span className="mastery-card-meta">{summary.kind === 'atlas' ? tr('documents_ItemCard.atlas_plan') : summary.kind === 'timeline' ? tr('documents_ItemCard.timeline') : tr('documents_ItemCard.build')}</span>
      {/* Unknown stamp fields add nothing to a card. */}
      {item.stamp.leagueId.status === 'known' && <span className="mastery-card-meta" title={stampLines(item.stamp).join('\n')}>{stampLines(item.stamp)[0]}</span>}
      {item.stamp.datasetVersion.status === 'known' && <span className="mastery-card-meta">{tr('documents_ItemCard.source_data_datasetversion', { datasetVersion: knownLabel(item.stamp.datasetVersion) })}</span>}
      {summary.kind === 'atlas' && <><span>{tr('documents_ItemCard.count_steps', { count: summary.steps })} {tr('documents_ItemCard.stepname_points_points', { stepName: summary.stepName, points: knownLabel(summary.points) })}</span>
        <span className="mastery-card-mechanics">{summary.mechanics.slice(0, 3).map((a) => <span key={a.name}><ItemArt art={a} />{a.name}</span>)}</span></>}
      {summary.kind === 'timeline' && <><span>{summary.lanes.join(' / ')}</span><span>{summary.lastRun ? tr('documents_ItemCard.last_run_lastrun', { lastRun: summary.lastRun }) : tr('documents_ItemCard.no_run_yet')}</span></>}
      {summary.kind === 'build' && summary.rows.map((row, i) => <span key={i}>{row}</span>)}
      {item.ownership !== 'owned' && <><span>{tr('documents_ItemCard.by_creator', { creator: item.creator })}</span><span>{tr('documents_ItemCard.votes_votes', { votes: item.votes })}</span>
        <span>{tr('documents_ItemCard.finaltriggerobserved_finished_with_f', { finalTriggerObserved: item.finishes.finalTriggerObserved })}</span><span>{tr('documents_ItemCard.playerconfirmed_player_confirmed', { playerConfirmed: item.finishes.playerConfirmed })}</span></>}
      {item.ownership === 'starter' && <span>{tr('documents_ItemCard.starter')}</span>}
      {item.credit && <span>{item.credit.status === 'original_removed' ? tr('documents_ItemCard.original_removed') : tr('documents_ItemCard.copied_from_title_by_creatorname', { title: item.credit.title, creatorName: item.credit.creatorName })}</span>}
      <span className="mastery-card-meta">{tr('documents_ItemCard.updated')} <time dateTime={item.updatedAt}>{readableDate(item.updatedAt)}</time></span>
    </button>
    <div className="mastery-card-actions">
      <span>{item.save === 'saved' ? tr('documents_ItemCard.saved_on_this_pc') : item.save === 'download_needed' ? tr('documents_ItemCard.download_needed') : tr('documents_ItemCard.not_saved')}</span>
      {primary && <button type="button" className="btn" disabled={!!primary.disabledReason} onClick={primary.run}>{primary.label}</button>}
      {item.ownership === 'owned' && onAction && <button type="button" ref={more} className="icon-btn" aria-label={tr('documents_ItemCard.more_actions_for_title', { title: item.title })} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" /></button>}
    </div>
    {primary?.disabledReason && <p className="mastery-safe-note">{primary.disabledReason}</p>}
    <PortalMenu anchor={more} open={menu} onClose={closeMenu} label={tr('documents_ItemCard.more_actions')}>
      <button type="button" role="menuitem" className="menu-item" onClick={() => { closeMenu(); onOpen(); }}>{tr('documents_ItemCard.open')}</button>
      {actions.filter(({ action }) => !menuActions || menuActions.includes(action)).map(({ action, label }) => <button type="button" role="menuitem" className="menu-item" key={action} onClick={() => { closeMenu(); onAction?.(action); }}>{label}</button>)}
    </PortalMenu>
  </article>;
}
