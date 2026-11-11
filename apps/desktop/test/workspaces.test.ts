import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  atlasPlanSchema, buildSnapshotSchema, filterSnapshotSchema, parseId, timelineSchema, workspaceManifestSchema,
  type AtlasPlan, type BuildSnapshot, type CopyProvenance, type FilterSnapshot, type Hash, type LeagueStamp, type RevisionRef, type Schema, type Timeline,
} from '@pom/mastery-contracts';
import { build as contractBuild, plan as contractPlan, bundle as contractBundle } from '@pom/mastery-contracts/fixtures';
import { DocumentStore } from '../src/main/documents/store.js';
import { hashBytes } from '../src/main/documents/blobs.js';
import { openDb } from '../src/main/kb/db.js';
import { WorkspaceService, type CopyAdapter, type CopyRequest, type VerifiedScope, type WorkspaceOptions } from '../src/main/workspaces/manifest.js';
import { WORKSPACE_CHANNEL, registerWorkspaceIpc } from '../src/main/workspaces/ipc.js';
import { compareData, copyStamp, identityKey, resolveData, scopeKey, type CompatibilityCatalog, type DataReference } from '../src/shared/documents/compatibility.js';

const limits = { maxBytes: 1000000, maxDepth: 40, maxNodes: 10000, maxArrayLength: 1000, maxStringLength: 100000 };
const time = '2026-10-11T00:00:00.000Z';
const hash = (value: string): Hash => hashBytes(value);
const known = <T>(value: T) => ({ status: 'known' as const, value, evidenceId: 'synthetic-fixture' });
const unknown = { status: 'unknown' as const, reason: 'Synthetic unverified fixture' };
function fixtureScope(name: string, kind: VerifiedScope['kind'] = 'temporary'): VerifiedScope {
  const key = { leagueId: name, realm: 'fixture-realm', mode: { economy: 'trade' as const, hardcore: false, ruthless: false } };
  return { key, kind, catalogRevision: hash(name), evidenceId: 'synthetic-catalog', stamp: {
    leagueId: known(name), realm: known(key.realm), mode: known(key.mode), patchVersion: known(`patch-${name}`),
    datasetVersion: known(`data-${name}`), createdAt: time,
  } };
}
const dataRef = (id: string, effect = 'original', namespace = 'fixture-node'): DataReference => ({ namespace, id, effectHash: known(hash(effect)) });
type FixturePayload = { title: string; stamp: LeagueStamp; refs: DataReference[]; provenance?: CopyProvenance };
const schema: Schema<unknown> = { parse(input) {
  if (!input || typeof input !== 'object' || !Array.isArray((input as FixturePayload).refs) || typeof (input as FixturePayload).title !== 'string') return { ok: false, issues: [{ code: 'VALIDATION_FAILED', path: '$', message: 'Invalid fixture' }] };
  return { ok: true, value: structuredClone(input) };
} };
async function fresh(settings: { initial?: VerifiedScope; flush?: () => Promise<void>; probe?: WorkspaceOptions['probe']; documentProbe?: ConstructorParameters<typeof DocumentStore>[1]['probe'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'p03-workspaces-'));
  const initial = settings.initial ?? fixtureScope('fixture-old');
  const documents = new DocumentStore(dir, { limits, schemas: { notes: schema, build: schema, atlas: schema, timeline: schema, filter: schema }, checkpointEvery: 2, probe: settings.documentProbe });
  await documents.init();
  const options: WorkspaceOptions = { limits, documents, flushDirty: settings.flush ?? (async () => {}), now: () => new Date(time), probe: settings.probe };
  const service = new WorkspaceService(dir, options);
  await service.init(initial);
  return { dir, documents, options, initial, service, cleanup: async () => { await service.close(); await documents.close(true); await rm(dir, { recursive: true, force: true }); } };
}
async function save(f: Awaited<ReturnType<typeof fresh>>, refs = [dataRef('same-id')], kind: 'notes' | 'build' | 'atlas' | 'timeline' | 'filter' = 'notes') {
  const payload: FixturePayload = { title: 'Original', stamp: structuredClone(f.initial.stamp), refs };
  return (await f.documents.write(kind, {
    objectId: parseId('object', randomUUID()), expectedRevisionId: null, payload, stamp: f.initial.stamp, idempotencyKey: randomUUID(),
  }, { label: 'Created fixture' })).revision;
}
function adapter(catalog: CompatibilityCatalog | null): CopyAdapter {
  return {
    references: payload => structuredClone((payload as FixturePayload).refs),
    catalog: async () => structuredClone(catalog),
    copy(payload, context) {
      const source = payload as FixturePayload;
      return { ...source, title: context.name, stamp: context.stamp, provenance: context.provenance,
        refs: context.mapping === null ? source.refs : [...new Map([...context.mapping.values()].filter((ref): ref is DataReference => ref !== null).map(ref => [identityKey(ref), ref])).values()],
      };
    },
  };
}
const request = (source: RevisionRef, target: VerifiedScope, dataMode: CopyRequest['dataMode'] = 'source_data'): CopyRequest => ({
  source, target: target.key, dataMode, name: 'Copy', repairs: [], idempotencyKey: randomUUID(),
});
const targetCatalog = (target: VerifiedScope, entries: DataReference[]): CompatibilityCatalog => ({ datasetVersion: target.stamp.datasetVersion, entries });

test('scope identity uses realm, league and every mode field, independent of property order', () => {
  const original = fixtureScope('a').key;
  assert.equal(scopeKey(original), scopeKey({ mode: { ruthless: false, hardcore: false, economy: 'trade' }, realm: original.realm, leagueId: original.leagueId }));
  for (const changed of [{ ...original, leagueId: 'b' }, { ...original, realm: 'other' }, ...[
    { economy: 'ssf' as const, hardcore: false, ruthless: false }, { ...original.mode, hardcore: true }, { ...original.mode, ruthless: true },
  ].map(mode => ({ ...original, mode }))]) assert.notEqual(scopeKey(original), scopeKey(changed));
});

test('fresh workspace validates the frozen manifest and persists across reopen', async () => {
  const f = await fresh();
  try {
    const before = f.service.active();
    assert.equal(workspaceManifestSchema.parse(before, limits).ok, true);
    const detached = f.service.active(); detached.activeScope.leagueId = 'mutated';
    assert.deepEqual(f.service.active(), before);
    await f.service.close();
    const reopened = new WorkspaceService(f.dir, f.options);
    await reopened.init();
    assert.deepEqual(reopened.active(), before);
    await reopened.close();
  } finally { await f.cleanup(); }
});

test('first startup without a verified catalog has an explicit blocker rather than a guessed league', async () => {
  const f = await fresh();
  const emptyDir = await mkdtemp(join(tmpdir(), 'p03-empty-'));
  const empty = new WorkspaceService(emptyDir, f.options);
  try { await assert.rejects(empty.init(), { code: 'NOT_FOUND' }); }
  finally { await empty.close(); await rm(emptyDir, { recursive: true, force: true }); await f.cleanup(); }
});

test('catalog flip drains saves, creates empty libraries and retains old objects, paths and Run bytes', async () => {
  let flushed = 0;
  const f = await fresh({ flush: async () => { flushed++; } });
  try {
    const source = await save(f);
    await f.service.enroll(f.initial.key, 'notes', source.objectId);
    await f.documents.retain({ kind: 'run', id: randomUUID() }, [source.fallbackSnapshotHash]);
    const runPath = join(f.dir, 'old-run.json');
    const runBytes = JSON.stringify({ source, progress: { cursor: 7 }, settings: { stamp: f.initial.stamp } });
    await writeFile(runPath, runBytes);
    const result = await f.service.observeCatalog({ status: 'verified', scope: fixtureScope('fixture-new') });
    assert.equal(result.status, 'switched'); assert.equal(flushed, 1);
    assert.deepEqual(Object.values(result.manifest.membership).flat(), []);
    assert.deepEqual(result.manifest.retainedScopes, [f.initial.key]);
    assert.deepEqual(f.service.manifest(f.initial.key).membership.notes, [source.objectId]);
    assert.deepEqual((await f.documents.read(source.objectId)).revision.stamp, f.initial.stamp);
    assert.equal(await readFile(runPath, 'utf8'), runBytes);
    assert.ok(f.documents.retainedRoots().includes(source.fallbackSnapshotHash));
    assert.equal((await f.service.select(f.initial.key)).activeScope.leagueId, f.initial.key.leagueId);
    assert.equal(flushed, 2);
  } finally { await f.cleanup(); }
});

test('failed dirty flush leaves active pointer, checkpoint and archive set unchanged; Retry succeeds', async () => {
  let fail = true;
  const f = await fresh({ flush: async () => { if (fail) throw new Error('fixture disk failure'); } });
  try {
    const before = f.service.active();
    await assert.rejects(f.service.observeCatalog({ status: 'verified', scope: fixtureScope('new') }), { code: 'UNSAVED' });
    assert.deepEqual(f.service.active(), before); assert.deepEqual(f.service.archives(), []);
    fail = false;
    assert.equal((await f.service.observeCatalog({ status: 'verified', scope: fixtureScope('new') })).status, 'switched');
  } finally { await f.cleanup(); }
});

test('workspace commit failure rolls back the entire staged scope; restart sees prior manifest', async () => {
  let fail = false;
  const f = await fresh({ probe: point => { if (fail && point === 'beforeWorkspaceCommit') throw new Error('fixture ENOSPC'); } });
  try {
    const before = f.service.active(); fail = true;
    await assert.rejects(f.service.observeCatalog({ status: 'verified', scope: fixtureScope('new') }), /fixture ENOSPC/);
    assert.deepEqual(f.service.active(), before); assert.deepEqual(f.service.archives(), []);
    await f.service.close(); fail = false;
    const reopened = new WorkspaceService(f.dir, f.options); await reopened.init(f.initial);
    assert.deepEqual(reopened.active(), before); await reopened.close();
  } finally { await f.cleanup(); }
});

test('explicit selection also blocks on unsaved changes and never creates an unknown scope', async () => {
  let fail = false;
  const f = await fresh({ flush: async () => { if (fail) throw new Error('unsaved'); } });
  try {
    const next = fixtureScope('new'); await f.service.createScope(next);
    const before = f.service.active(); fail = true;
    await assert.rejects(f.service.select(next.key), { code: 'UNSAVED' });
    await assert.rejects(f.service.select(fixtureScope('not-cached').key), { code: 'NOT_FOUND' });
    assert.deepEqual(f.service.active(), before);
    fail = false; await f.service.select(next.key);
    assert.deepEqual(f.service.active().activeScope, next.key);
  } finally { await f.cleanup(); }
});

test('permanent scopes remain active when a verified temporary league arrives', async () => {
  const f = await fresh({ initial: fixtureScope('fixture-permanent', 'permanent'), flush: async () => { throw new Error('must not flush a no-op'); } });
  try {
    const before = f.service.active();
    assert.equal((await f.service.observeCatalog({ status: 'verified', scope: fixtureScope('new') })).status, 'permanent_retained');
    assert.deepEqual(f.service.active(), before);
  } finally { await f.cleanup(); }
});

test('unverified, duplicate and previously retained catalogs cannot repeatedly reset active libraries', async () => {
  const f = await fresh();
  try {
    const before = f.service.active();
    assert.equal((await f.service.observeCatalog({ status: 'unverified', reason: 'offline, no verified cache' })).status, 'catalog_unverified');
    assert.equal((await f.service.observeCatalog({ status: 'verified', scope: f.initial })).status, 'unchanged');
    assert.deepEqual(f.service.active(), before);
    const next = fixtureScope('new');
    await Promise.all([f.service.observeCatalog({ status: 'verified', scope: next }), f.service.observeCatalog({ status: 'verified', scope: next })]);
    const current = f.service.active();
    assert.equal(f.service.archives().length, 1);
    assert.equal((await f.service.observeCatalog({ status: 'verified', scope: f.initial })).status, 'unchanged');
    assert.deepEqual(f.service.active(), current);
  } finally { await f.cleanup(); }
});

test('invalid catalog evidence and mismatched known scope are rejected', async () => {
  const f = await fresh();
  try {
    for (const scope of [{ ...fixtureScope('new'), evidenceId: '' }, { ...fixtureScope('new'), stamp: { ...fixtureScope('new').stamp, leagueId: unknown } }, { ...fixtureScope('new'), key: fixtureScope('other').key }]) {
      await assert.rejects(f.service.observeCatalog({ status: 'verified', scope }), { code: 'INVALID' });
    }
    assert.equal(f.service.archives().length, 0);
  } finally { await f.cleanup(); }
});

test('legacy Build/filter/Wealth inventory writes only sidecars, keeps Unknown and reuses stable IDs', async () => {
  const f = await fresh();
  try {
    const oldDir = join(f.dir, 'legacy'); await mkdir(oldDir);
    const fixtures = [
      { kind: 'build' as const, legacyId: 'folder/Build.xml', originalPath: join(oldDir, 'Build.xml'), bytes: '<PathOfBuilding><Build title="Fixture" /></PathOfBuilding>' },
      { kind: 'filter' as const, legacyId: 'f1', originalPath: join(oldDir, 'filters.json'), bytes: JSON.stringify({ version: 1, filters: [{ id: 'f1', rules: [], setup: {} }] }) },
      { kind: 'wealth' as const, legacyId: 'observations', originalPath: join(oldDir, 'wealth.json'), bytes: JSON.stringify({ observations: [{ t: time, items: {} }] }) },
    ];
    for (const fixture of fixtures) await writeFile(fixture.originalPath, fixture.bytes);
    const before = await Promise.all(fixtures.map(fixture => stat(fixture.originalPath)));
    const entries = fixtures.map(({ bytes: _bytes, ...entry }) => entry);
    const indexed = await f.service.indexLegacy(entries);
    assert.equal(indexed.length, 3); assert.equal(new Set(indexed.map(item => item.objectId)).size, 3);
    for (const item of indexed) {
      for (const field of ['leagueId', 'realm', 'mode', 'patchVersion', 'datasetVersion'] as const) assert.equal(item.stamp[field].status, 'unknown');
      assert.equal(item.storageScope, null); assert.equal(item.compatibility, 'unverified');
    }
    assert.deepEqual(await f.service.indexLegacy(entries), indexed);
    await f.service.observeCatalog({ status: 'verified', scope: fixtureScope('new') });
    assert.deepEqual(f.service.legacy(null), indexed);
    const attributed = await f.service.attributeLegacy(indexed[0]!.objectId, f.initial.key);
    assert.deepEqual(attributed.storageScope, f.initial.key); assert.deepEqual(attributed.stamp, indexed[0]!.stamp);
    assert.equal(attributed.compatibility, 'unverified'); assert.equal(f.service.legacy(null).length, 2);
    assert.deepEqual(f.service.manifest(f.initial.key).membership.build, [attributed.objectId]);
    for (let i = 0; i < fixtures.length; i++) {
      assert.equal(await readFile(fixtures[i]!.originalPath, 'utf8'), fixtures[i]!.bytes);
      assert.equal((await stat(fixtures[i]!.originalPath)).mtimeMs, before[i]!.mtimeMs);
      assert.equal(indexed[i]!.originalPath, fixtures[i]!.originalPath);
    }
    await f.service.close(); const reopened = new WorkspaceService(f.dir, f.options); await reopened.init(f.initial);
    assert.deepEqual(reopened.legacy(f.initial.key), [attributed]); await reopened.close();
  } finally { await f.cleanup(); }
});

test('stamped legacy files preserve supplied source evidence and mixed Unknown archive records', async () => {
  const f = await fresh();
  try {
    const file = join(f.dir, 'legacy-filter.json'); await writeFile(file, '{}');
    const [knownItem, unknownItem] = await f.service.indexLegacy([
      { kind: 'filter', legacyId: 'one', originalPath: file, stamp: f.initial.stamp },
      { kind: 'filter', legacyId: 'two', originalPath: file },
    ]);
    assert.deepEqual(knownItem!.stamp, f.initial.stamp); assert.deepEqual(knownItem!.storageScope, f.initial.key);
    assert.deepEqual(f.service.active().membership.filter, [knownItem!.objectId]);
    assert.equal(unknownItem!.stamp.leagueId.status, 'unknown'); assert.equal(f.service.legacy(null).length, 1);
    await assert.rejects(f.service.indexLegacy([{ kind: 'build', legacyId: 'bad', originalPath: 'relative.xml' }]), TypeError);
    assert.equal(f.service.legacy().length, 2);
  } finally { await f.cleanup(); }
});

test('membership accepts only persisted kind and scope, not Unknown or another league', async () => {
  const f = await fresh();
  try {
    const source = await save(f); const next = fixtureScope('new'); await f.service.createScope(next);
    await assert.rejects(f.service.enroll(next.key, 'notes', source.objectId), { code: 'INVALID' });
    await assert.rejects(f.service.enroll(f.initial.key, 'atlas', source.objectId), { code: 'INVALID' });
    await f.service.enroll(f.initial.key, 'notes', source.objectId); await f.service.enroll(f.initial.key, 'notes', source.objectId);
    assert.deepEqual(f.service.active().membership.notes, [source.objectId]);
  } finally { await f.cleanup(); }
});

test('ID comparison distinguishes namespaces, missing IDs, changed effects and unavailable evidence', () => {
  const refs = [dataRef('same'), dataRef('missing'), dataRef('changed'), { ...dataRef('unknown'), effectHash: unknown }, dataRef('same', 'original', 'other-namespace')];
  const catalog = targetCatalog(fixtureScope('new'), [dataRef('same'), dataRef('changed', 'changed'), dataRef('unknown')]);
  const report = compareData(refs, catalog);
  assert.deepEqual(report.rows.map(row => row.status), ['exact', 'missing', 'effect_changed', 'effect_unverified', 'missing']);
  assert.deepEqual([report.matched, report.missing, report.effectsChanged, report.effectsUnverified], [3, 2, 1, 1]);
  assert.equal(compareData(refs, null).targetAvailable, false);
  assert.equal(compareData(refs, null).effectsUnverified, refs.length);
  assert.throws(() => compareData([dataRef('same'), dataRef('same')], catalog), /unique/);
  assert.throws(() => compareData(refs, { ...catalog, entries: [dataRef('same'), dataRef('same')] }), /unique/);
});

test('target-data repairs require exact explicit decisions and never match names or namespaces', () => {
  const refs = [dataRef('missing'), dataRef('changed')]; const replacement = dataRef('replacement');
  const catalog = targetCatalog(fixtureScope('new'), [replacement, dataRef('changed', 'different')]);
  assert.throws(() => resolveData(refs, catalog, []), /Resolve each/);
  assert.throws(() => resolveData(refs, catalog, [{ source: refs[0]!, action: 'accept_effect' }]), /Resolve each/);
  const repairs = [{ source: refs[0]!, action: 'replace' as const, target: replacement }, { source: refs[1]!, action: 'accept_effect' as const }];
  assert.deepEqual([...resolveData(refs, catalog, repairs).values()], [replacement, dataRef('changed', 'different')]);
  assert.throws(() => resolveData(refs, catalog, [...repairs, repairs[0]!]), /one source ID/);
  assert.throws(() => resolveData(refs, catalog, [{ source: dataRef('not-referenced'), action: 'remove' }]), /one source ID/);
  assert.throws(() => resolveData(refs, null, []), /not available/);
});

test('source-data copy uses a new ID, source dataset and provenance, preserving source and embedded stamps', async () => {
  const f = await fresh();
  try {
    const source = await save(f); const original = await f.documents.read(source.objectId);
    const target = fixtureScope('new'); await f.service.createScope(target);
    const input = request(source, target); const copy = await f.service.copy(input, adapter(null));
    assert.notEqual(copy.objectId, source.objectId); assert.notEqual(copy.revisionId, source.revisionId);
    assert.deepEqual(copy.stamp.leagueId, target.stamp.leagueId);
    assert.deepEqual(copy.stamp.datasetVersion, source.stamp.datasetVersion);
    assert.deepEqual(copy.stamp.patchVersion, source.stamp.patchVersion);
    const copied = (await f.documents.read<FixturePayload>(copy.objectId)).payload;
    assert.deepEqual(copied.refs, (original.payload as FixturePayload).refs);
    assert.deepEqual(copied.provenance, { source, dataMode: 'source_data' });
    assert.deepEqual(copied.stamp, copy.stamp);
    assert.deepEqual(await f.documents.read(source.objectId), original);
    assert.deepEqual(f.service.manifest(target.key).membership.notes, [copy.objectId]);
    assert.equal(f.documents.history(copy.objectId).events[0]!.label, `Copy source revision ${source.revisionId}`);
    assert.deepEqual(f.service.provenance(copy.objectId), { source, dataMode: 'source_data' });
    assert.deepEqual(await f.service.copy(input, adapter(null)), copy);
    await assert.rejects(f.service.copy({ ...input, name: 'Different' }, adapter(null)), { code: 'CONFLICT' });
  } finally { await f.cleanup(); }
});

test('target-data copy blocks missing and changed IDs until explicit remove/replace/accept repairs', async () => {
  const f = await fresh();
  try {
    const refs = [dataRef('missing'), dataRef('changed')]; const source = await save(f, refs, 'atlas');
    const target = fixtureScope('new'); await f.service.createScope(target);
    const targetRefs = [dataRef('replacement'), dataRef('changed', 'new-effect')];
    const domain = adapter(targetCatalog(target, targetRefs));
    assert.deepEqual((await f.service.compatibility(source, target.key, domain)).rows.map(row => row.status), ['missing', 'effect_changed']);
    await assert.rejects(f.service.copy(request(source, target, 'target_data'), domain), /Resolve each/);
    const repaired = { ...request(source, target, 'target_data'), repairs: [
      { source: refs[0]!, action: 'replace' as const, target: targetRefs[0]! },
      { source: refs[1]!, action: 'accept_effect' as const },
    ] };
    const copied = await f.service.copy(repaired, domain);
    assert.deepEqual((await f.documents.read<FixturePayload>(copied.objectId)).payload.refs, targetRefs);
    assert.deepEqual(copied.stamp.datasetVersion, target.stamp.datasetVersion);
    const removed = await f.service.copy({ ...request(source, target, 'target_data'), repairs: refs.map(ref => ({ source: ref, action: 'remove' as const })) }, domain);
    assert.deepEqual((await f.documents.read<FixturePayload>(removed.objectId)).payload.refs, []);
    assert.deepEqual((await f.documents.read<FixturePayload>(source.objectId)).payload.refs, refs);
  } finally { await f.cleanup(); }
});

test('Unknown effects remain unverified even after an explicit target-data acceptance', async () => {
  const f = await fresh();
  try {
    const reference = { ...dataRef('unverified'), effectHash: unknown };
    const source = await save(f, [reference], 'filter'); const target = fixtureScope('new'); await f.service.createScope(target);
    const domain = adapter(targetCatalog(target, [reference]));
    await assert.rejects(f.service.copy(request(source, target, 'target_data'), domain), /Resolve each/);
    const copy = await f.service.copy({ ...request(source, target, 'target_data'), repairs: [{ source: reference, action: 'accept_effect' }] }, domain);
    assert.equal((await f.documents.read<FixturePayload>(copy.objectId)).payload.refs[0]!.effectHash.status, 'unknown');
    assert.deepEqual(copyStamp({ ...source.stamp, datasetVersion: unknown }, target.stamp, 'source_data', time).datasetVersion, unknown);
  } finally { await f.cleanup(); }
});

test('target-data mode rejects absent, unverified or incorrectly pinned datasets; offline source-data works', async () => {
  const f = await fresh();
  try {
    const source = await save(f, [], 'build'); const target = fixtureScope('new'); await f.service.createScope(target);
    for (const catalog of [null, { datasetVersion: unknown, entries: [] }, { datasetVersion: known('wrong-version'), entries: [] }]) {
      await assert.rejects(f.service.copy(request(source, target, 'target_data'), adapter(catalog)), { code: 'INVALID' });
      assert.equal((await f.service.compatibility(source, target.key, adapter(catalog))).targetAvailable, false);
    }
    const copy = await f.service.copy(request(source, target), { ...adapter(null), catalog: async () => { throw new Error('offline: must not fetch'); } });
    assert.notEqual(copy.objectId, source.objectId);
  } finally { await f.cleanup(); }
});

test('Build, Atlas, Filter and Timeline snapshots copy without retagging embedded source data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p03-contract-copy-'));
  const initial = fixtureScope('old'); const target = fixtureScope('new');
  const documents = new DocumentStore(dir, { limits, schemas: { build: buildSnapshotSchema, atlas: atlasPlanSchema, filter: filterSnapshotSchema, timeline: timelineSchema }, checkpointEvery: 2 });
  await documents.init();
  const service = new WorkspaceService(dir, { limits, documents, flushDirty: async () => {} }); await service.init(initial); await service.createScope(target);
  try {
    type Payload = BuildSnapshot | AtlasPlan | FilterSnapshot | Timeline;
    const filter: FilterSnapshot = { schemaVersion: 1, title: 'Synthetic filter', stamp: initial.stamp, stages: [], capabilities: { exportFile: true, installFile: false, automaticSelection: false } };
    const cases: { kind: 'build' | 'atlas' | 'filter' | 'timeline'; payload: Payload }[] = [
      { kind: 'build', payload: { ...contractBuild(), stamp: initial.stamp } },
      { kind: 'atlas', payload: { ...contractPlan(), stamp: initial.stamp } },
      { kind: 'filter', payload: filter },
      { kind: 'timeline', payload: { ...contractBundle().timeline, stamp: initial.stamp } },
    ];
    for (const item of cases) {
      const saved = (await documents.write(item.kind, { objectId: parseId('object', randomUUID()), expectedRevisionId: null, payload: item.payload, stamp: initial.stamp, idempotencyKey: randomUUID() }, { label: 'Created contract fixture' })).revision;
      const domain: CopyAdapter = {
        references: () => [], catalog: async () => null,
        copy: (payload, context) => ({ ...(payload as Payload), title: context.name, stamp: context.stamp }),
      };
      const copy = await service.copy(request(saved, target), domain);
      const copied = (await documents.read<Payload>(copy.objectId)).payload;
      assert.deepEqual(copied, { ...item.payload, title: 'Copy', stamp: copy.stamp });
      assert.deepEqual((await documents.read(saved.objectId)).payload, item.payload);
      assert.deepEqual(service.provenance(copy.objectId), { source: saved, dataMode: 'source_data' });
      assert.ok(service.manifest(target.key).membership[item.kind].includes(copy.objectId));
      if ('dataset' in copied) assert.deepEqual(copied.dataset, (item.payload as AtlasPlan).dataset);
      if ('clips' in copied) assert.deepEqual(copied.clips, (item.payload as Timeline).clips);
    }
  } finally { await service.close(); await documents.close(true); await rm(dir, { recursive: true, force: true }); }
});

test('copy adapter cannot ignore reviewed repairs or rewrite retained source-data identities', async () => {
  const f = await fresh();
  try {
    const source = await save(f, [dataRef('missing')], 'timeline'); const target = fixtureScope('new'); await f.service.createScope(target);
    const domain = adapter(targetCatalog(target, []));
    const ignoring = { ...domain, copy: (payload: unknown) => payload };
    await assert.rejects(f.service.copy({ ...request(source, target, 'target_data'), repairs: [{ source: dataRef('missing'), action: 'remove' }] }, ignoring), { code: 'INVALID' });
    const changing = { ...domain, copy: (payload: unknown) => ({ ...(payload as FixturePayload), refs: [dataRef('different')] }) };
    await assert.rejects(f.service.copy(request(source, target), changing), { code: 'INVALID' });
    assert.equal(f.service.manifest(target.key).membership.timeline.length, 0);
  } finally { await f.cleanup(); }
});

test('copy source pin is immutable and exact; tampered hash is rejected', async () => {
  const f = await fresh();
  try {
    const source = await save(f); const target = fixtureScope('new'); await f.service.createScope(target);
    await assert.rejects(f.service.copy(request({ ...source, payloadHash: hash('wrong') }, target), adapter(null)), { code: 'CONFLICT' });
    assert.equal(f.documents.list().length, 1);
  } finally { await f.cleanup(); }
});

test('copy membership failure leaves a recoverable committed document and retry reuses its reserved ID', async () => {
  let commits = 0; let failAt = -1;
  const f = await fresh({ probe: point => { if (point === 'beforeWorkspaceCommit' && ++commits === failAt) throw new Error('fixture membership failure'); } });
  try {
    const source = await save(f); const target = fixtureScope('new'); await f.service.createScope(target);
    const input = request(source, target); failAt = commits + 2;
    await assert.rejects(f.service.copy(input, adapter(null)), /membership failure/);
    assert.equal(f.documents.list().length, 2); assert.deepEqual(f.service.manifest(target.key).membership.notes, []);
    const newId = f.documents.list().find(item => item.objectId !== source.objectId)!.objectId;
    await f.service.close();
    const reopened = new WorkspaceService(f.dir, f.options); await reopened.init(f.initial);
    const recovered = await reopened.copy(input, adapter(null));
    assert.equal(recovered.objectId, newId); assert.equal(f.documents.list().length, 2);
    assert.deepEqual(reopened.manifest(target.key).membership.notes, [newId]);
    assert.equal(f.documents.history(newId).events.length, 1);
    await reopened.close();
  } finally { await f.cleanup(); }
});

test('failed document copy never enrolls a pending draft; exact retry succeeds', async () => {
  let fail = false;
  const f = await fresh({ documentProbe: point => { if (fail && point === 'beforeIndexCommit') throw new Error('fixture document failure'); } });
  try {
    const source = await save(f); const target = fixtureScope('new'); await f.service.createScope(target);
    const input = request(source, target); fail = true;
    await assert.rejects(f.service.copy(input, adapter(null)), { code: 'STORAGE_FAILED' });
    assert.deepEqual(f.service.manifest(target.key).membership.notes, []); assert.equal(f.documents.list().length, 1);
    await assert.rejects(f.service.select(target.key), { code: 'UNSAVED' });
    assert.deepEqual(f.service.active().activeScope, f.initial.key);
    fail = false; const copy = await f.service.copy(input, adapter(null));
    assert.deepEqual(f.service.manifest(target.key).membership.notes, [copy.objectId]); assert.equal(f.documents.list().length, 2);
  } finally { await f.cleanup(); }
});

test('reviewed copy rejects duplicate output identities even when the total count matches', async () => {
  const f = await fresh();
  try {
    const refs = [dataRef('one'), dataRef('two')]; const source = await save(f, refs); const target = fixtureScope('new');
    await f.service.createScope(target);
    const domain = adapter(targetCatalog(target, refs));
    const duplicated = { ...domain, copy: (payload: unknown) => ({ ...(payload as FixturePayload), refs: [refs[0], refs[0]] }) };
    await assert.rejects(f.service.copy(request(source, target, 'target_data'), duplicated), /unique/);
    assert.equal(f.service.manifest(target.key).membership.notes.length, 0);
  } finally { await f.cleanup(); }
});

test('copy retry returns its original revision even if the unlisted reserved document was edited', async () => {
  let commits = 0; let failAt = -1;
  const f = await fresh({ probe: point => { if (point === 'beforeWorkspaceCommit' && ++commits === failAt) throw new Error('membership failure'); } });
  try {
    const source = await save(f); const target = fixtureScope('new'); await f.service.createScope(target);
    const input = request(source, target); failAt = commits + 2;
    await assert.rejects(f.service.copy(input, adapter(null)), /membership failure/);
    const copied = f.documents.list().find(item => item.objectId !== source.objectId)!;
    const originalPin = f.documents.revisionRef(copied.objectId, copied.revisionId);
    const changed = await f.documents.read<FixturePayload>(copied.objectId);
    await f.documents.write('notes', { objectId: copied.objectId, expectedRevisionId: copied.revisionId, payload: { ...changed.payload, title: 'Later edit' }, stamp: changed.revision.stamp, idempotencyKey: randomUUID() }, { label: 'Later edit' });
    assert.deepEqual(await f.service.copy(input, adapter(null)), originalPin);
    assert.equal((await f.documents.read<FixturePayload>(copied.objectId)).payload.title, 'Later edit');
  } finally { await f.cleanup(); }
});

for (const point of ['beforeWorkspaceCommit', 'afterWorkspaceCommit'] as const) {
  test(`abrupt process exit ${point} recovers a complete old or new manifest`, async () => {
    const f = await fresh();
    try {
      const next = fixtureScope('new'); await f.service.close();
      const moduleUrl = new URL('../src/main/workspaces/manifest.js', import.meta.url).href;
      const documentsUrl = new URL('../src/main/documents/store.js', import.meta.url).href;
      const script = `import { WorkspaceService } from ${JSON.stringify(moduleUrl)};
        import { DocumentStore } from ${JSON.stringify(documentsUrl)};
        const documents = new DocumentStore(${JSON.stringify(f.dir)}, { limits: ${JSON.stringify(limits)}, schemas: {}, checkpointEvery: 2 });
        const service = new WorkspaceService(${JSON.stringify(f.dir)}, { limits: ${JSON.stringify(limits)}, documents, flushDirty: async () => {}, probe: point => { if (point === ${JSON.stringify(point)}) process.exit(17); } });
        await service.init(${JSON.stringify(f.initial)});
        await service.observeCatalog({ status: 'verified', scope: ${JSON.stringify(next)} });`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: process.env, timeout: 15000 });
      assert.equal(child.status, 17, child.stderr);
      const reopened = new WorkspaceService(f.dir, f.options); await reopened.init(f.initial);
      assert.equal(reopened.active().activeScope.leagueId, point === 'beforeWorkspaceCommit' ? f.initial.key.leagueId : next.key.leagueId);
      assert.equal(reopened.archives().length, point === 'beforeWorkspaceCommit' ? 0 : 1);
      assert.equal(workspaceManifestSchema.parse(reopened.active(), limits).ok, true);
      await reopened.close();
    } finally { await f.cleanup(); }
  });
}

test('live workspace ownership prevents another service opening the same directory', async () => {
  const f = await fresh(); const competitor = new WorkspaceService(f.dir, f.options);
  try { await assert.rejects(competitor.init(f.initial), { code: 'EADDRINUSE' }); assert.deepEqual(f.service.active().activeScope, f.initial.key); }
  finally { await competitor.close(); await f.cleanup(); }
});

test('close drains accepted writes and rejects late mutations', async () => {
  const f = await fresh();
  try {
    const next = fixtureScope('new'); const accepted = f.service.createScope(next); const closing = f.service.close();
    await assert.rejects(f.service.select(f.initial.key), { code: 'CLOSED' });
    await accepted; await closing;
    const reopened = new WorkspaceService(f.dir, f.options); await reopened.init(f.initial);
    assert.deepEqual(reopened.manifest(next.key).activeScope, next.key); await reopened.close();
  } finally { await f.cleanup(); }
});

test('IPC permits trusted bounded workspace operations and rejects catalog/path injection', async () => {
  const f = await fresh();
  type IpcResult = { ok: boolean; value?: unknown; error?: { code: string } };
  let handler!: (event: unknown, input: unknown) => Promise<IpcResult>;
  let removed = '';
  const dispose = registerWorkspaceIpc({ handle(channel, callback) { assert.equal(channel, WORKSPACE_CHANNEL); handler = async (event, input) => await callback(event, input) as IpcResult; }, removeHandler(channel) { removed = channel; } }, f.service, { limits, isTrustedSender: event => event === 'main', copyAdapter: () => adapter(null) });
  try {
    assert.deepEqual((await handler('main', { schemaVersion: 1, method: 'active' })).value, f.service.active());
    assert.equal((await handler('run', { schemaVersion: 1, method: 'active' })).error!.code, 'INVALID');
    const source = await save(f); const target = fixtureScope('new'); await f.service.createScope(target);
    const copied = await handler('main', { schemaVersion: 1, method: 'copy', request: request(source, target) });
    assert.equal(copied.ok, true);
    for (const input of [
      { schemaVersion: 2, method: 'active' }, { schemaVersion: 1, method: 'active', originalPath: 'private' },
      { schemaVersion: 1, method: 'indexLegacy', entries: [] }, { schemaVersion: 1, method: 'observeCatalog', scope: target },
      { schemaVersion: 1, method: 'select', scope: { ...target.key, displayName: 'alias' } },
      { schemaVersion: 1, method: 'select', scope: { ...target.key, mode: { ...target.key.mode, hardcore: 'false' } } },
      { schemaVersion: 1, method: 'copy', request: { ...request(source, target), payload: {} } },
      { schemaVersion: 1, method: 'copy', request: { ...request(source, target), repairs: [{ source: dataRef('same-id'), action: 'guess' }] } },
      { schemaVersion: 1, method: 'active', huge: 'x'.repeat(limits.maxStringLength + 1) },
    ]) assert.equal((await handler('main', input)).error!.code, 'INVALID');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    assert.equal((await handler('main', cyclic)).error!.code, 'INVALID');
    assert.equal((await handler('main', { schemaVersion: 1, method: 'legacy', scope: null })).ok, true);
    dispose(); assert.equal(removed, WORKSPACE_CHANNEL);
  } finally { await f.cleanup(); }
});

test('malformed persisted workspace is rejected without replacing it with a fresh default', async () => {
  const f = await fresh();
  try {
    await f.service.close();
    const db = openDb(join(f.dir, 'mastery/workspaces/index.sqlite'));
    db.run('UPDATE workspace_state SET state=? WHERE id=1', [JSON.stringify({ schemaVersion: 99 })]); db.close();
    const reopened = new WorkspaceService(f.dir, f.options);
    await assert.rejects(reopened.init(f.initial), { code: 'INVALID' });
    const read = openDb(join(f.dir, 'mastery/workspaces/index.sqlite'));
    assert.equal(JSON.parse(read.get<{ state: string }>('SELECT state FROM workspace_state')!.state).schemaVersion, 99); read.close();
    await reopened.close();
  } finally { await f.cleanup(); }
});
