import type { TimelineBundle, ValidationLimits } from '@pom/mastery-contracts';
import { decodePomFile, encodePomFile, optionsForDestination, preparePomSnapshot, timelinePayload,
  type ExportOptions, type PomSnapshot, type SnapshotInput } from '../atlas/codecs/pom.js';

export type TimelineExportInput = Omit<SnapshotInput, 'document'> & { bundle: TimelineBundle };
function snapshotInput(input: TimelineExportInput): SnapshotInput {
  const { bundle, ...rest } = input;
  return { ...rest, document: { kind: 'timeline', payload: bundle } };
}
export function exportTimelineFile(input: TimelineExportInput, limits: ValidationLimits, options: Omit<ExportOptions, 'destination'> = {}): string {
  return encodePomFile(snapshotInput(input), limits, optionsForDestination(options, 'file'));
}
export function importTimelineFile(text: string, limits: ValidationLimits): { bundle: TimelineBundle; snapshot: PomSnapshot } {
  const snapshot = decodePomFile(text, limits);
  return { bundle: timelinePayload(snapshot), snapshot };
}
export function prepareTimelineShare(input: TimelineExportInput, limits: ValidationLimits, options: Omit<ExportOptions, 'destination'> = {}): PomSnapshot {
  return preparePomSnapshot(snapshotInput(input), limits, optionsForDestination(options, 'hosted'));
}
