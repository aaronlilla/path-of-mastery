// Pure rules for the creator screens: profile, verification, My posts and analytics, inbox.
export type Result<T> = { ok: true; value: T } | { ok: false; code: 'UNAVAILABLE' | 'DENIED' | 'STALE' | 'RATE_LIMITED' | 'OFFLINE' | 'INVALID'; message?: string };

// ---- profile -------------------------------------------------------------------------------------------------
export const NAME_MAX = 80, BIO_MAX = 1000, LINKS_MAX = 5, BIO_LINES = 4, BIO_COLLAPSE_CHARS = 320;
export type ProfileDraft = { name: string; bio: string; links: string[] };
export type ProfileErrors = { name?: string; bio?: string; links?: string; link: Record<number, string> };
export function httpsUrl(raw: string): URL | null {
  try { const u = new URL(raw.trim()); return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') ? u : null; } catch { return null; }
}
export function validateProfile(d: ProfileDraft): { ok: boolean; errors: ProfileErrors } {
  const errors: ProfileErrors = { link: {} };
  const name = d.name.trim();
  if (!name) errors.name = 'Enter a name.'; else if (name.length > NAME_MAX) errors.name = `Use ${NAME_MAX} characters or fewer.`;
  if (d.bio.length > BIO_MAX) errors.bio = `Use ${BIO_MAX} characters or fewer.`;
  const links = d.links.map((l) => l.trim()).filter(Boolean);
  if (links.length > LINKS_MAX) errors.links = `Add up to ${LINKS_MAX} links.`;
  d.links.forEach((l, i) => { if (l.trim() && !httpsUrl(l)) errors.link[i] = 'Use a full https:// link.'; });
  return { ok: !errors.name && !errors.bio && !errors.links && Object.keys(errors.link).length === 0, errors };
}
export type LinkKind = 'youtube' | 'twitch' | 'site';
export function linkView(raw: string): { href: string; label: string; kind: LinkKind } | null {
  const u = httpsUrl(raw); if (!u) return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const kind: LinkKind = /(^|\.)(youtube\.com|youtu\.be)$/.test(host) ? 'youtube' : /(^|\.)twitch\.tv$/.test(host) ? 'twitch' : 'site';
  return { href: u.href, label: host, kind };
}
export function bioView(bio: string, expanded: boolean): { text: string; collapsible: boolean } {
  const long = bio.split('\n').length > BIO_LINES || bio.length > BIO_COLLAPSE_CHARS;
  if (!long || expanded) return { text: bio, collapsible: long };
  return { text: bio.split('\n').slice(0, BIO_LINES).join('\n').slice(0, BIO_COLLAPSE_CHARS), collapsible: true };
}
export type Reputation = { netVotes: number | null; listings: number | null; finishedRuns: number | null };
/** Three separate values. No fused score, no confidence grade, no verification boost. */
export function reputationView(r: Reputation): { label: string; value: string }[] {
  const f = (n: number | null) => (n === null ? 'Unknown' : String(n));
  return [{ label: 'Net votes', value: f(r.netVotes) }, { label: 'Listings', value: f(r.listings) }, { label: 'Finished runs', value: f(r.finishedRuns) }];
}
export const REPUTATION_HELP = 'Net votes adds up the votes on this creator’s visible listings, for the league you pick. Listings counts visible listings. Finished runs counts runs that ended on a final trigger or were confirmed by the runner. They are shown apart and never combined. Verified status and Pro do not change them or the feed order.';
export const VERIFIED_TIP = 'Identity verified. This does not verify the plan.';
export const EMPTY_CREATOR = 'No public items yet.';
export type FollowGate = { action: 'follow' | 'unfollow' | 'sign_in'; label: 'Follow' | 'Following'; disabled: boolean; hint: string };
export function followGate(i: { signedIn: boolean; online: boolean; following: boolean; own: boolean }): FollowGate {
  const label = i.following ? 'Following' : 'Follow';
  if (i.own) return { action: 'follow', label, disabled: true, hint: 'This is your profile.' };
  if (!i.signedIn) return { action: 'sign_in', label, disabled: false, hint: '' };
  if (!i.online) return { action: i.following ? 'unfollow' : 'follow', label, disabled: true, hint: 'Connect to change who you follow.' };
  return { action: i.following ? 'unfollow' : 'follow', label, disabled: false, hint: '' };
}
export const cachedStamp = (cachedAt: string | null) => (cachedAt ? `Saved copy from ${cachedAt.slice(0, 10)}` : '');

// ---- verification ---------------------------------------------------------------------------------------------
export type VerifyStatus = 'not_submitted' | 'pending' | 'needs_info' | 'verified';
export const VERIFY_LABEL: Record<VerifyStatus, string> = { not_submitted: 'Not submitted', pending: 'Pending', needs_info: 'Needs info', verified: 'Verified' };
export type VerifyDraft = { publicName: string; profileLink: string; explanation: string; alternative: boolean };
export function validateVerify(d: VerifyDraft): { ok: boolean; errors: { name?: string; link?: string } } {
  const errors: { name?: string; link?: string } = {};
  const n = d.publicName.trim();
  if (!n) errors.name = 'Enter your public creator name.'; else if (n.length > NAME_MAX) errors.name = `Use ${NAME_MAX} characters or fewer.`;
  if (!httpsUrl(d.profileLink)) errors.link = 'Use a full https:// link to your public profile.';
  return { ok: !errors.name && !errors.link, errors };
}
export const proofText = (challenge: string) => `Add this verification text to your public profile: ${challenge}`;
export function verifyGate(i: { status: VerifyStatus; draft: VerifyDraft; online: boolean; signedIn: boolean; busy: boolean }): { canSubmit: boolean; canCheck: boolean; canSave: boolean; hint: string } {
  const valid = validateVerify(i.draft).ok;
  if (!i.signedIn) return { canSubmit: false, canCheck: false, canSave: true, hint: 'Sign in to apply.' };
  if (i.status === 'verified') return { canSubmit: false, canCheck: false, canSave: false, hint: 'Your identity is verified.' };
  if (i.status === 'pending') return { canSubmit: false, canCheck: i.online && !i.busy, canSave: false, hint: 'Your request is waiting for review.' };
  if (!i.online) return { canSubmit: false, canCheck: false, canSave: true, hint: 'Connect to submit.' };
  return { canSubmit: valid && !i.busy, canCheck: valid && !i.busy, canSave: !i.busy, hint: valid ? '' : 'Fill in both fields to submit.' };
}
export const VERIFY_INTRO = 'Verification confirms identity. It does not rank your posts.';

// ---- My posts and analytics -------------------------------------------------------------------------------------
export type PostStatus = 'draft' | 'published' | 'needs_review' | 'removed';
export const POST_STATUS_LABEL: Record<PostStatus, string> = { draft: 'Draft', published: 'Published', needs_review: 'Needs review', removed: 'Removed' };
export type Count = { value: number | null; suppressed?: boolean };
export type Analytics = {
  votes: Count; saves: Count; runs: Count; finishedFinalTrigger: Count; finishedPlayerConfirmed: Count;
  feedback: { senders: Count; relevantRuns: Count; categories: { name: string; count: Count }[] };
  revisions: number[]; chunks: { id: string; name: string }[];
};
export type OwnPost = {
  postId: string; title: string; kind: 'build' | 'atlas' | 'timeline'; revision: number | null; league: string; status: PostStatus;
  moderationReason?: string; reviewRequested?: boolean; analytics?: Analytics; analyticsAt?: string | null;
};
export const SUPPRESS_MIN_DEFAULT = 5;
/** A value is Unknown when not measured, hidden when the server marks it suppressed or the group is smaller than the minimum. */
export function countView(c: Count, opts: { min?: number; rawSmall?: boolean } = {}): string {
  if (c.suppressed) return 'Hidden (small group)';
  if (c.value === null) return 'Unknown';
  if (opts.rawSmall && c.value > 0 && c.value < (opts.min ?? SUPPRESS_MIN_DEFAULT)) return 'Hidden (small group)';
  return String(c.value);
}
export function analyticsRows(a: Analytics, min = SUPPRESS_MIN_DEFAULT): { label: string; value: string }[] {
  return [
    { label: 'Votes', value: countView(a.votes) }, { label: 'Saves', value: countView(a.saves) }, { label: 'Runs', value: countView(a.runs) },
    { label: 'Finished, final trigger seen', value: countView(a.finishedFinalTrigger) }, { label: 'Finished, player confirmed', value: countView(a.finishedPlayerConfirmed) },
    ...a.feedback.categories.map((c) => ({ label: `Feedback: ${c.name}`, value: countView(c.count, { min, rawSmall: true }) })),
  ];
}
export function feedbackLine(a: Analytics, revision: number): string {
  const n = a.feedback.senders;
  if (n.suppressed) return `Feedback on v${revision} is hidden (small group).`;
  if (n.value === null) return `Feedback on v${revision}: Unknown.`;
  const denom = a.feedback.relevantRuns.value === null ? 'Unknown' : String(a.feedback.relevantRuns.value);
  return `${n.value} runners sent feedback on v${revision}. Relevant runs: ${denom}.`;
}
export function postsView(posts: OwnPost[], status: PostStatus | 'all', search: string): OwnPost[] {
  const q = search.trim().toLowerCase();
  return posts.filter((p) => (status === 'all' || p.status === status) && (!q || p.title.toLowerCase().includes(q)));
}
export function reviewGate(p: OwnPost, i: { online: boolean; busy: boolean }): { show: boolean; disabled: boolean; label: string; hint: string } {
  const show = p.status === 'removed' || p.status === 'needs_review';
  if (!show) return { show: false, disabled: true, label: 'Request review', hint: '' };
  if (p.reviewRequested) return { show, disabled: true, label: 'Review requested', hint: 'A person will look at this. Your post stays as it is until then.' };
  if (!i.online) return { show, disabled: true, label: 'Request review', hint: 'Connect to request a review.' };
  return { show, disabled: i.busy, label: 'Request review', hint: '' };
}
/** One key per post and reason, so a retry after an unknown outcome is the same request. */
export const reviewKey = (postId: string, revision: number | null) => `review:${postId}:${revision ?? 'none'}`;
export const NO_POSTS = 'No posts yet.';

// ---- inbox ---------------------------------------------------------------------------------------------------
export type InboxTab = 'unread' | 'all' | 'resolved';
export type InboxThread = {
  threadId: string; postTitle: string; revision: number; chunk: string | null; reason: string; at: string; text: string;
  allowReplies: boolean; read: boolean; resolved: boolean; fixedIn: number | null; instruction: string | null; ownPublished: number[];
  messages: { messageId: string; role: 'runner' | 'creator'; text: string; sentAt: string }[]; participants: string[] | null;
};
type RawThread = { threadId: string; role: 'runner' | 'creator'; publishedRevision: { displayRevision?: unknown }; allowReplies: boolean; text: string;
  messages: InboxThread['messages']; [field: string]: unknown };
/** Adapts a PrivateThread. Fields the server adds beyond the typed ones are read defensively. */
export function toInboxThread(t: RawThread): InboxThread {
  const s = (k: string, d = '') => (typeof t[k] === 'string' ? (t[k] as string) : d);
  const b = (k: string) => t[k] === true;
  const revision = typeof t.publishedRevision.displayRevision === 'number' ? t.publishedRevision.displayRevision : 0;
  return { threadId: t.threadId, postTitle: s('postTitle', 'Post'), revision, chunk: typeof t.chunk === 'string' ? t.chunk : null, reason: s('reason', 'Feedback'),
    at: s('createdAt', t.messages[0]?.sentAt ?? ''), text: t.text, allowReplies: t.allowReplies, read: b('read'), resolved: b('resolved'),
    fixedIn: typeof t.fixedIn === 'number' ? t.fixedIn : null, instruction: typeof t.instruction === 'string' ? t.instruction : null,
    ownPublished: Array.isArray(t.ownPublished) ? (t.ownPublished as unknown[]).filter((x): x is number => typeof x === 'number') : [], messages: t.messages,
    participants: Array.isArray(t.participants) ? (t.participants as unknown[]).filter((x): x is string => typeof x === 'string') : null };
}
/** Only the two people in a thread see it. A thread without a participant list is shown only in its own role. */
export function canViewThread(t: InboxThread, account: string | null, ownRole: 'creator' | 'runner', role: 'creator' | 'runner'): boolean {
  if (!account) return false;
  if (t.participants) return t.participants.includes(account);
  return role === ownRole;
}
export function inboxView(threads: InboxThread[], tab: InboxTab, search: string, keepId: string | null = null): { key: string; title: string; threads: InboxThread[] }[] {
  const q = search.trim().toLowerCase();
  const list = threads.filter((t) => t.threadId === keepId || (tab === 'unread' ? !t.read && !t.resolved : tab === 'resolved' ? t.resolved : !t.resolved || tab === 'all')
    && (!q || `${t.postTitle} ${t.reason} ${t.text} ${t.chunk ?? ''}`.toLowerCase().includes(q)));
  const groups = new Map<string, { key: string; title: string; threads: InboxThread[] }>();
  for (const t of list.sort((a, b) => b.at.localeCompare(a.at))) {
    const key = `${t.postTitle}|${t.revision}|${t.chunk ?? ''}`;
    const g = groups.get(key) ?? { key, title: `${t.postTitle} / v${t.revision}${t.chunk ? ` / ${t.chunk}` : ''}`, threads: [] };
    g.threads.push(t); groups.set(key, g);
  }
  return [...groups.values()];
}
export const INBOX_EMPTY = 'No feedback yet.';
export const REPLIES_OFF = 'Replies are off for this feedback.';
export const REPLY_MAX = 2000;
export function replyGate(t: InboxThread, draft: string, i: { online: boolean; busy: boolean; rateLimited: boolean }): { canSend: boolean; hint: string } {
  if (!t.allowReplies) return { canSend: false, hint: REPLIES_OFF };
  if (!i.online) return { canSend: false, hint: 'Connect to send. Your draft is saved.' };
  if (i.rateLimited) return { canSend: false, hint: 'You are sending too fast. Try again in a minute.' };
  const n = draft.trim().length;
  if (!n) return { canSend: false, hint: '' };
  if (draft.length > REPLY_MAX) return { canSend: false, hint: `Use ${REPLY_MAX} characters or fewer.` };
  return { canSend: !i.busy, hint: '' };
}
/** Fixed-in choices are the creator's own published revisions at or after the one the feedback was about. */
export function fixedChoices(t: InboxThread): number[] { return [...new Set(t.ownPublished)].filter((r) => r >= t.revision).sort((a, b) => a - b); }
export function fixedGate(t: InboxThread, revision: number | null, i: { online: boolean }): { ok: boolean; hint: string } {
  if (!i.online) return { ok: false, hint: 'Connect to save.' };
  if (revision === null) return { ok: false, hint: 'Pick a version.' };
  if (!fixedChoices(t).includes(revision)) return { ok: false, hint: 'Pick one of your published versions.' };
  return { ok: true, hint: '' };
}
/** Opening marks read. Reading never resolves. */
export const afterOpen = (t: InboxThread): InboxThread => (t.read ? t : { ...t, read: true });
export const afterResolve = (t: InboxThread, on: boolean): InboxThread => ({ ...t, resolved: on, read: true });
export const afterFixed = (t: InboxThread, rev: number | null): InboxThread => ({ ...t, fixedIn: rev });
export const FIXED_LABEL = (rev: number) => `Fixed in v${rev}`;
export const errorCopy = (code: Extract<Result<unknown>, { ok: false }>['code']) => ({
  UNAVAILABLE: 'Could not reach the server. Try again.', DENIED: 'You do not have access to this.', STALE: 'This changed. Refresh and try again.',
  RATE_LIMITED: 'You are sending too fast. Try again in a minute.', OFFLINE: 'You are offline.', INVALID: 'Check the fields and try again.' })[code];
