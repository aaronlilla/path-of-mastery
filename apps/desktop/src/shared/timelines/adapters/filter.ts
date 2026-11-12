import type { Action, FilterSnapshot, FrozenSource, LeagueStamp } from '@pom/mastery-contracts';
import { coversStage, type Stage } from '../../lootfilter/stages.js';
import type { FilterDoc } from '../../lootfilter/types.js';
import { instruction, makeAction, semanticId, TimelineSourceError, verifySource, type AdapterContext } from './common.js';

export function projectFilter(doc: FilterDoc, stages: readonly Stage[], stamp: LeagueStamp,
  capabilities: FilterSnapshot['capabilities']): FilterSnapshot {
  if (capabilities.automaticSelection) throw new TimelineSourceError('INVALID', 'Automatic in-game filter selection is unverified.');
  const handoff = capabilities.installFile ? 'Write the filter file to the game folder, then select it in game.'
    : capabilities.exportFile ? 'Export the filter file and select it in game.' : 'Select your saved filter in game. File export and installation are unavailable.';
  return { schemaVersion: 1, title: doc.name, stamp: structuredClone(stamp), capabilities: structuredClone(capabilities),
    stages: stages.map(stage => ({ stageId: stage.id, areaLevel: { start: stage.lo, endExclusive: stage.hi + 1 },
      rules: doc.rules.filter(rule => rule.enabled && coversStage(rule, stage)).map(rule => JSON.stringify(rule)),
      instruction: instruction(`Use the ${stage.id} filter stage.`, `${stage.name}\n${stage.meaning}\n${handoff}`, 'At the saved AreaLevel band.') })) };
}
export async function adaptFilter(source: FrozenSource, context: AdapterContext): Promise<Action[]> {
  context = structuredClone(context);
  const frozen = await verifySource(source, context.limits);
  if (frozen.fallbackSnapshot.kind !== 'filter') throw new TimelineSourceError('INVALID', 'A Filter lane needs a Filter source.');
  const snapshot = frozen.fallbackSnapshot.payload;
  if (snapshot.capabilities.automaticSelection) throw new TimelineSourceError('INVALID', 'Automatic in-game filter selection is unverified.');
  return Promise.all(snapshot.stages.map(async stage => makeAction(frozen, context, await semanticId('filter', stage.stageId),
    { kind: 'areaLevel', level: stage.areaLevel.start }, stage.instruction,
    [{ kind: 'areaLevel', minimum: stage.areaLevel.start, provenance: `filter:${frozen.ref.revisionId}:${stage.stageId}` }], true)));
}
