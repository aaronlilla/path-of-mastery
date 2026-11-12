import { BUDGET_BANDS, isSafeHttpsUrl, parseId, publicTextFromMarkdown, sanitizePublicPayload, type ApiFailure, type PostId, type PublicId, type PublicInline, type PublicItemPayload,
  type BudgetBand, type ListingMetadata, type PublicRichText, type PublishedRevisionRef, type RevisionId, type ValidationLimits } from '@pom/mastery-contracts';
import type { BlockKind, PublicationStatus, PublishBody, PublishPort, PublishSource, PublishType } from './port.js';

export const TYPE_LABEL: Record<PublishType, string> = { build: 'Build', atlas: 'Atlas plan', timeline: 'Timeline' };
/** Budget bands, creator-declared; no standardized currency guarantee. */
export const BUDGETS: { value: BudgetBand; label: string }[] = [{ value: 'not_stated', label: 'Not stated' }, { value: 'cheap', label: 'Cheap' }, { value: 'medium', label: 'Medium' }, { value: 'expensive', label: 'Expensive' }];
export const budgetLabel = (b: BudgetBand) => BUDGETS.find(x => x.value === b)?.label ?? 'Not stated';
const asBudget = (v: unknown): BudgetBand => (BUDGET_BANDS as readonly string[]).includes(v as string) ? v as BudgetBand : 'not_stated';
const asMechanics = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^mechanic:[a-z0-9-]+$/.test(x)) : [];
export const TITLE_MAX = 120, DESC_MIN = 30, DESC_MAX = 10000, TAGS_MAX = 10, TAG_MAX = 30;
export const COPY = {
  offline: 'Connect to publish.',
  noSource: (t: PublishType) => `Choose a saved ${TYPE_LABEL[t]}.`,
  descShort: 'Add a description of at least 30 characters so people know what this includes.',
  descLong: 'Keep the description to 10,000 characters or fewer.',
  title: 'Add a title between 1 and 120 characters.',
  sourceChanged: 'Source changed. Publish the reviewed version or refresh preview.',
  unknown: 'We could not confirm that this went through. Press Publish again; it will not post twice.',
  review: 'Review requested. Check status in My posts.',
  signedIn: 'Signed in. Press Publish to continue.',
  checked: 'Check done. Press Publish to continue.',
  needsReview: 'This post needs a moderator review. Your draft is saved.',
} as const;

export type Field = 'source' | 'title' | 'description' | 'tags' | 'video' | 'archive';
export type Draft = {
  draftVersion: number; postId: PostId; publicId: PublicId; revisionId: RevisionId;
  sourceObjectId: string | null; title: string; description: string;
  economy: 'trade' | 'ssf'; hardcore: boolean; ruthless: boolean; budget: BudgetBand; leagueStarter: boolean; tags: string[]; visibility: 'public' | 'unlisted'; video: string;
  mainSkill: string; archiveOk: boolean;
  /** Derived from the source (never edited here): class/ascendancy of a Build, mechanics of an Atlas plan. */
  className: string; ascendancy: string; mechanics: string[];
};
export function draftFromSource(source: PublishSource, uuid: () => string = () => crypto.randomUUID()): Draft {
  const d = source.defaults, e = source.existing;
  return { draftVersion: 1, postId: e?.postId ?? parseId('post', uuid()), publicId: e?.publicId ?? parseId('public', uuid()), revisionId: parseId('revision', uuid()),
    sourceObjectId: source.objectId, title: e?.title ?? source.title, description: '', economy: d.economy, hardcore: d.hardcore, ruthless: d.ruthless, budget: asBudget(d.budget),
    leagueStarter: d.leagueStarter === true, tags: [...d.tags], visibility: 'public', video: '', mainSkill: d.mainSkill, archiveOk: false, ...derivedOf(source) };
}
const derivedOf = (source: PublishSource) => ({ className: source.defaults.className ?? '', ascendancy: source.defaults.ascendancy ?? '', mechanics: asMechanics(source.defaults.mechanics) });
/** A saved local draft (maybe from an older version of the dialog) with the derived fields read again from the source. */
export function normalizeDraft(draft: Partial<Draft> & Pick<Draft, 'postId' | 'publicId' | 'revisionId'>, source: PublishSource): Draft {
  const base = draftFromSource(source);
  return { ...base, ...draft, budget: asBudget(draft.budget), leagueStarter: draft.leagueStarter === true, tags: Array.isArray(draft.tags) ? draft.tags.filter(t => typeof t === 'string') : base.tags, ...derivedOf(source) };
}
/** The class line for a Build: "Slayer (Duelist)", or the class alone. */
export const classLine = (className: string, ascendancy: string) => ascendancy ? `${ascendancy} (${className || 'class unknown'})` : className;
/** `mechanic:searing-exarch` -> `Searing Exarch`. */
export const mechanicLabel = (id: string) => id.replace(/^mechanic:/, '').split('-').map(w => w ? w[0]!.toUpperCase() + w.slice(1) : w).join(' ');
/** The listing metadata of the reviewed post. Tags are trimmed and unique (ignoring case). */
export function listingOf(draft: Draft): ListingMetadata {
  const seen = new Set<string>(), tags: string[] = [];
  for (const t of draft.tags.map(x => x.trim()).filter(Boolean)) { const k = t.toLocaleLowerCase(); if (!seen.has(k)) { seen.add(k); tags.push(t); } }
  const video = draft.video.trim();
  return { budget: draft.budget, leagueStarter: draft.leagueStarter, tags, video: video && isSafeHttpsUrl(video) ? video : null,
    className: draft.className.trim() ? draft.className.trim() : null, ascendancy: draft.ascendancy.trim() ? draft.ascendancy.trim() : null, mechanics: [...draft.mechanics] };
}
export const leagueOf = (source: PublishSource) => source.ref.stamp.leagueId.status === 'known' ? source.ref.stamp.leagueId.value : 'Unknown league';
export const isOldLeague = (source: PublishSource, active: string | null) => active !== null && source.ref.stamp.leagueId.status === 'known' && source.ref.stamp.leagueId.value !== active;
export const archiveLabel = (source: PublishSource) => `Publish in ${leagueOf(source)}'s archive`;
export const descLength = (text: string) => [...text.replace(/\s+/g, ' ').trim()].length;
export type VideoKind = 'YouTube' | 'Twitch' | 'Link';
export function videoKind(url: string): VideoKind | null {
  if (!isSafeHttpsUrl(url)) return null;
  const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  return host === 'youtu.be' || host.endsWith('youtube.com') ? 'YouTube' : host.endsWith('twitch.tv') ? 'Twitch' : 'Link';
}

export type Errors = Partial<Record<Field, string>>;
export const FIELD_ORDER: Field[] = ['source', 'title', 'description', 'tags', 'video', 'archive'];
export function validateDraft(draft: Draft, source: PublishSource | null, type: PublishType, activeLeague: string | null): Errors {
  const e: Errors = {};
  if (!source) e.source = COPY.noSource(type);
  const title = draft.title.trim();
  if (title.length < 1 || [...title].length > TITLE_MAX) e.title = COPY.title;
  const n = descLength(draft.description);
  if (n < DESC_MIN) e.description = COPY.descShort; else if (draft.description.length > DESC_MAX) e.description = COPY.descLong;
  if (draft.tags.length > TAGS_MAX) e.tags = 'Use up to 10 tags.';
  else if (draft.tags.some(t => [...t].length > TAG_MAX)) e.tags = 'Each tag can be up to 30 characters.';
  if (draft.video.trim() && !videoKind(draft.video.trim())) e.video = 'Use a full https:// link.';
  if (source && isOldLeague(source, activeLeague) && !draft.archiveOk) e.archive = `Tick the box to publish in ${leagueOf(source)}'s archive.`;
  return e;
}
export const firstError = (e: Errors): Field | null => FIELD_ORDER.find(f => e[f]) ?? null;

/** Counts `notes` strings anywhere in a value. These are the private fields a public post must not carry. */
export function countNotes(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countNotes(v), 0);
  if (value && typeof value === 'object') return Object.entries(value).reduce((n, [k, v]) => n + (k === 'notes' && typeof v === 'string' && v ? 1 : 0) + countNotes(v), 0);
  return 0;
}
export type Included = { version: string; omitted: string[]; fixed: string };
export const FIXED_OMISSION = 'Not included: log paths, account details and unrelated history.';
export function includedSummary(source: PublishSource, publicDocument: PublicItemPayload['document']): Included {
  const omitted: string[] = [];
  const notes = countNotes(source.document) - countNotes(publicDocument);
  if (notes > 0) omitted.push(`Private notes (${notes})`);
  if (source.history.length) omitted.push(`Edit history (${source.history.length} ${source.history.length === 1 ? 'entry' : 'entries'})`);
  return { version: source.localRevision, omitted, fixed: FIXED_OMISSION };
}

export type TimelineFacts = { included: string[]; empty: string[]; missing: string[]; text: string | null; range: { start: number; end: number } | null; choices: number };
export function timelineFacts(doc: PublishSource['document']): TimelineFacts | null {
  if (doc.kind !== 'timeline') return null;
  const t = doc.payload.timeline, included: string[] = [], empty: string[] = [], missing: string[] = [];
  for (const lane of [...t.lanes].sort((a, b) => a.order - b.order)) {
    const clips = t.clips.filter(c => c.laneId === lane.laneId);
    const usable = clips.filter(c => c.options.some(o => o.actions.length > 0));
    if (usable.length) included.push(lane.title); else empty.push(lane.title);
    clips.filter(c => !c.options.some(o => o.actions.length > 0)).forEach((c, i) => { if (usable.length) missing.push(`${lane.title}: clip ${i + 1} has no instructions`); });
  }
  const starts = t.clips.map(c => c.range.start), ends = t.clips.map(c => c.range.endExclusive);
  return { included, empty, missing, choices: doc.payload.choices.length, range: starts.length ? { start: Math.min(...starts), end: Math.max(...ends) } : null,
    text: empty.length ? `Empty lanes: ${empty.join(', ')}. No instructions included.` : null };
}

export type Built = { preview: PublicItemPayload; body: PublishBody; included: Included; timeline: TimelineFacts | null; key: string };
export type BuildResult = { ok: true; value: Built } | { ok: false; errors: Errors };
export function descriptionRich(draft: Draft, limits: ValidationLimits): PublicRichText | null {
  const r = publicTextFromMarkdown(draft.description, limits);
  if (!r.ok) return null;
  const rich = [...r.value];
  const url = draft.video.trim();
  if (url && isSafeHttpsUrl(url)) rich.push({ kind: 'paragraph', content: [{ kind: 'text', text: `${videoKind(url)} video: ` } as PublicInline, { kind: 'link', text: url, href: url }] });
  return rich;
}
/** Builds the exact reviewed post. Private notes and history are removed here and again by the server's sanitizer; the flags stay false. */
export function buildPublication(source: PublishSource, draft: Draft, port: Pick<PublishPort, 'limits' | 'creator'>, key: string, now = new Date()): BuildResult {
  const rich = descriptionRich(draft, port.limits);
  if (!rich) return { ok: false, errors: { description: COPY.descShort } };
  const existing = source.existing, revision = (existing?.displayRevision ?? 0) + 1;
  const ref: PublishedRevisionRef = { postId: draft.postId, revisionId: draft.revisionId, displayRevision: revision as PublishedRevisionRef['displayRevision'] };
  const clean = sanitizePublicPayload({ schemaVersion: 1, publicId: draft.publicId, publishedRevision: ref, visibility: draft.visibility, stamp: source.ref.stamp, title: draft.title.trim(),
    creator: port.creator, description: rich, document: source.document, credits: source.credits, votes: { up: 0, down: 0, net: 0 }, finishes: { finalTriggerObserved: 0, playerConfirmed: 0 },
    publishedAt: now.toISOString(), listing: listingOf(draft) }, port.limits, { includeNotes: false, includeHistory: false });
  if (!clean.ok) return { ok: false, errors: { source: (clean.issues[0] ? clean.issues[0].path + ' ' + clean.issues[0].message : '') || 'We could not confirm that this file contains a usable ' + TYPE_LABEL[source.kind] + '. Check the source and try again.' } };
  const preview = clean.value;
  const body: PublishBody = { request: { source: source.ref, visibility: draft.visibility, payload: preview.document, description: preview.description, includeNotes: false, includeHistory: false, idempotencyKey: key },
    preview, expectedPostRowVersion: existing?.rowVersion ?? 0, draftVersion: draft.draftVersion, successorOf: null };
  return { ok: true, value: { preview, body, included: includedSummary(source, preview.document), timeline: timelineFacts(preview.document), key } };
}

/** One idempotency key per exact content. A retry after an unknown outcome reuses it; changed content gets a new one. */
export const fingerprint = (source: PublishSource, draft: Draft) => JSON.stringify([source.ref.objectId, source.ref.revisionId, source.ref.payloadHash, draft.postId, draft.title.trim(), draft.description, draft.visibility, draft.video.trim(), listingOf(draft)]);
export class AttemptBook {
  private keys = new Map<string, string>();
  constructor(private readonly make: () => string = () => crypto.randomUUID()) {}
  keyFor(print: string): string { let k = this.keys.get(print); if (!k) { k = this.make(); this.keys.set(print, k); } return k; }
}

export type Rejection = { text: string; field: Field | null; canReview: boolean };
const localTime = (iso: string) => new Date(iso).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
export function rejection(f: Pick<ApiFailure, 'code' | 'message' | 'retryAt'>): Rejection {
  if (f.code === 'RATE_LIMITED') return { text: `You have submitted too many posts. Try again at ${f.retryAt ? localTime(f.retryAt) : 'a little later'}. Your draft is saved.`, field: null, canReview: false };
  const m = f.message;
  const field: Field | null = /^(Add a description|Keep the description)/.test(m) ? 'description' : /^Add a title/.test(m) ? 'title' : /^(This post repeats|We could not confirm)/.test(m) ? 'source' : null;
  return { text: m || COPY.needsReview, field, canReview: field === null && /moderator review|unsolicited|still being reviewed/.test(m) };
}
export type PublishView =
  | { kind: 'published'; ref: PublishedRevisionRef }
  | { kind: 'offline' } | { kind: 'sign_in' } | { kind: 'human_check' } | { kind: 'source_changed' }
  | { kind: 'rejected'; rejection: Rejection }
  | { kind: 'unknown' };

async function reconcile(port: PublishPort, key: string): Promise<PublishView> {
  try {
    const s = await port.status(key);
    if (!s.ok) return { kind: 'unknown' };
    if (s.value.status === 'published' && s.value.publishedRevision) return { kind: 'published', ref: s.value.publishedRevision };
    if (s.value.status === 'rejected' || s.value.status === 'needs_review') return { kind: 'rejected', rejection: rejection({ code: 'MODERATION_REJECTED', message: s.value.findings[0]?.message ?? COPY.needsReview }) };
  } catch { /* still unknown */ }
  return { kind: 'unknown' };
}
/** The one Publish action. It never signs in or passes a check by itself; the caller returns to the preview and the person presses Publish again. */
export async function submitPublish(port: PublishPort, built: Built, source: PublishSource, opts: { acceptChangedSource?: boolean } = {}): Promise<PublishView> {
  if (!port.online()) return { kind: 'offline' };
  if (!port.signedIn()) return { kind: 'sign_in' };
  if (!opts.acceptChangedSource) {
    try { if ((await port.currentRef(source.objectId)).revisionId !== source.ref.revisionId) return { kind: 'source_changed' }; } catch { /* local read failed: the reviewed version still stands */ }
  }
  let result;
  try { result = await port.publish(built.body); } catch { return await reconcile(port, built.key); }
  if (result.ok) return { kind: 'published', ref: result.value };
  switch (result.code) {
    case 'SIGN_IN_REQUIRED': return { kind: 'sign_in' };
    case 'HUMAN_CHECK_REQUIRED': return { kind: 'human_check' };
    case 'UNAVAILABLE': case 'AI_SERVICE_UNAVAILABLE': case 'ENTITLEMENT_UNAVAILABLE': return await reconcile(port, built.key);
    default: return { kind: 'rejected', rejection: rejection(result) };
  }
}
export const blockText = (k: BlockKind) => k === 'sign_in' ? COPY.signedIn : COPY.checked;
/** Request review after an uncertain rejection. No automatic public post. */
export async function requestReview(port: PublishPort, key: string): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  try {
    const s = await port.status(key);
    if (!s.ok) return { ok: false, text: 'Could not request a review. Try again.' };
    const r = await port.requestReview({ submissionId: (s.value as PublicationStatus).submissionId, reviewedHash: s.value.reviewedHash });
    return r.ok ? { ok: true, text: COPY.review } : { ok: false, text: r.message || 'Could not request a review. Try again.' };
  } catch { return { ok: false, text: 'Could not request a review. Try again.' }; }
}
