import type { Action, FrozenSource, Trigger } from '@pom/mastery-contracts';
import { makeAction, semanticId, TimelineSourceError, verifySource, type AdapterContext } from './common.js';

export async function adaptText(source: FrozenSource, context: AdapterContext, triggers?: readonly Trigger[]): Promise<Action[]> {
  context = structuredClone(context);
  triggers = triggers && structuredClone(triggers);
  const frozen = await verifySource(source, context.limits);
  const snapshot = frozen.fallbackSnapshot;
  if (snapshot.kind !== 'notes' && snapshot.kind !== 'checklist') throw new TimelineSourceError('INVALID', 'A text lane needs a Notes or Checklist source.');
  if (triggers && triggers.length !== snapshot.payload.instructions.length) throw new TimelineSourceError('INVALID', 'Provide one authored trigger per instruction.');
  return Promise.all(snapshot.payload.instructions.map(async (text, ordinal) => makeAction(frozen, context,
    await semanticId(snapshot.kind, ordinal), triggers?.[ordinal] ?? { kind: 'manual', sequenceId: `${snapshot.kind}:${frozen.ref.objectId}`, ordinal },
    text, [], snapshot.kind === 'checklist')));
}
