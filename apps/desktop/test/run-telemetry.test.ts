import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observedProgressSchema } from '@pom/mastery-contracts';
import { dataset, limits, timestamp } from '@pom/mastery-contracts/fixtures';
import { LOG_PARSER_VERSION, parseLogLine, type LogEvent } from '../src/shared/journey/logEvent.js';
import { applyAtlasDelta, completeBaseline, manualBaseline, membershipOf, unknownBaseline, type AtlasRules } from '../src/shared/journey/telemetry.js';
import { LogReader, readLogTail, subscribeLog, type LogEnvelope } from '../src/main/journey/logReader.js';
import { JourneyTelemetry, LocalTelemetryStore } from '../src/main/journey/telemetry.js';
import { watchLog, watchZoneEntries, readClientLog } from '../src/main/lootfilter/clientLog.js';

const line = (body: string) => `2026/10/11 12:00:00 1 a [INFO Client 1] ${body}\n`;
const level = (name = 'SyntheticCharacter') => line(`: ${name} (FixtureClass) is now level 12`);
const zone = (name = 'Synthetic Zone') => line(`: You have entered ${name}.`);
const area = () => line('Generating level 7 area "fixture-map" with seed 1');
const passive = (op = 'allocated', id = 'atlas_fixture') => line(`Successfully ${op} passive skill id: ${id}, name: Synthetic node`);
function rules(): AtlasRules {
  const source = dataset();
  return { dataset: source.ref, logNodeIds: { atlas_fixture: 'fixture-node', atlas_other: 'other-node' },
    costs: { status: 'known', evidenceId: 'synthetic-cost', value: { ...source.costModel, nodeCosts: { 'fixture-node': 2, 'other-node': 3 },
      provenance: [{ sourceId: 'synthetic', sourceHash: source.ref.contentHash, field: 'cost', fetchedAt: timestamp }] } } };
}
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'p15-log-')), path = join(dir, 'Client.txt');
  writeFileSync(path, '');
  return { dir, path, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 15));
  assert.ok(predicate(), 'local watcher did not reach the expected state');
}
let offset = 0;
function envelope(event: LogEvent, overrides: Partial<LogEnvelope> = {}): LogEnvelope {
  const start = offset; offset += 100;
  return { fileIdentity: 'synthetic-file', generationId: 'synthetic-generation', byteStart: start, byteEnd: offset,
    parserVersion: LOG_PARSER_VERSION, eventId: `synthetic:${offset}`, origin: 'live', event, ...overrides };
}
const event = (text: string) => { const result = parseLogLine(text.trimEnd()); assert.ok(result); return result; };
function telemetry() {
  return new JourneyTelemetry({ rules: rules(), firstMapAreas: { status: 'known', evidenceId: 'synthetic-map-catalog', value: { 'fixture-map': 'fixture-anchor' } } });
}
function confirm(service: JourneyTelemetry) { service.useNextDetectedCharacter(); service.observe(envelope(event(level()))); }
const delta = (op: 'add' | 'remove', logNodeId = 'atlas_fixture') => ({ op, logNodeId, contextEpoch: 1, evidenceId: 'synthetic-delta', evidenceAt: timestamp });

test('byte cursors deduplicate events, checkpoint across restart and do not parse unfinished lines', async () => {
  const s = scratch();
  try {
    const reader = new LogReader(s.path); await reader.poll();
    appendFileSync(s.path, level() + zone().trimEnd());
    const first = await reader.poll(); assert.equal(first.envelopes.length, 1);
    assert.equal(first.envelopes[0]!.byteStart, 0); assert.equal(first.cursor!.byteOffset, Buffer.byteLength(level()));
    assert.equal((await reader.poll()).envelopes.length, 0);
    const restarted = new LogReader(s.path, { checkpoint: JSON.parse(JSON.stringify(first.cursor)) });
    assert.equal((await restarted.poll()).envelopes.length, 0);
    appendFileSync(s.path, '\n');
    const next = await restarted.poll(); assert.equal(next.envelopes.length, 1);
    assert.equal(next.envelopes[0]!.origin, 'replay', 'a historical partial line completed later is still historical');
    assert.equal(next.envelopes[0]!.generationId, first.envelopes[0]!.generationId);
    assert.notEqual(next.envelopes[0]!.eventId, first.envelopes[0]!.eventId);
  } finally { s.clean(); }
});

test('UTF-8 characters split across actual read batches remain intact', async () => {
  const s = scratch();
  try {
    const text = Buffer.from(zone('Synthetic 雪山'));
    const split = text.indexOf(Buffer.from('雪')) + 1;
    const reader = new LogReader(s.path, { maxBatchBytes: split }); await reader.poll();
    appendFileSync(s.path, text);
    assert.equal((await reader.poll()).envelopes.length, 0);
    const batch = await reader.poll(); assert.equal(batch.envelopes.length, 1);
    const e = batch.envelopes[0]!.event; assert.ok(e.t === 'zone'); assert.equal(e.name, 'Synthetic 雪山');
  } finally { s.clean(); }
});

test('invalid UTF-8 is a coverage gap, never a guessed character or passive identity', async () => {
  const s = scratch();
  try {
    const reader = new LogReader(s.path); await reader.poll();
    const text = Buffer.from(level()), index = text.indexOf(Buffer.from('SyntheticCharacter'));
    text[index] = 0xff; appendFileSync(s.path, text);
    const batch = await reader.poll(); assert.equal(batch.envelopes.length, 0);
    assert.ok(batch.statuses.some(s => s.kind === 'gap'));
  } finally { s.clean(); }
});

test('same-size rewrite, larger replacement and truncation change generation without replaying old content', async () => {
  const s = scratch();
  try {
    writeFileSync(s.path, zone('AAAA'));
    const reader = new LogReader(s.path); const old = (await reader.poll()).cursor!;
    writeFileSync(s.path, zone('BBBB'));
    const same = await reader.poll(); assert.ok(same.statuses.some(s => s.kind === 'gap' && s.reason === 'replacement'));
    assert.notEqual(same.cursor!.generationId, old.generationId); assert.equal(same.envelopes.length, 0);
    writeFileSync(join(s.dir, 'replacement'), zone('CCCC') + level());
    renameSync(s.path, join(s.dir, 'old')); renameSync(join(s.dir, 'replacement'), s.path);
    const larger = await reader.poll(); assert.ok(larger.statuses.some(s => s.kind === 'gap'));
    assert.notEqual(larger.cursor!.generationId, same.cursor!.generationId);
    writeFileSync(s.path, ''); const truncated = await reader.poll();
    assert.ok(truncated.statuses.some(s => s.kind === 'gap' && s.reason === 'truncation'));
    appendFileSync(s.path, zone()); assert.equal((await reader.poll()).envelopes.length, 1);
  } finally { s.clean(); }
});

test('missing file and parser-version mismatch publish gaps and require a new generation', async () => {
  const s = scratch();
  try {
    const reader = new LogReader(s.path); const checkpoint = (await reader.poll()).cursor!;
    renameSync(s.path, join(s.dir, 'missing'));
    assert.ok((await reader.poll()).statuses.some(s => s.kind === 'error'));
    renameSync(join(s.dir, 'missing'), s.path);
    assert.ok((await reader.poll()).statuses.some(s => s.kind === 'gap' && s.reason === 'inaccessible'));
    const wrong = new LogReader(s.path, { checkpoint: { ...checkpoint, parserVersion: 'unsupported' } });
    assert.ok((await wrong.poll()).statuses.some(s => s.kind === 'gap' && s.reason === 'parser_version'));
  } finally { s.clean(); }
});

test('bounded batches and oversized-line gaps recover at a newline', async () => {
  const s = scratch();
  try {
    const reader = new LogReader(s.path, { maxBatchBytes: 64, maxLineBytes: 128 }); await reader.poll();
    appendFileSync(s.path, 'x'.repeat(300) + '\n' + zone());
    let gaps = 0, events = 0;
    for (let n = 0; n < 10; n++) { const batch = await reader.poll(); gaps += batch.statuses.filter(s => s.kind === 'gap').length; events += batch.envelopes.length; }
    assert.equal(gaps, 1); assert.equal(events, 1); assert.equal((await reader.poll()).envelopes.length, 0);
  } finally { s.clean(); }
});

test('historical tail and resumed checkpoint are labelled seed/replay and cannot establish current context', async () => {
  const s = scratch();
  try {
    const reader = new LogReader(s.path); const checkpoint = (await reader.poll()).cursor!;
    appendFileSync(s.path, level() + zone().trimEnd());
    const tail = await readLogTail(s.path, 4096); assert.equal(tail.envelopes.length, 1); assert.equal(tail.envelopes[0]!.origin, 'seed');
    const restarted = new LogReader(s.path, { checkpoint }); const batch = await restarted.poll();
    assert.equal(batch.envelopes[0]!.origin, 'replay');
    const service = telemetry(); service.useNextDetectedCharacter();
    assert.equal(service.observe(tail.envelopes[0]!), false); assert.equal(service.canFollow(), false);
    assert.equal(service.observe(batch.envelopes[0]!), false); assert.equal(service.canFollow(), false);
  } finally { s.clean(); }
});

test('mid-character generic events and selecting an old name do not establish identity', () => {
  const service = telemetry(); service.selectCharacter('SyntheticCharacter');
  for (const text of [area(), zone(), passive()]) assert.equal(service.observe(envelope(event(text))), false);
  assert.equal(service.canFollow(), false); assert.equal(service.state().observed.areaLevel.status, 'unknown');
  assert.throws(() => service.setManualBaseline(5, timestamp), /not confirmed/);
  service.observe(envelope(event(level()))); assert.equal(service.canFollow(), true);
});

test('changed character pauses relevant observation; Keep waits and Switch explicitly re-establishes context', () => {
  const service = telemetry(); confirm(service); service.setManualBaseline(5, timestamp);
  service.observe(envelope(event(level('OtherSynthetic'))));
  assert.equal(service.state().context.state, 'changed'); assert.equal(service.canFollow(), false);
  assert.equal(service.state().baseline.count.status, 'unknown');
  service.resolveCharacter('keep'); assert.equal(service.canFollow(), false);
  service.observe(envelope(event(level()))); assert.equal(service.canFollow(), true);
  service.observe(envelope(event(level('OtherSynthetic')))); service.resolveCharacter('switch');
  assert.equal(service.state().context.selected, 'OtherSynthetic'); assert.equal(service.canFollow(), true);
});

test('character level, AreaLevel, sourced First-map arrival and manual declaration remain separate', () => {
  const service = telemetry(); confirm(service);
  assert.equal(service.state().observed.firstMap.status, 'unknown');
  service.observe(envelope(event(area())));
  assert.equal(service.state().observed.firstMap.status, 'unknown', 'generation is not arrival');
  service.observe(envelope(event(zone())));
  const observed = service.state().observed;
  assert.ok(observed.characterLevel.status === 'known'); assert.equal(observed.characterLevel.value, 12);
  assert.ok(observed.areaLevel.status === 'known'); assert.equal(observed.areaLevel.value, 7);
  assert.ok(observed.firstMap.status === 'known'); assert.equal(observed.firstMap.value.method, 'zone_evidence');
  assert.ok(observedProgressSchema.parse(observed, limits).ok);
  service.declareAtMaps('manual-anchor', timestamp); const firstMap = service.state().observed.firstMap;
  assert.ok(firstMap.status === 'known'); assert.equal(firstMap.value.method, 'manual_declaration');
});

test('manual count establishes no node membership; first observed transition and repeated operations are reconciled once', () => {
  const r = rules(); let baseline = manualBaseline(r.dataset, 1, 5, timestamp);
  assert.equal(membershipOf(baseline, 'fixture-node'), 'unknown'); assert.equal(baseline.nodeSet, null);
  baseline = applyAtlasDelta(baseline, r, delta('add')); assert.deepEqual(baseline.count, { status: 'known', value: 7, evidenceId: 'synthetic-delta' });
  const duplicate = applyAtlasDelta(baseline, r, delta('add')); assert.equal(duplicate, baseline);
  baseline = applyAtlasDelta(baseline, r, delta('remove')); assert.ok(baseline.count.status === 'known'); assert.equal(baseline.count.value, 5);
  assert.equal(applyAtlasDelta(baseline, r, delta('remove')), baseline);
  baseline = applyAtlasDelta(baseline, r, delta('remove', 'atlas_other')); assert.ok(baseline.count.status === 'known'); assert.equal(baseline.count.value, 2);
  assert.equal(membershipOf(baseline, 'other-node'), 'unallocated'); assert.equal(baseline.nodeSet, null);
});

test('unverified costs, unknown IDs, mismatched dataset/context and contradictory negative counts require checking', () => {
  const r = rules(), baseline = manualBaseline(r.dataset, 1, 0, timestamp);
  for (const [ruleset, d] of [
    [r, delta('remove')], [r, delta('add', 'atlas_missing')],
    [{ ...r, costs: { status: 'unknown', reason: 'Not sourced.' } }, delta('add')],
    [{ ...r, dataset: { ...r.dataset, variant: 'other' } }, delta('add')],
    [r, { ...delta('add'), contextEpoch: 2 }],
  ] as const) {
    const result = applyAtlasDelta(baseline, ruleset, d); assert.equal(result.needsChecking, true); assert.equal(result.count.status, 'unknown'); assert.equal(result.coverage, 'gap');
  }
});

test('unknown baseline retains exact observed membership without inventing count, capacity or full membership', () => {
  const r = rules(); let baseline = unknownBaseline(r.dataset, 1);
  baseline = applyAtlasDelta(baseline, r, delta('add'));
  assert.equal(baseline.count.status, 'unknown'); assert.equal(membershipOf(baseline, 'fixture-node'), 'allocated'); assert.equal(baseline.nodeSet, null);
  const service = telemetry(); confirm(service); service.observe(envelope(event(passive())));
  const atlas = service.state().observed.atlas;
  for (const field of ['available', 'unspent', 'earned', 'nodeIds'] as const) assert.equal(atlas[field].status, 'unknown');
});

test('complete snapshot supports absent membership and respec with sourced weighted costs', () => {
  const r = rules(); let baseline = completeBaseline(r, 1, ['fixture-node'], timestamp, 'synthetic-provider-context');
  assert.equal(membershipOf(baseline, 'other-node'), 'unallocated');
  assert.equal(applyAtlasDelta(baseline, r, delta('add')), baseline);
  baseline = applyAtlasDelta(baseline, r, delta('add', 'atlas_other'));
  baseline = applyAtlasDelta(baseline, r, delta('remove')); assert.deepEqual(baseline.nodeSet, ['other-node']);
  assert.ok(baseline.count.status === 'known'); assert.equal(baseline.count.value, 3);
});

test('byte/generation dedupe, rebaseline and respec do not replay a committed operation', () => {
  const service = telemetry(); confirm(service); service.setManualBaseline(5, timestamp);
  const add = envelope(event(passive())); service.observe(add); assert.equal(service.observe(add), false);
  service.setManualBaseline(7, timestamp); assert.equal(service.observe(add), false);
  service.observe(envelope(event(passive('unallocated'))));
  const baseline = service.state().baseline; assert.ok(baseline.count.status === 'known'); assert.equal(baseline.count.value, 5);
  service.observe(envelope(event(passive()), { generationId: 'replacement' }));
  assert.equal(service.canFollow(), false); assert.equal(service.state().baseline.count.status, 'unknown');
});

test('an Atlas-only mapping problem pauses Atlas while reliable character observations continue', () => {
  const service = telemetry(); confirm(service); service.setManualBaseline(5, timestamp);
  service.observe(envelope(event(passive('allocated', 'atlas_missing'))));
  assert.equal(service.canFollow(), true); assert.equal(service.canFollowAtlas(), false);
  service.onStatus({ kind: 'gap', reason: 'truncation' }); assert.equal(service.canFollow(), false);
});

test('restored local cursor/state do not carry a previous session identity into new live generic events', () => {
  const original = telemetry(); confirm(original); original.setManualBaseline(5, timestamp);
  const restored = new JourneyTelemetry({ rules: rules() }, { state: original.state(), cursor: original.checkpoint() });
  assert.equal(restored.canFollow(), false); assert.equal(restored.observe(envelope(event(passive()))), false);
});

test('real shared watcher serves old Journey/filter/Leveling wrappers and persists a local telemetry checkpoint', async () => {
  const s = scratch(), journey: string[] = [], zones: string[] = [];
  const old = watchLog(s.path, e => journey.push(e.t), 20), filter = watchZoneEntries(s.path, name => zones.push(name), 20);
  let persisted = '';
  const service = new JourneyTelemetry({ rules: rules(), commit: async (state, cursor) => { persisted = JSON.stringify({ state, cursor }); } });
  try {
    service.useNextDetectedCharacter(); await service.startReading(s.path, 20);
    await new Promise(r => setTimeout(r, 60));
    appendFileSync(s.path, level()); await until(() => service.canFollow()); service.setManualBaseline(5, timestamp);
    appendFileSync(s.path, area() + zone() + passive());
    await until(() => journey.length === 4 && zones.length === 1 && persisted.includes('fixture-node'));
    const current = service.state().baseline.count; assert.ok(current.status === 'known'); assert.equal(current.value, 7);
    const local = JSON.parse(persisted); assert.ok(local.cursor.byteOffset > 0); assert.ok(local.cursor.generationId);
    const historical = await readClientLog(s.path); assert.equal(historical.areas[0]!.name, 'Synthetic Zone');
    service.stopReading(); appendFileSync(s.path, zone('Still reading'));
    await until(() => zones.length === 2); assert.equal(service.canFollow(), false);
    assert.deepEqual(journey.slice(0, 4), ['level', 'area', 'zone', 'passive']);
  } finally { service.stopReading(); old.stop(); filter.stop(); await service.flush(); s.clean(); }
});

test('failed local persistence stops only telemetry and retains its last committed cursor', async () => {
  const s = scratch(); let fail = false, commits = 0; const other: string[] = [];
  const wrapper = watchLog(s.path, e => other.push(e.t), 20);
  const service = new JourneyTelemetry({ rules: rules(), commit: async () => { commits++; if (fail) throw new Error('Synthetic disk full.'); } });
  try {
    service.useNextDetectedCharacter(); await service.startReading(s.path, 20); await until(() => commits > 0);
    const previous = service.checkpoint(); fail = true; appendFileSync(s.path, level());
    await until(() => other.length === 1 && !service.canFollow());
    assert.deepEqual(service.checkpoint(), previous); assert.equal(service.canFollow(), false);
    appendFileSync(s.path, zone()); await until(() => other.length === 2);
  } finally { fail = false; service.stopReading(); wrapper.stop(); await service.flush(); s.clean(); }
});

test('a late consumer with an unavailable checkpoint is told about lost coverage', async () => {
  const s = scratch(); let gap = false;
  const first = subscribeLog(s.path, () => undefined, { intervalMs: 20 }); await first.ready;
  const previous = new LogReader(s.path); const checkpoint = (await previous.poll()).cursor!;
  appendFileSync(s.path, level()); await new Promise(r => setTimeout(r, 60));
  const late = subscribeLog(s.path, batch => { gap ||= batch.statuses.some(s => s.kind === 'gap' && s.reason === 'consumer_gap'); }, { checkpoint });
  try { await late.ready; assert.equal(gap, true); } finally { late.stop(); first.stop(); s.clean(); }
});

test('the runtime contains no network transport or second log-line parser', () => {
  for (const path of ['src/main/journey/logReader.ts', 'src/main/journey/telemetry.ts', 'src/shared/journey/telemetry.ts']) {
    const source = readFileSync(join(process.cwd(), 'apps/desktop', path), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|analytics|JevNoul/);
  }
});

test('rewriting buffered partial bytes before a larger append marks a generation gap', async () => {
  const s = scratch();
  try {
    const reader = new LogReader(s.path); await reader.poll();
    appendFileSync(s.path, zone('AAAA').trimEnd()); await reader.poll();
    writeFileSync(s.path, zone('BBBB') + level());
    const batch = await reader.poll();
    assert.ok(batch.statuses.some(s => s.kind === 'gap' && s.reason === 'replacement'));
    assert.equal(batch.envelopes.length, 0);
  } finally { s.clean(); }
});

test('late events from a retired generation cannot re-establish selected context', () => {
  const service = telemetry(); confirm(service);
  service.observe(envelope(event(level()), { generationId: 'next-generation' }));
  service.observe(envelope(event(level('OtherSynthetic')), { generationId: 'synthetic-generation' }));
  assert.equal(service.state().context.selected, 'SyntheticCharacter');
  assert.equal(service.canFollow(), true);
  assert.equal(service.state().cursor!.generationId, 'next-generation');
});

test('a gap inside a batch cannot reuse identity from before the gap', async () => {
  const s = scratch();
  const hub = subscribeLog(s.path, () => undefined, { intervalMs: 20, maxLineBytes: 128, maxBatchBytes: 4096 }); await hub.ready;
  let commits = 0;
  const service = new JourneyTelemetry({ rules: rules(), commit: async () => { commits++; } });
  try {
    confirm(service); await service.startReading(s.path, 20);
    const before = commits; appendFileSync(s.path, level() + 'x'.repeat(200) + '\n' + passive());
    await until(() => commits > before);
    assert.equal(service.canFollow(), false); assert.equal(service.state().baseline.count.status, 'unknown');
  } finally { service.stopReading(); hub.stop(); await service.flush(); s.clean(); }
});

test('local store atomically persists state with its committed cursor and restores without trusting old context', async () => {
  const s = scratch(), statePath = join(s.dir, 'telemetry.json');
  const store = new LocalTelemetryStore(statePath, limits);
  const service = new JourneyTelemetry({ rules: rules(), commit: (state, cursor) => store.commit(state, cursor) });
  try {
    assert.equal(await store.load(), null);
    service.useNextDetectedCharacter(); await service.startReading(s.path, 20);
    appendFileSync(s.path, level()); await until(() => service.canFollow());
    service.setManualBaseline(5, timestamp); await service.flush();
    const saved = await store.load(); assert.ok(saved); assert.ok(saved.cursor);
    assert.deepEqual(saved.state, service.state());
    service.stopReading();
    const resumed = new JourneyTelemetry({ rules: rules() }, saved);
    assert.equal(resumed.canFollow(), false); assert.deepEqual(resumed.checkpoint(), saved.cursor);
    await resumed.startReading(s.path, 20); assert.equal(resumed.canFollow(), false);
    resumed.stopReading(); await resumed.flush();
    writeFileSync(statePath, '{"schemaVersion":2}'); await assert.rejects(store.load(), /Invalid/);
  } finally { service.stopReading(); await service.flush(); s.clean(); }
});

test('local checkpoint byte limits preserve the prior durable state on a refused write', async () => {
  const s = scratch(), statePath = join(s.dir, 'telemetry.json');
  const service = telemetry(); confirm(service);
  try {
    const store = new LocalTelemetryStore(statePath, limits); await store.commit(service.state(), null);
    const before = readFileSync(statePath, 'utf8');
    const limited = new LocalTelemetryStore(statePath, { ...limits, maxBytes: 1 });
    await assert.rejects(limited.commit(service.state(), null), /Invalid|byte limit/);
    assert.equal(readFileSync(statePath, 'utf8'), before);
  } finally { s.clean(); }
});
