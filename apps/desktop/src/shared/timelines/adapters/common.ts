import { actionSchema, parseId, revisionRefSchema, sourceSnapshotSchema, type Action, type ActionId, type ClipId,
  type FrozenSource, type Hash, type Instructions, type LaneId, type OptionId, type Requirement,
  type RevisionRef, type Schema, type SourceSnapshot, type Trigger, type ValidationLimits } from '@pom/mastery-contracts';

export type AdapterContext = { laneId: LaneId; clipId: ClipId; optionId: OptionId; limits: ValidationLimits };
export type SourceIdentity = Omit<RevisionRef, 'fallbackSnapshotHash'>;
export class TimelineSourceError extends Error {
  constructor(readonly code: 'INVALID' | 'MISSING_PAYLOAD' | 'HASH_MISMATCH' | 'CYCLE' | 'DEPTH', message: string) { super(message); }
}
export function validated<T>(schema: Schema<T>, input: unknown, limits: ValidationLimits): T {
  const parsed = schema.parse(input, limits);
  if (!parsed.ok) throw new TimelineSourceError('INVALID', parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
  return structuredClone(parsed.value);
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
}
export async function contentHash(value: unknown): Promise<Hash> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return parseId('hash', Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''));
}
export async function pinSource(identity: SourceIdentity, input: SourceSnapshot, limits: ValidationLimits): Promise<FrozenSource> {
  const snapshot = validated(sourceSnapshotSchema, input, limits);
  if (canonicalJson(identity.stamp) !== canonicalJson(snapshot.payload.stamp)) throw new TimelineSourceError('INVALID', 'The source stamp does not match its revision.');
  return { ref: validated(revisionRefSchema, { ...structuredClone(identity), fallbackSnapshotHash: await contentHash(snapshot) }, limits), fallbackSnapshot: snapshot };
}
export async function verifySource(source: FrozenSource, limits: ValidationLimits): Promise<FrozenSource> {
  const detached = structuredClone(source);
  const ref = validated(revisionRefSchema, detached.ref, limits);
  const snapshot = validated(sourceSnapshotSchema, detached.fallbackSnapshot, limits);
  if (canonicalJson(ref.stamp) !== canonicalJson(snapshot.payload.stamp)) throw new TimelineSourceError('INVALID', 'The saved source stamp does not match its revision.');
  if (await contentHash(snapshot) !== ref.fallbackSnapshotHash) throw new TimelineSourceError('HASH_MISMATCH', 'The saved source hash does not match its payload.');
  return { ref, fallbackSnapshot: snapshot };
}
export const instruction = (firstAction: string, details = '', whenReady = ''): Instructions => ({ firstAction, details, whenReady });
export async function makeAction(source: FrozenSource, context: AdapterContext, id: string, trigger: Trigger,
  text: Instructions, requirements: Requirement[] = [], critical = false): Promise<Action> {
  const input = structuredClone({ ref: source.ref, stamp: source.fallbackSnapshot.payload.stamp, context, trigger, text, requirements });
  const body = { trigger: input.trigger, instruction: input.text, requirements: input.requirements, critical, stamp: input.stamp };
  return validated(actionSchema, { schemaVersion: 1, actionId: parseId('action', id), contentHash: await contentHash(body),
    sourceRevision: input.ref, laneId: input.context.laneId, clipId: input.context.clipId, optionId: input.context.optionId, ...body }, input.context.limits);
}
export async function semanticId(prefix: string, key: unknown): Promise<ActionId> {
  return parseId('action', `${prefix}:${await contentHash(key)}`);
}
