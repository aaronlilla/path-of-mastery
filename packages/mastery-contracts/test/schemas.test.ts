import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../src/index.js';
import { action, build, bundle, dataset, hash, limits, objectId, plan, postId, proposal, publishedRef, receipt, ref, revisionId, runSnapshot, runState, stamp, step, timestamp } from './fixtures/v1.js';

function passes<T>(schema: contracts.Schema<T>, value: unknown): T {
  const result = schema.parse(value, limits);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected a valid fixture.');
  return result.value;
}
function fails<T>(schema: contracts.Schema<T>, value: unknown, code = 'VALIDATION_FAILED'): void {
  const result = schema.parse(value, limits);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]!.code, code);
}

test('Unknown stamps survive a JSON round trip without acquiring active scope', () => {
  assert.deepEqual(passes(contracts.leagueStampSchema, JSON.parse(JSON.stringify(stamp()))), stamp());
  const known = stamp();
  known.leagueId = { status: 'known', value: 'fixture-league', evidenceId: 'fixture-catalog' };
  known.mode = { status: 'known', value: { economy: 'ssf', hardcore: false, ruthless: true }, evidenceId: 'fixture-catalog' };
  assert.deepEqual(passes(contracts.leagueStampSchema, known), known);
});

test('stamps reject empty attribution, missing evidence and unknown values', () => {
  for (const leagueId of [{ status: 'unknown', reason: '' }, { status: 'known', value: '', evidenceId: 'fixture' }, { status: 'known', value: 'fixture' }, { status: 'unknown', reason: 'Unknown', value: 'guessed' }]) {
    fails(contracts.leagueStampSchema, { ...stamp(), leagueId });
  }
  fails(contracts.leagueStampSchema, { ...stamp(), createdAt: '2026-02-30T00:00:00.000Z' });
});

test('revision namespaces separate listing display number, immutable ID and CAS counter', () => {
  passes(contracts.revisionRefSchema, ref());
  passes(contracts.publishedRevisionRefSchema, publishedRef());
  fails(contracts.publishedRevisionRefSchema, { revisionId, displayRevision: 1 });
  fails(contracts.revisionRefSchema, { ...ref(), revisionId: 1 });
  fails(contracts.publishedRevisionRefSchema, { ...publishedRef(), displayRevision: 0 });
  fails(contracts.publishedRevisionRefSchema, { ...publishedRef(), rowVersion: 1 });
  fails(contracts.revisionRefSchema, { ...ref(), payloadHash: 'fixture' });
});

test('identity codecs reject trailing line breaks at non-link ingress too', () => {
  assert.equal(contracts.isId('revision', `${revisionId}\n`), false);
  assert.equal(contracts.isId('hash', `${hash}\n`), false);
  assert.equal(contracts.isId('action', 'fixture-action\n'), false);
  fails(contracts.revisionRefSchema, { ...ref(), revisionId: `${revisionId}\n` });
});

test('branded namespaces are disjoint at compile time', () => {
  // @ts-expect-error Object IDs are not revision IDs.
  const wrongRevision: contracts.RevisionId = objectId;
  // @ts-expect-error Listing counters cannot be used as immutable revision IDs.
  const numericRevision: contracts.RevisionId = publishedRef().displayRevision;
  // @ts-expect-error A CAS counter is not a listing-local display revision.
  const display: contracts.DisplayRevision = 1 as contracts.RowVersion;
  assert.ok(wrongRevision && numericRevision && display);
});

test('all seven trigger coordinates remain tagged and independently validated', () => {
  const triggers: contracts.Trigger[] = [{ kind: 'level', level: 100 }, { kind: 'areaLevel', level: 123, areaId: 'fixture-area' },
    { kind: 'zone', zoneId: 'fixture-zone' }, { kind: 'quest', questId: 'fixture-quest', evidenceRequired: 'explicit_confirmation' },
    { kind: 'firstMap', anchorId: 'fixture-anchor' }, { kind: 'atlasAllocated', stepId: step().stepId, points: 123 }, { kind: 'manual', sequenceId: 'fixture-sequence', ordinal: 0 }];
  for (const trigger of triggers) assert.deepEqual(passes(contracts.triggerSchema, trigger), trigger);
  fails(contracts.triggerSchema, { kind: 'level', level: 101 });
  fails(contracts.triggerSchema, { kind: 'atlasAllocated', points: -1, stepId: step().stepId });
  fails(contracts.triggerSchema, { kind: 'quest', questId: 'fixture-quest' });
  fails(contracts.triggerSchema, { kind: 'level', level: 1, points: 1 });
});

test('Atlas preserves zero-quantity rows, Unknown prices and over-budget manual drafts', () => {
  const value = plan();
  value.stepsById['fixture-step']!.allocatedIds.push('fixture-extra-node');
  const parsed = passes(contracts.atlasPlanSchema, value);
  assert.equal(parsed.stepsById['fixture-step']!.scarabs[0]!.quantity, 0);
  assert.equal(parsed.stepsById['fixture-step']!.scarabs[0]!.price.status, 'unknown');
});

test('Atlas alternatives have one valid default and refer to existing steps', () => {
  const value = plan();
  value.sequencePositions = [{ kind: 'alternatives', positionId: 'fixture-position', alternativeGroupId: 'fixture-group', optionStepIds: [step().stepId], defaultStepId: step().stepId }];
  passes(contracts.atlasPlanSchema, value);
  const group = value.sequencePositions[0]!;
  if (group.kind !== 'alternatives') throw new Error('Expected an alternatives fixture.');
  group.defaultStepId = contracts.parseId('step', 'missing-step');
  fails(contracts.atlasPlanSchema, value);
  fails(contracts.atlasPlanSchema, { ...plan(), stepsById: {} });
});

test('instruction lengths enforce 160 and 10000 characters without silent truncation', () => {
  const value = step();
  value.instructions.firstAction = 'x'.repeat(160);
  value.instructions.details = 'x'.repeat(10000);
  passes(contracts.atlasStepSchema, value);
  value.instructions.firstAction += 'x';
  fails(contracts.atlasStepSchema, value);
  value.instructions.firstAction = 'Valid.';
  value.instructions.details += 'x';
  fails(contracts.atlasStepSchema, value);
});

test('Atlas datasets require root, adjacency and sourced cost metadata', () => {
  passes(contracts.atlasDatasetSchema, dataset());
  const value = dataset();
  value.graph.nodes[0]!.adjacentIds.push('missing-node');
  fails(contracts.atlasDatasetSchema, value);
  fails(contracts.atlasDatasetSchema, { ...dataset(), costModel: { ...dataset().costModel, nodeCosts: {} } });
});

test('proof records reject boolean certification and bind exact input and cost hashes', () => {
  passes(contracts.atlasProposalSchema, proposal());
  fails(contracts.atlasProposalSchema, { ...proposal(), proof: true });
  fails(contracts.atlasProposalSchema, { ...proposal(), inputHash: 'b'.repeat(64) });
  fails(contracts.atlasProposalSchema, { ...proposal(), cost: 1 });
});

test('frozen bundle fixture validates with every required dependency embedded', () => {
  assert.deepEqual(passes(contracts.timelineBundleSchema, bundle()), bundle());
  fails(contracts.timelineBundleSchema, { ...bundle(), dependencies: [] });
});

test('same-lane clips cannot overlap but distinct lanes may share coverage', () => {
  const value = bundle().timeline;
  const clone = structuredClone(value.clips[0]!);
  clone.clipId = contracts.parseId('clip', 'second-clip');
  clone.options[0]!.actions = [];
  value.clips.push(clone);
  value.lanes[0]!.clipIds.push(clone.clipId);
  fails(contracts.timelineSchema, value);
  const secondLane = structuredClone(value.lanes[0]!);
  secondLane.laneId = contracts.parseId('lane', 'second-lane');
  secondLane.order = 1;
  secondLane.clipIds = [clone.clipId];
  clone.laneId = secondLane.laneId;
  value.lanes[0]!.clipIds.pop();
  value.lanes.push(secondLane);
  passes(contracts.timelineSchema, value);
});

test('clip coordinates are integer half-open character levels and preserve semantic actions', () => {
  const value = bundle().timeline.clips[0]!;
  for (const range of [{ start: 0, endExclusive: 101 }, { start: 1.5, endExclusive: 10 }, { start: 2, endExclusive: 2 }, { start: 1, endExclusive: 102 }]) fails(contracts.clipSchema, { ...value, range });
  passes(contracts.clipSchema, { ...value, range: { start: 100, endExclusive: 101 } });
  value.options[0]!.actions[0]!.trigger = { kind: 'areaLevel', level: 123 };
  assert.deepEqual(passes(contracts.clipSchema, value).options[0]!.actions[0]!.trigger, { kind: 'areaLevel', level: 123 });
});

test('bundle rejects invalid choices, action context and mismatched embedded fallbacks', () => {
  fails(contracts.timelineBundleSchema, { ...bundle(), choices: [] });
  const context = bundle();
  context.timeline.clips[0]!.options[0]!.actions[0]!.sourceRevision.payloadHash = contracts.parseId('hash', 'b'.repeat(64));
  fails(contracts.timelineBundleSchema, context);
  const fallback = bundle();
  fallback.dependencies[0]!.snapshot.payload.title = 'Different snapshot';
  fails(contracts.timelineBundleSchema, fallback);
});

test('bundle detects dependency cycles independently of JavaScript object cycles', () => {
  const value = bundle();
  const second = structuredClone(value.dependencies[0]!);
  second.ref.revisionId = contracts.parseId('revision', '66666666-6666-4666-8666-666666666666');
  second.dependsOn = [ref()];
  value.dependencies[0]!.dependsOn = [structuredClone(second.ref)];
  value.dependencies.push(second);
  fails(contracts.timelineBundleSchema, value, 'CYCLIC_PAYLOAD');
});

test('bundle rejects unsupported action and bundle schema versions', () => {
  fails(contracts.timelineBundleSchema, { ...bundle(), schemaVersion: 2 }, 'UNSUPPORTED_VERSION');
  fails(contracts.timelineBundleSchema, { ...bundle(), actionSchemaVersion: 2 }, 'UNSUPPORTED_VERSION');
  const value = bundle() as unknown as Record<string, unknown>;
  value.dependencies = [value];
  fails(contracts.timelineBundleSchema, value, 'CYCLIC_PAYLOAD');
});

test('configured byte, depth, node, array and string bounds all reject payloads', () => {
  const value = bundle();
  for (const smaller of [{ maxBytes: 10 }, { maxDepth: 2 }, { maxNodes: 2 }, { maxArrayLength: 1 }, { maxStringLength: 5 }]) {
    const input = smaller.maxArrayLength ? { ...value, choices: [value.choices[0], value.choices[0]] } : value;
    const result = contracts.timelineBundleSchema.parse(input, { ...limits, ...smaller });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.issues[0]!.code, 'LIMIT_EXCEEDED');
  }
  assert.equal(contracts.timelineBundleSchema.parse(value, { ...limits, maxBytes: 0 }).ok, false);
});

test('bounded JSON rejects accessors, reserved keys, nonfinite numbers and sparse arrays', () => {
  const value = bundle();
  const accessor = Object.defineProperty({ ...value }, 'privateData', { enumerable: true, get() { throw new Error('Getter must not run.'); } });
  fails(contracts.timelineBundleSchema, accessor);
  fails(contracts.timelineBundleSchema, { ...value, extra: Infinity });
  fails(contracts.timelineBundleSchema, { ...value, extra: new Date() });
  fails(contracts.timelineBundleSchema, { ...value, extra: JSON.parse('{"__proto__":{}}') });
  fails(contracts.timelineBundleSchema, { ...value, choices: new Array(2) });
});

test('Run snapshot and ledger preserve pinned action hashes and separate observed progress', () => {
  passes(contracts.runSnapshotSchema, runSnapshot());
  const state = passes(contracts.runStateSchema, runState());
  assert.equal(state.guideCursor.level, 1);
  assert.equal(state.observedProgress.characterLevel.status, 'unknown');
  assert.equal(state.observedProgress.atlas.available.status, 'unknown');
  fails(contracts.runSnapshotSchema, { ...runSnapshot(), bundles: [{ ...runSnapshot().bundles[0], actionIds: ['missing-action'] }] });
});

test('receipts carry listing identity and minimal evidence but no local character context', () => {
  passes(contracts.completionReceiptSchema, receipt());
  for (const field of ['characterName', 'logPath', 'rawLog', 'privateNotes']) fails(contracts.completionReceiptSchema, { ...receipt(), [field]: 'Local data' });
  fails(contracts.completionReceiptSchema, { ...receipt(), method: 'player_confirmed' });
  fails(contracts.completionReceiptSchema, { ...receipt(), publishedRevision: { revisionId, displayRevision: 1 } });
});

test('network clearance and entitlement failures remain distinct with no implied Pro', () => {
  passes(contracts.entitlementDecisionSchema, { status: 'denied', code: 'ENTITLEMENT_UNAVAILABLE' });
  passes(contracts.networkClearanceSchema, { status: 'clear', clearanceId: 'fixture-clearance', expiresAt: timestamp, requestHash: hash });
  fails(contracts.entitlementDecisionSchema, { status: 'authorized' });
  const intent = { schemaVersion: 1, requestId: 'fixture-intent', idempotencyKey: 'fixture-idempotency', accountBinding: 'fixture-account', target: ref(), requestHash: hash, operation: 'publish', resumePolicy: 'once' };
  fails(contracts.pendingIntentSchema, intent);
  passes(contracts.pendingIntentSchema, { ...intent, resumePolicy: 'return_to_review' });
});

test('public resolver has a single opaque ID codec and no owner or share-token predicates', () => {
  passes(contracts.resolvePublicItemRequestSchema, { publicId: contracts.parseId('public', '11111111-1111-4111-8111-111111111111'), revision: 1 });
  fails(contracts.resolvePublicItemRequestSchema, { publicId: 'old-share-token' });
  fails(contracts.resolvePublicItemRequestSchema, { publicId: objectId, ownerId: postId });
});

test('versioned persistence envelopes and stamped collection members use independent namespaces', () => {
  passes(contracts.revisionSchema, { revisionId, parentRevisionId: null, schemaVersion: 1, payloadHash: hash, stamp: stamp() });
  passes(contracts.buildSnapshotSchema, build());
  passes(contracts.actionSchema, action());
  passes(contracts.collectionSchema, { schemaVersion: 1, objectId, title: 'Fixture collection', stamp: stamp(), members: [{ publishedRevision: publishedRef(), source: ref() }] });
});

test('document writes use expected immutable revisions and return a separate CAS counter', () => {
  const schema = contracts.documentEnvelopeSchema('atlas', contracts.atlasPlanSchema);
  const envelope = { schemaVersion: 1, objectId, kind: 'atlas', revision: { revisionId, parentRevisionId: null, schemaVersion: 1, payloadHash: hash, stamp: stamp() }, payload: plan() };
  passes(schema, envelope);
  fails(schema, { ...envelope, kind: 'timeline' });
  const writeSchema = contracts.writeDocumentRequestSchema(contracts.atlasPlanSchema);
  passes(writeSchema, { objectId, expectedRevisionId: revisionId, payload: plan(), stamp: stamp(), idempotencyKey: 'fixture-write' });
  fails(writeSchema, { objectId, expectedRevisionId: 1, payload: plan(), stamp: stamp(), idempotencyKey: 'fixture-write' });
  passes(contracts.writeDocumentResponseSchema, { revision: ref(), rowVersion: 0 });
  const response = contracts.apiResultSchema(contracts.writeDocumentResponseSchema);
  passes(response, { ok: true, value: { revision: ref(), rowVersion: 1 } });
  passes(response, { ok: false, code: 'REVISION_CONFLICT', message: 'The revision changed.' });
  fails(response, { ok: false, code: 'OK', message: 'Invalid failure.' });
});

test('local Build source freezes XML, generated guide, settings and data separately from its public projection', () => {
  passes(contracts.localBuildSourceSchema, { schemaVersion: 1, stamp: stamp(), buildXml: '<PathOfBuilding/>', guide: build().guide,
    settings: { stamp: stamp(), configuration: [] }, dataReferences: [ref()], publicSnapshot: build() });
});

test('byte limits measure UTF-8 JSON size exactly, including arrays and escaped text', () => {
  const input = [{ kind: 'paragraph', content: [{ kind: 'text', text: 'Unicode \u{1F600} with "quotes".' }] }];
  const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  assert.equal(contracts.publicRichTextSchema.parse(input, { ...limits, maxBytes: bytes }).ok, true);
  const result = contracts.publicRichTextSchema.parse(input, { ...limits, maxBytes: bytes - 1 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]!.code, 'LIMIT_EXCEEDED');
});

test('collection creation scope never retags members from another known or unknown scope', () => {
  const creation = stamp();
  creation.leagueId = { status: 'known', value: 'fixture-collection-scope', evidenceId: 'fixture-catalog' };
  const member = ref();
  const result = passes(contracts.collectionSchema, { schemaVersion: 1, objectId, title: 'Fixture collection', stamp: creation, members: [{ publishedRevision: publishedRef(), source: member }] });
  assert.equal(result.stamp.leagueId.status, 'known');
  assert.equal(result.members[0]!.source.stamp.leagueId.status, 'unknown');
});
