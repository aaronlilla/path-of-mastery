import type { Action, FrozenSource, StepId, Trigger } from '@pom/mastery-contracts';
import { selectedSteps } from '../../atlas/plan.js';
import { instruction, makeAction, semanticId, TimelineSourceError, verifySource, type AdapterContext } from './common.js';

export async function adaptAtlas(source: FrozenSource, context: AdapterContext, anchorId: string,
  choices: Readonly<Record<string, StepId>> = {}): Promise<Action[]> {
  context = structuredClone(context);
  choices = structuredClone(choices);
  const frozen = await verifySource(source, context.limits);
  if (frozen.fallbackSnapshot.kind !== 'atlas' || !anchorId) throw new TimelineSourceError('INVALID', 'An Atlas source needs an explicit First map anchor.');
  const plan = frozen.fallbackSnapshot.payload;
  const steps = selectedSteps(plan, choices);
  const actions: Action[] = [];
  const emit = async (key: unknown, trigger: Trigger, text: ReturnType<typeof instruction>, critical = false) => {
    actions.push(await makeAction(frozen, context, await semanticId('atlas', key), trigger, text, [], critical));
  };
  if (plan.strategy || Object.values(plan.instructions).some(Boolean)) await emit(['plan'], { kind: 'firstMap', anchorId },
    instruction(plan.instructions.firstAction || 'Review the Atlas strategy.', [plan.strategy, plan.instructions.details].filter(Boolean).join('\n'), plan.instructions.whenReady));
  let previous: string[] = [];
  let points = 0;
  for (const [index, step] of steps.entries()) {
    const trigger: Trigger = index === 0 ? { kind: 'firstMap', anchorId } : { kind: 'atlasAllocated', stepId: step.stepId, points };
    const next = new Set(step.allocatedIds), before = new Set(previous);
    const removed = previous.filter(id => !next.has(id)).sort();
    const added = step.allocatedIds.filter(id => !before.has(id)).sort();
    if (removed.length) await emit([step.stepId, 'remove'], trigger, instruction('Refund the listed Atlas nodes.', removed.join(', ')), true);
    if (added.length) await emit([step.stepId, 'add'], trigger, instruction('Allocate the listed Atlas nodes.', added.join(', ')), true);
    if (Object.keys(step.effectSelections).length) await emit([step.stepId, 'effects'], trigger,
      instruction('Select the listed Atlas effects.', JSON.stringify(step.effectSelections)), true);
    if (step.strategy || Object.values(step.instructions).some(Boolean)) await emit([step.stepId, 'instructions'], trigger,
      instruction(step.instructions.firstAction || 'Review the step strategy.', [step.strategy, step.instructions.details].filter(Boolean).join('\n'), step.instructions.whenReady));
    for (const kind of ['maps', 'favouriteMaps', 'scarabs'] as const) if (step[kind].length) await emit([step.stepId, kind], trigger,
      instruction(`Review ${kind === 'favouriteMaps' ? 'favourite maps' : kind} for this step.`, JSON.stringify(step[kind])));
    previous = step.allocatedIds;
    points = step.pointTarget;
  }
  return actions;
}
