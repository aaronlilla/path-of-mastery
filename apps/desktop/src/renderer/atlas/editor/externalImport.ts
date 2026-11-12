import type { LeagueStamp, StepId, ValidationLimits } from '@pom/mastery-contracts';
import type { ExternalAllocationPreview, ImportPreview } from '../../../main/atlas/formats.js';
import { createPlan } from '../../../shared/atlas/plan.js';
import { decodeAtlasCode } from '../../../shared/atlas/codecs/external.js';
import type { AvailableData } from './session.js';
import { tr } from '../../i18n';

export function codecInput(input: string): string {
  const code = input.trim(), decoded = decodeAtlasCode(code);
  if (!decoded) return input;
  return decoded.format === 'official' ? `https://www.pathofexile.com/fullscreen-atlas-skill-tree/${code}` : `https://poeplanner.com/atlas-tree/${code}`;
}

// A selected local graph is an interpretation choice, never evidence of the source league.
export function allocationImport(result: ExternalAllocationPreview, data: AvailableData, id: StepId, input: string, now: string, limits: ValidationLimits): ImportPreview {
  if (result.nodeIds.length > limits.maxArrayLength) throw new Error(tr('atlas_editor_externalImport_2.the_input_exceeds_the_configured_size'));
  const unknown = { status: 'unknown' as const, reason: tr('atlas_editor_externalImport.the_tree_link_does_not') };
  const stamp: LeagueStamp = { leagueId: unknown, realm: unknown, mode: unknown,
    patchVersion: result.patch ? { status: 'known', value: result.patch, evidenceId: `poeplanner-tree:${result.treeVersion}` } : unknown,
    datasetVersion: result.treeVersion !== undefined ? { status: 'known', value: String(result.treeVersion), evidenceId: 'poeplanner-link' } : unknown, createdAt: now };
  const plan = createPlan(data.dataset, stamp, id, data.budget, tr('atlas_editor_externalImport.imported_atlas_plan'));
  plan.stepsById[id]!.allocatedIds = [...result.nodeIds];
  plan.stepsById[id]!.repair = result.repair ?? { missingIds: [], disconnectedIds: [] };
  return { kind: 'snapshot', sourceInput: input, snapshot: { format: 'pathofmastery', schemaVersion: 1, document: { kind: 'atlas', payload: plan }, datasets: [] },
    warnings: [{ kind: 'unknown_stamp', message: 'Source league unknown', fields: ['leagueId', 'realm', 'mode'] },
      { kind: 'compatibility_unverified', message: 'Live compatibility unverified', dataset: data.dataset },
      ...(result.repair && (result.repair.missingIds.length || result.repair.disconnectedIds.length) ? [{ kind: 'repair' as const, message: tr('atlas_editor_externalImport.missing_length_node_ids', { count: result.repair.missingIds.length }), stepId: id, ...result.repair }] : [])] };
}
