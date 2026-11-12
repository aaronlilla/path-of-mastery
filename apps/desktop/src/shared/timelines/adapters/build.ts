import { parseId, type Action, type BuildSnapshot, type FrozenSource, type LeagueStamp, type Requirement, type Trigger } from '@pom/mastery-contracts';
import type { GuideBuild } from '../../leveling/guide.js';
import { offersFor } from '../../leveling/offers.js';
import type { Guide, GuideStep, LevelingData, LevelingPlan } from '../../leveling/types.js';
import { contentHash, instruction, makeAction, TimelineSourceError, verifySource, type AdapterContext } from './common.js';

export function guideInstruction(step: GuideStep) {
  switch (step.kind) {
    case 'arrive': case 'text': return instruction(step.text.length <= 160 ? step.text : 'Read the route instruction.', [step.text, ...step.notes].join('\n'));
    case 'handin': return instruction('Hand in the quest.', step.text);
    case 'quest-reward': return instruction('Take the quest reward.', `${step.quest}: ${step.take}\n${step.why}${step.alt?.length ? `\nAlternatives: ${step.alt.join(', ')}` : ''}`);
    case 'buy': return instruction('Buy the listed gems.', `${step.npc}\n${step.gems.map(gem => `${gem.name}${gem.cost ? `: ${gem.cost}` : ''}`).join('\n')}\n${step.why}`);
    case 'links': return instruction('Socket the listed gem links.', step.groups.map(group => `${group.slot}: ${group.gems.join(' + ')} (${group.colours})`).join('\n'));
    case 'swap': return instruction('Switch to the next skill.', `${step.from} -> ${step.to}${step.respec?.length ? `\nRefund passive nodes: ${step.respec.join(', ')}` : ''}`);
    case 'transfigure': return instruction('Prepare the transfigured gem.', `${step.gem}\n${step.how}`);
    case 'tree': return instruction('Allocate the next passive nodes.', `${step.specTitle}\nNodes: ${step.add.join(', ')}\n${step.notables.join(', ')}`);
    case 'lab': return instruction(`Complete ${step.which} Labyrinth.`, `Ascendancy nodes: ${step.ascend.join(', ')}\n${step.ascendNames.join(', ')}`);
    case 'gear': return instruction('Review gear for this stage.', step.lines.join('\n'));
    case 'flask': return instruction('Review the listed flasks.', step.lines.join('\n'));
  }
}
export type GuideSource = { guide: Guide; data: LevelingData; build: GuideBuild; plan: LevelingPlan };
export async function projectGuide(generated: GuideSource, stamp: LeagueStamp): Promise<BuildSnapshot['guide']> {
  const { guide, data, build, plan } = structuredClone({ guide: generated.guide, data: generated.data, build: generated.build, plan: generated.plan });
  const steps = guide.acts.flatMap(act => act.steps);
  const rows: BuildSnapshot['guide'] = [];
  const gemIds = [...new Set([...build.groups.flatMap(group => group.gemIds),
    ...plan.skills.flatMap(skill => [skill.gemId, ...skill.supports])])];
  const acquired = new Map<string, Requirement[]>();
  for (const [ordinal, step] of steps.entries()) {
    let trigger: Trigger = { kind: 'manual', sequenceId: 'guide', ordinal };
    const requirements: Requirement[] = [];
    const requireQuest = (questId: string) => { if (questId) requirements.push({ kind: 'quest', questId, evidenceRequired: 'Explicit quest completion or player confirmation' }); };
    if (step.kind === 'arrive') trigger = { kind: 'zone', zoneId: step.zoneId };
    if (step.kind === 'tree' || step.kind === 'swap' || (step.kind === 'flask' && step.level !== 0)) trigger = { kind: 'level', level: step.level };
    if (step.kind === 'links') trigger = { kind: 'level', level: step.at.level };
    if (step.kind === 'quest-reward' || step.kind === 'buy') {
      const ids = step.kind === 'quest-reward' ? [step.gemId] : step.gems.map(gem => gem.gemId);
      const offers = ids.flatMap(id => offersFor(data, id, guide.class, build.ruthless).filter(offer => offer.questId === step.questId &&
        (step.kind === 'quest-reward' ? offer.kind === 'quest' : offer.kind !== 'quest')));
      if (offers.length) requirements.push({ kind: 'level', minimum: Math.max(...offers.map(offer => offer.level)), provenance: `leveling:${data.league}:offers:${ids.join(',')}` });
      requireQuest(step.questId);
      if (step.questId) trigger = { kind: 'quest', questId: step.questId, evidenceRequired: 'Explicit quest completion or player confirmation' };
      for (const id of ids) acquired.set(id, structuredClone(requirements));
    }
    if (step.kind === 'swap' && plan.swap) {
      requirements.push({ kind: 'level', minimum: plan.swap.level, provenance: `leveling:${data.league}:plan:${plan.swap.gemId}` });
      requireQuest(plan.swap.questId);
    }
    if (step.kind === 'handin') for (const questId of step.questIds) requireQuest(questId);
    if (step.kind === 'links') for (const name of step.groups.flatMap(group => group.gems)) {
      // These are names emitted by this guide from its canonical gem IDs, not imported name aliases.
      const ids = gemIds.filter(id => data.gems[id]?.name === name);
      if (ids.length !== 1) continue;
      const id = ids[0]!;
      const saved = acquired.get(id);
      if (saved) requirements.push(...structuredClone(saved));
      else {
        const offer = offersFor(data, id, guide.class, build.ruthless)[0];
        if (offer) {
          requirements.push({ kind: 'level', minimum: offer.level, provenance: `leveling:${data.league}:offers:${id}` });
          requireQuest(offer.questId);
        }
      }
    }
    const uniqueRequirements = [...new Map(requirements.map(requirement => [JSON.stringify(requirement), requirement])).values()];
    const text = guideInstruction(step);
    if (step.kind === 'flask' && step.level === 0) text.whenReady = 'The guide has no authored character level for this action. Review manually.';
    // Keep non-arrival guidance outstanding during catch-up, including manual actions.
    const body = { trigger, requirements: uniqueRequirements, instruction: text, critical: trigger.kind !== 'zone', stamp };
    rows.push({ actionId: parseId('action', step.id), contentHash: await contentHash(body), trigger, requirements: uniqueRequirements, instruction: text });
  }
  return rows;
}
export async function adaptBuild(source: FrozenSource, context: AdapterContext): Promise<Action[]> {
  context = structuredClone(context);
  const frozen = await verifySource(source, context.limits);
  if (frozen.fallbackSnapshot.kind !== 'build') throw new TimelineSourceError('INVALID', 'A Build lane needs a Build source.');
  return Promise.all(frozen.fallbackSnapshot.payload.guide.map(row => makeAction(frozen, context, row.actionId, row.trigger,
    row.instruction, row.requirements, row.trigger.kind !== 'zone')));
}
