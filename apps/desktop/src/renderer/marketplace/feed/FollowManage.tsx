import { useEffect, useRef, useState } from 'react';
import { Switch } from '../../ui.js';
import type { FollowRow, MarketplaceServices } from '../services.js';

/** Manage follows. Following a creator only filters the feed; it never changes ranking. */
export function FollowManage({ follows, onClose, onBrowse }: { follows: NonNullable<MarketplaceServices['follows']>; onClose: () => void; onBrowse: () => void }) {
  const [rows, setRows] = useState<FollowRow[] | null>(null), [error, setError] = useState(''), [dot, setDot] = useState(follows.dot);
  const first = useRef<HTMLElement>(null);
  useEffect(() => { follows.list().then(setRows, () => setError('Could not load your follows. Try again.')); }, []);
  const toggle = async (row: FollowRow) => {
    const next = !row.following; setRows(rs => rs && rs.map(r => r.creatorId === row.creatorId ? { ...r, following: next } : r)); setError('');
    try { await follows.set(row.creatorId, next); } catch { setRows(rs => rs && rs.map(r => r.creatorId === row.creatorId ? { ...r, following: !next } : r)); setError('Could not change that follow. Try again.'); }
  };
  return <section className="mp-manage" aria-label="Manage follows" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
    <label className="mp-check"><Switch checked={dot} label="Show new-post dot" onChange={async on => { setDot(on); try { await follows.setDot(on); } catch { setDot(!on); } }} /> Show new-post dot</label>
    {error && <p role="alert">{error}</p>}
    {rows === null && !error && <p role="status">Updating...</p>}
    {rows && !rows.length && <p>Follow a creator to see their posts here. <button type="button" className="btn" onClick={onBrowse}>Browse Marketplace</button></p>}
    <ul className="mp-follow-list">{rows?.map(r => <li key={r.creatorId}><span title={r.name}>{r.name}{r.verified && <small> Verified creator</small>}</span>
      <button type="button" className="btn" aria-pressed={r.following} onClick={() => void toggle(r)}>{r.following ? 'Following' : 'Follow'}</button></li>)}</ul>
    <button type="button" className="btn" onClick={onClose} ref={first as never}>Done</button>
  </section>;
}
