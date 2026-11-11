import { useState } from 'react';
import type { AccountUser } from '../../shared/accounts.js';

/** The player's picture from their provider, or their initial when there is none (or it does not load). */
export function Avatar({ user, size, dot }: { user: AccountUser; size: number; /** A small status dot at the corner: green when signed in and reachable. */ dot?: 'on' | 'off' }) {
  const [broken, setBroken] = useState(false);
  const initial = (user.name || user.email || '?').trim()[0]?.toUpperCase() ?? '?';
  return (
    <span className="acct-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>
      {user.avatarUrl && !broken ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <span>{initial}</span>}
      {dot && <i className="dot" data-on={dot === 'on' ? '' : undefined} />}
    </span>
  );
}
