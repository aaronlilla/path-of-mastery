import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseId, type Trigger } from '@pom/mastery-contracts';
import { bundle, limits, publishedRef, ref } from '@pom/mastery-contracts/fixtures';
import { instruction, makeAction, pinSource } from '../../../shared/timelines/adapters/common.js';
import type { TriggerObservation } from '../../../shared/timelines/scheduler/index.js';
import { DocumentStore } from '../../documents/store.js';
import { RunService, type StartRun } from '../service.js';
import { RunStore, type RunStoreProbe } from '../store.js';

export { limits };
export async function input(triggers: Trigger[] = [1, 11, 21, 31].map(level => ({ kind: 'level', level })), published = true): Promise<StartRun> {
  const b = bundle(), clip = b.timeline.clips[0]!, option = clip.options[0]!;
  option.source = await pinSource(ref(), option.source.fallbackSnapshot, limits);
  option.actions = await Promise.all(triggers.map((trigger, i) => makeAction(option.source,
    { limits, laneId: clip.laneId, clipId: clip.clipId, optionId: option.optionId }, `test-action-${i}`, trigger,
    instruction(`Read synthetic instruction ${i}.`), [], true)));
  b.dependencies = [{ ref: option.source.ref, snapshot: option.source.fallbackSnapshot, dependsOn: [] }];
  b.timeline.editorMetadata.previewLevel = 100;
  const maps = triggers.find(trigger => trigger.kind === 'firstMap');
  if (maps?.kind === 'firstMap') b.timeline.firstMapAnchor = { anchorId: maps.anchorId, evidence: { status: 'unknown', reason: 'Synthetic fixture anchor.' } };
  return { bundle: b, timelineRevision: ref(), publishedOrigin: published ? publishedRef() : null };
}
export function observation(sequence: number, trigger: Trigger, extra: Partial<TriggerObservation> = {}): TriggerObservation {
  return { eventId: `event-${sequence}`, sequence, transitionId: `transition-${sequence}`, contextEpoch: 'synthetic-context',
    observedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, sequence)).toISOString(), trigger, method: 'log', reliable: true,
    continuous: true, selectedContext: true, ...extra };
}
export async function fixture(probe?: RunStoreProbe) {
  const directory = await mkdtemp(join(tmpdir(), 'p16-fixture-'));
  const documents = new DocumentStore(directory, { limits, schemas: {}, checkpointEvery: 2 }); await documents.init();
  let clock = Date.UTC(2026, 9, 11);
  const store = new RunStore(directory, limits, probe);
  const service = new RunService(store, { limits, documents, now: () => clock }); await service.init();
  const command = async (kind: 'next' | 'back' | 'follow' | 'pause' | 'resumePresentation' | 'openDetails' | 'closeDetails' | 'finish' | 'confirmFinished') => {
    clock += 300;
    const view = service.view()!;
    return service.command({ kind, commandId: randomUUID(), ...(kind === 'next' ? { bundleId: view.displayed.bundleId, presentationVersion: view.presentationVersion } : {}) });
  };
  return { directory, documents, store, service, command, tick: (ms = 300) => { clock += ms; }, now: () => clock,
    close: async () => { await service.close(); await documents.close(); } };
}
