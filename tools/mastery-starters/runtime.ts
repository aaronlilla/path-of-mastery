// The app's runtime rule for the bundled starters (starters stay current for the whole league).
// The evidence check (official league + patch pages, record review, qualification with policy.maxEvidenceAgeMs) happens
// when a release is built (`cli check --require-qualified`). The app never re-checks evidence age. It only decides
// whether the release-qualified starters are still current:
//   - hidden when they are switched off (remote flag `starters.current` is explicitly off; unreachable/unknown = keep showing),
//   - hidden when the league the pack was qualified for has ended (the league catalog row carries `endAt`; no end date = until a newer release),
//   - never current when the app's active league is another one (an older league's starter is never labelled current).
import type { LiveContext, StarterPack } from './types.js';

export const STARTERS_FLAG = 'starters.current';
export type RuntimeInput = {
  /** League the pack was qualified for (scope.json). */
  packLeagueId: string;
  now: string;
  /** Remote flag: true on, false off, null/undefined unreachable or not defined yet (fail-safe: keep showing). */
  flag?: boolean | null;
  /** End of the pack's league from the league catalog, when it carries one. */
  leagueEndsAt?: string | null;
  /** The league the app considers current, when it knows a newer one than the pack. */
  activeLeagueId?: string | null;
};
export type RuntimeDecision = { show: boolean; reason: 'current' | 'switched-off' | 'league-ended' | 'older-league' };

export function runtimeDecision(input: RuntimeInput): RuntimeDecision {
  if (input.flag === false) return { show: false, reason: 'switched-off' };
  if (input.activeLeagueId && input.activeLeagueId !== input.packLeagueId) return { show: false, reason: 'older-league' };
  if (input.leagueEndsAt) {
    const end = Date.parse(input.leagueEndsAt), now = Date.parse(input.now);
    if (Number.isFinite(end) && Number.isFinite(now) && now >= end) return { show: false, reason: 'league-ended' };
  }
  return { show: true, reason: 'current' };
}

/**
 * The moment the release-time check ran: the latest timestamp the pack and live context carry. Qualifying at this
 * instant re-runs the release-day decision (same 24 h evidence window) instead of one against the wall clock.
 */
export function releaseCheckedAt(pack: StarterPack, live: LiveContext): string {
  const times = [live.checkedAt, pack.createdAt, ...pack.sources.map(s => s.fetchedAt), ...pack.entries.flatMap(e => e.review ? [e.review.checkedAt] : [])]
    .map(Date.parse).filter(Number.isFinite);
  return new Date(Math.max(...times)).toISOString();
}

/** `endAt` of a league row in the captured official catalog (trade API), if the row carries one. */
export function leagueEndsAt(rawCatalog: unknown, leagueId: string, realm: string): string | null {
  const rows = (rawCatalog as { result?: { id?: unknown; realm?: unknown; endAt?: unknown }[] } | null)?.result;
  const row = Array.isArray(rows) ? rows.find(r => r?.id === leagueId && r?.realm === realm) : undefined;
  return typeof row?.endAt === 'string' && Number.isFinite(Date.parse(row.endAt)) ? row.endAt : null;
}

/** Remote-config document cached on disk: only an explicit off for the key counts. */
export function startersFlagFrom(doc: unknown): boolean | null {
  const entry = (doc as { flags?: Record<string, { state?: unknown } | undefined> } | null)?.flags?.[STARTERS_FLAG];
  return entry?.state === 'off' ? false : entry?.state === 'on' ? true : null;
}
