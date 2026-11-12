import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseId } from '@pom/mastery-contracts';
import { fixture, input, observation, limits } from '../src/main/run/testing/fixture.js';
import { RunStore } from '../src/main/run/store.js';
import { RunService } from '../src/main/run/service.js';
import { referenceSize, clampBounds, runWindowOptions, WindowPlacementStore, RunWindowHost, type RunNativeWindow } from '../src/main/run/window.js';
import { isRunSender, registerRunIpc } from '../src/main/run/ipc.js';
import { RunHotkeys } from '../src/main/run/hotkeys.js';
import { RunLogHost } from '../src/main/run/log.js';
import { JourneyTelemetry } from '../src/main/journey/telemetry.js';
import { LOG_PARSER_VERSION, parseLogLine } from '../src/shared/journey/logEvent.js';
import { emptyObserved, unknownBaseline, type TelemetryState } from '../src/shared/journey/telemetry.js';
import { dataset } from '@pom/mastery-contracts/fixtures';
import { instruction, makeAction } from '../src/shared/timelines/adapters/common.js';

test('Run freezes revision, actions and dependencies; no active Build or workspace is involved', async () => {
  const f = await fixture();
  try {
    const start = await input(), result = await f.service.start(start);
    start.bundle.timeline.clips[0]!.options[0]!.actions[0]!.instruction.firstAction = 'Changed after start';
    start.bundle.dependencies[0]!.snapshot.payload.title = 'Removed source';
    assert.deepEqual(f.service.view(), result); assert.equal(result.state.guideCursor.level, 1);
    assert.ok(f.documents.retainedRoots().includes(result.state.snapshotHash));
    assert.ok(f.documents.retainedRoots().includes(result.snapshot.dependencies[0]!.ref.fallbackSnapshotHash));
    assert.equal(result.snapshot.stamp.leagueId.status, 'unknown');
  } finally { await f.close(); }
});

test('identical start raises existing Run; competing replacement cannot cross a failed save barrier', async () => {
  let fail = false;
  const f = await fixture(point => { if (fail && point === 'beforeIndexCommit') throw new Error('ENOSPC'); });
  try {
    const a = await input(), first = await f.service.start(a); await f.command('next');
    assert.equal((await f.service.start(a)).snapshot.runId, first.snapshot.runId);
    const other = await input(); other.timelineRevision.revisionId = parseId('revision', '11111111-1111-4111-8111-111111111111');
    await assert.rejects(f.service.start(other), /already open/);
    fail = true; const before = f.service.view();
    await assert.rejects(f.service.start(other, 'replace'), /ENOSPC/); assert.deepEqual(f.service.view(), before);
    await assert.rejects(f.service.close(), /could not be saved/);
    const recovery = join(f.directory, 'run-recovery.json'); await f.store.exportRecovery(recovery);
    assert.equal(JSON.parse(await readFile(recovery, 'utf8')).activeRunId, first.snapshot.runId);
    fail = false; await f.service.retry();
    const replaced = await f.service.start(other, 'replace'); assert.notEqual(replaced.snapshot.runId, first.snapshot.runId);
    assert.equal(f.service.savedRuns()[0]!.state.reviewed.length, 1);
  } finally { fail = false; await f.service.retry(); await f.close(); }
});

test('failed ledger commit shows prior saved state, rejects new input and retries the pending command once', async () => {
  let fail = false;
  const f = await fixture(point => { if (fail && point === 'beforeIndexCommit') throw new Error('disk full'); });
  try {
    await f.service.start(await input()); const before = f.service.view();
    fail = true; await assert.rejects(f.command('next'), /disk full/); assert.deepEqual(f.service.view(), before);
    await assert.rejects(f.command('back'), /could not be saved/);
    fail = false; await f.service.retry(); assert.equal(f.service.view()!.state.reviewed.length, 1);
    await f.service.close();
    const service = new RunService(new RunStore(f.directory, limits), { documents: f.documents, limits });
    await service.init(); assert.equal(service.view()!.state.reviewed.length, 1); await service.close();
  } finally { await f.documents.close(); }
});

test('restart restores pinned manual/auto/pause modes and dedupe IDs; lost pointer gesture cannot acknowledge', async () => {
  for (const mode of ['manual', 'auto', 'paused'] as const) {
    const f = await fixture();
    try {
      await f.service.start(await input()); await f.command('next');
      if (mode === 'auto') await f.command('follow'); if (mode === 'paused') await f.command('pause');
      await f.service.command({ kind: 'pointerDown', commandId: 'held', gestureId: 'gesture', x: 0, y: 0, button: 'next', surface: 'instruction' });
      const before = f.service.view()!; await f.service.close();
      const service = new RunService(new RunStore(f.directory, limits), { documents: f.documents, limits });
      await service.init(); assert.deepEqual(service.view()!.snapshot, before.snapshot);
      assert.equal(service.view()!.state.mode, mode); assert.deepEqual(service.view()!.state.reviewed, before.state.reviewed);
      await service.command({ kind: 'pointerUp', commandId: 'late-up', gestureId: 'gesture', x: 0, y: 0, dragged: false });
      assert.deepEqual(service.view()!.state.reviewed, before.state.reviewed); await service.close();
    } finally { await f.documents.close(); }
  }
});

test('abrupt process death before/after SQLite commit restores only durable progress', async () => {
  for (const point of ['beforeIndexCommit', 'afterIndexCommit'] as const) {
    const f = await fixture();
    const directory = f.directory;
    await f.service.start(await input()); await f.service.close();
    const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../src/main/run/store.js')).href;
    const source = `import { RunStore } from ${JSON.stringify(moduleUrl)};
      const store = new RunStore(process.argv[1], ${JSON.stringify(limits)}, p => { if(p === ${JSON.stringify(point)}) process.exit(77); });
      const checkpoint = await store.init(); checkpoint.sessions[0].state.mode='paused'; await store.commit(checkpoint);`;
    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], { stdio: 'pipe', env: process.env });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('exit', code => code === 77 ? resolve(code) : reject(new Error(stderr || `Child exited ${code}`)));
    });
    assert.equal(status, 77);
    const store = new RunStore(directory, limits); const checkpoint = await store.init();
    assert.equal(checkpoint.sessions[0]!.state.mode, point === 'beforeIndexCommit' ? 'manual' : 'paused');
    await store.close(); await f.documents.close();
  }
});

test('pause and Details collect evidence; close reconciles catch-up without reviewing missed critical actions', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.command('follow'); await f.command('openDetails'); const first = f.service.view()!.displayed.bundleId;
    await f.service.observe([observation(0, { kind: 'level', level: 31 })]);
    assert.equal(f.service.view()!.displayed.bundleId, first); assert.equal(f.service.view()!.state.reviewed.length, 0);
    await f.command('closeDetails'); assert.ok(f.service.view()!.catchUp);
    await f.service.command({ kind: 'catchUp', commandId: 'review-missed', choice: 'review' }); assert.equal(f.service.view()!.detailsOpen, true);
    await f.command('closeDetails'); await f.service.command({ kind: 'catchUp', commandId: 'keep-position', choice: 'keep' });
    assert.equal(f.service.view()!.state.mode, 'manual'); await f.command('follow');
    await f.service.command({ kind: 'catchUp', commandId: 'catch-up', choice: 'catch_up' });
    assert.equal(f.service.view()!.state.outstandingActionIds.length, 4); assert.equal(f.service.view()!.pendingCriticalActionIds.length, 3);
    await f.command('pause'); const paused = f.service.view()!.displayed.bundleId;
    await f.service.observe([observation(1, { kind: 'level', level: 35 })]); assert.equal(f.service.view()!.displayed.bundleId, paused);
    assert.equal(f.service.view()!.state.mode, 'paused');
  } finally { await f.close(); }
});

test('Pause resumes its previous follow mode and reconciles observations without reviewing actions', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.command('follow'); await f.command('pause');
    await f.command('pause');
    await f.service.observe([observation(0, { kind: 'level', level: 31 })]);
    await f.command('resumePresentation');
    assert.equal(f.service.view()!.state.mode, 'auto');
    assert.ok(f.service.view()!.catchUp);
    assert.equal(f.service.view()!.state.reviewed.length, 0);
    await f.command('back'); await f.command('pause'); await f.command('resumePresentation');
    assert.equal(f.service.view()!.state.mode, 'manual');
  } finally { await f.close(); }
});

test('unchanged progress and cursor cannot hide a changed character context', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input());
    const observed = emptyObserved();
    observed.characterLevel = { status: 'known', value: 11, evidenceId: 'context-level' };
    const telemetry: TelemetryState = { context: { epoch: 1, selected: 'Fixture', detected: 'Fixture', state: 'confirmed', generationId: 'file-a' },
      observed, baseline: unknownBaseline(dataset().ref, 1), cursor: { generationId: 'file-a', byteOffset: 100, eventId: 'context-level' }, retiredGenerationIds: [] };
    await f.service.acceptTelemetry(telemetry); await f.command('follow');
    const before = f.service.view()!.state.guideCursor;
    telemetry.context.state = 'unknown'; telemetry.context.epoch++;
    await f.service.acceptTelemetry(telemetry);
    assert.equal(f.service.view()!.state.mode, 'manual');
    assert.deepEqual(f.service.view()!.state.guideCursor, before);
  } finally { await f.close(); }
});

test('Run again creates a fresh session on the frozen revision and rejects a repeated stale request', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.command('next'); await f.command('finish');
    const before = f.service.view()!;
    const fresh = await f.service.runAgain(before.snapshot.runId);
    assert.notEqual(fresh.snapshot.runId, before.snapshot.runId);
    assert.deepEqual(fresh.snapshot.timelineRevision, before.snapshot.timelineRevision);
    assert.deepEqual(fresh.snapshot.dependencies, before.snapshot.dependencies);
    assert.equal(fresh.state.reviewed.length, 0); assert.equal(fresh.state.guideCursor.level, 1);
    assert.equal(f.service.savedRuns()[0]!.state.reviewed.length, 1);
    await assert.rejects(f.service.runAgain(before.snapshot.runId), /Run changed/);
  } finally { await f.close(); }
});

test('edited-version diff preserves Reviewed only for identical semantic ID, content and trigger; old receipts keep their pin', async () => {
  const f = await fixture();
  try {
    const original = await input(); await f.service.start(original); await f.command('next'); await f.command('next');
    await f.service.setAccount('account-a'); await f.command('confirmFinished'); const receipt = f.service.queuedReceipts()[0]!;
    const edited = structuredClone(original), option = edited.bundle.timeline.clips[0]!.options[0]!;
    const old = option.actions[1]!;
    option.actions[1] = await makeAction(option.source, { limits, laneId: old.laneId, clipId: old.clipId, optionId: old.optionId },
      old.actionId, { kind: 'level', level: 12 }, instruction('Changed synthetic instruction.'), [], true);
    edited.timelineRevision.revisionId = parseId('revision', '11111111-1111-4111-8111-111111111111');
    edited.publishedOrigin!.revisionId = edited.timelineRevision.revisionId;
    const before = f.service.view()!, diff = await f.service.switchPreview(edited);
    assert.ok(diff.changed.includes(old.actionId)); assert.deepEqual(f.service.view(), before);
    await assert.rejects(f.service.useEditedVersion(edited, 'f'.repeat(64)), /Run changed/);
    const after = await f.service.useEditedVersion(edited, before.state.snapshotHash);
    assert.equal(after.state.reviewed.length, 1); assert.equal(after.state.reviewed[0]!.actionId, original.bundle.timeline.clips[0]!.options[0]!.actions[0]!.actionId);
    assert.deepEqual(f.service.queuedReceipts(), [receipt]); assert.equal(after.state.mode, 'manual');
    assert.equal(after.state.guideCursor.level, before.state.guideCursor.level); assert.equal(after.snapshot.runId, before.snapshot.runId);
    await f.service.close(); const service = new RunService(new RunStore(f.directory, limits), { documents: f.documents, limits });
    await service.init(); assert.deepEqual(service.view()!.state.reviewed, after.state.reviewed); await service.close();
  } finally { await f.documents.close(); }
});

test('removing the displayed action during a version switch keeps the nearest guide position', async () => {
  const f = await fixture();
  try {
    const original = await input(); await f.service.start(original); await f.command('next'); await f.command('next');
    const before = f.service.view()!, edited = structuredClone(original);
    edited.bundle.timeline.clips[0]!.options[0]!.actions.splice(2, 1);
    edited.timelineRevision.revisionId = parseId('revision', '22222222-2222-4222-8222-222222222222');
    const after = await f.service.useEditedVersion(edited, before.state.snapshotHash);
    assert.equal(after.state.guideCursor.level, 21);
    assert.equal(after.displayed.trigger.kind === 'level' && after.displayed.trigger.level, 31);
    assert.equal(after.state.reviewed.length, 2);
  } finally { await f.close(); }
});

test('window settings reject missing coordinates instead of passing malformed bounds to Electron', async () => {
  const f = await fixture();
  try {
    const placement = new WindowPlacementStore(join(f.directory, 'malformed-placement.json'));
    await assert.rejects(async () => placement.save({ bounds: { width: 960, height: 144 }, monitorId: 'primary',
      alwaysOnTop: true, size: 'standard', orientation: 'auto', textSize: 26, opacity: .95, sound: false } as Parameters<typeof placement.save>[0]), /Invalid Run window settings/);
  } finally { await f.close(); }
});

test('dragged window persists its actual monitor and resumes there', async () => {
  const f = await fixture();
  try {
    const monitors = [{ id: 'primary', name: 'Primary', primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 'left', name: 'Left', primary: false, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }];
    let bounds = { x: 0, y: 0, width: 960, height: 144 }, destroyed = false;
    const placement = new WindowPlacementStore(join(f.directory, 'drag-placement.json'));
    const native: RunNativeWindow = { webContents: { id: 7, send: () => {}, setWindowOpenHandler: () => {}, on: () => {} },
      loadURL: async () => {}, show: () => {}, focus: () => {}, isDestroyed: () => destroyed, destroy: () => { destroyed = true; },
      setAlwaysOnTop: () => {}, setBounds: value => { bounds = value; }, getBounds: () => bounds, on: () => {} };
    const host = new RunWindowHost({ create: options => { destroyed = false; bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; return native; },
      entryUrl: 'file:///run.html', preload: '/trusted/preload.cjs', monitors: () => monitors, placement,
      flush: async () => {}, closeRun: async () => {}, onError: error => { throw error; } });
    await host.open(1); bounds = { ...bounds, x: -1500 }; await host.saveBounds();
    assert.equal((await placement.load())!.monitorId, 'left');
    await host.close(); await host.open(1);
    assert.equal(bounds.x, -1500); await host.close();
  } finally { await f.close(); }
});

test('context uncertainty and respec update Game without rewinding Guide or fabricating Atlas capacity', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.command('next'); const position = f.service.view()!.state.guideCursor;
    const observed = emptyObserved(); observed.characterLevel = { status: 'known', value: 31, evidenceId: 'live-level' }; observed.observedAt = '2026-10-11T00:00:00.000Z';
    const telemetry: TelemetryState = { context: { epoch: 1, selected: 'Local synthetic character', detected: 'Local synthetic character', state: 'confirmed', generationId: 'file-a' },
      observed, baseline: unknownBaseline(dataset().ref, 1), cursor: { generationId: 'file-a', byteOffset: 100, eventId: 'live-level' }, retiredGenerationIds: [] };
    await f.service.acceptTelemetry(telemetry); assert.deepEqual(f.service.view()!.state.guideCursor, position);
    assert.equal(f.service.view()!.state.observedProgress.characterLevel.status, 'known');
    telemetry.context.state = 'unknown'; telemetry.context.epoch++; telemetry.cursor!.eventId = 'gap';
    await f.service.acceptTelemetry(telemetry); assert.equal(f.service.view()!.state.mode, 'manual');
    assert.deepEqual(f.service.view()!.state.guideCursor, position); assert.equal(f.service.view()!.state.reviewed.length, 1);
    assert.equal(f.service.view()!.state.observedProgress.atlas.earned.status, 'unknown');
  } finally { await f.close(); }
});

test('preflight rejects empty enabled content, unresolved alternatives and corrupt fallback payloads', async () => {
  const f = await fixture();
  try {
    const empty = await input([]); await assert.rejects(f.service.start(empty), /no active instructions/);
    const unresolved = await input(); unresolved.bundle.timeline.clips[0]!.selectedOptionId = null;
    await assert.rejects(f.service.start(unresolved), /Choose|choice|alternative/);
    const bad = await input(); bad.bundle.dependencies[0]!.snapshot.payload.title = 'Corrupted';
    await assert.rejects(f.service.start(bad), /hash|snapshot|payload/); assert.equal(f.service.view(), null);
  } finally { await f.close(); }
});

test('monitor clamping handles negative coordinates, detached monitors, DPI-sized work areas and oversized strips', () => {
  const monitors = [{ id: 'primary', name: 'Primary', primary: true, workArea: { x: 0, y: 0, width: 1000, height: 700 } },
    { id: 'left', name: 'Left', primary: false, workArea: { x: -1500, y: -100, width: 1500, height: 1000 } }];
  assert.deepEqual(clampBounds({ x: -1600, y: -200, width: 960, height: 144 }, monitors, 'left').bounds, { x: -1500, y: -100, width: 960, height: 144 });
  const moved = clampBounds({ x: -1400, y: 200, width: 1200, height: 800 }, [monitors[0]!], 'left');
  assert.deepEqual(moved.bounds, { x: 0, y: 0, width: 1000, height: 700 }); assert.equal(moved.rehomed, true);
  assert.deepEqual(referenceSize(1), { width: 960, height: 144 }); assert.deepEqual(referenceSize(5), { width: 960, height: 376 });
  assert.deepEqual(referenceSize(2, 'compact'), { width: 640, height: 220 }); assert.deepEqual(referenceSize(1, 'large', true), { width: 360, height: 600 });
  assert.throws(() => clampBounds({ x: NaN, y: 0, width: 1, height: 1 }, monitors), /bounds/);
});

test('separate window is sandboxed, ignores external navigation, survives main-close Keep and saves before close', async () => {
  const f = await fixture();
  try {
    const monitors = [{ id: 'primary', name: 'Primary', primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
    const calls: string[] = []; let fail = false, nav: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    const bounds = { x: 0, y: 0, width: 960, height: 144 };
    const native: RunNativeWindow = { webContents: { id: 7, send: () => {}, setWindowOpenHandler: handler => { assert.equal(handler().action, 'deny'); }, on: (_event, callback) => { nav = callback; } },
      loadURL: async () => {}, show: () => { calls.push('show'); }, focus: () => {}, isDestroyed: () => calls.includes('destroy'), destroy: () => { calls.push('destroy'); },
      setAlwaysOnTop: value => { assert.equal(value, true); }, setBounds: () => {}, getBounds: () => bounds, on: () => {} };
    let creations = 0;
    const host = new RunWindowHost({ create: options => { creations++; assert.equal('parent' in options, false); assert.deepEqual(options.webPreferences,
      { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: '/trusted/preload.cjs' }); return native; }, entryUrl: 'file:///run.html', preload: '/trusted/preload.cjs',
      monitors: () => monitors, placement: new WindowPlacementStore(join(f.directory, 'placement.json')),
      flush: async () => { calls.push('flush'); if (fail) throw new Error('save failed'); }, closeRun: async () => { calls.push('closeRun'); }, onError: () => {} });
    await Promise.all([host.open(1), host.open(1)]); assert.equal(creations, 1);
    let prevented = false; nav!({ preventDefault: () => { prevented = true; } }, 'https://untrusted.invalid'); assert.equal(prevented, true);
    await host.mainClose('keep_run_open'); assert.equal(host.senderId(), 7);
    fail = true; await assert.rejects(host.close(), /save failed/); assert.equal(host.senderId(), 7);
    fail = false; await host.close(); assert.ok(calls.indexOf('closeRun') < calls.indexOf('destroy'));
    assert.equal(host.senderId(), null); assert.equal(runWindowOptions(bounds, 'preload').alwaysOnTop, true);
  } finally { await f.close(); }
});

test('restricted IPC rejects editor/subframe senders, unknown methods, malformed commands and telemetry injection', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); let handler: ((event: unknown, input: unknown) => Promise<unknown>) | undefined;
    let openedSource = '';
    const trusted = { sender: { id: 9 }, senderFrame: { url: 'file:///run.html', parent: null } };
    const dispose = registerRunIpc({ handle: (_channel, callback) => { handler = callback; }, removeHandler: () => { handler = undefined; } }, f.service,
      { limits, isTrustedRunSender: event => isRunSender(event, 9, 'file:///run.html'), openSource: async source => { openedSource = source.ref.revisionId; } });
    assert.deepEqual(await handler!({ ...trusted, sender: { id: 8 } }, { schemaVersion: 1, method: 'view' }), { ok: false, code: 'FORBIDDEN' });
    assert.equal(isRunSender({ ...trusted, senderFrame: { ...trusted.senderFrame, parent: {} } }, 9, 'file:///run.html'), false);
    assert.deepEqual(await handler!(trusted, { schemaVersion: 1, method: 'observe' }), { ok: false, code: 'INVALID' });
    assert.deepEqual(await handler!(trusted, { schemaVersion: 1, method: 'command', command: { kind: 'jump', commandId: 'bad', bundleId: '../../../bad' } }), { ok: false, code: 'RUN_REQUEST_FAILED' });
    assert.deepEqual(await handler!(trusted, { schemaVersion: 1, method: 'view', log: 'raw' }), { ok: false, code: 'INVALID' });
    assert.equal((await handler!(trusted, { schemaVersion: 1, method: 'view' }) as { ok: boolean }).ok, true);
    assert.deepEqual(await handler!(trusted, { schemaVersion: 1, method: 'counting', enabled: 'false' }), { ok: false, code: 'INVALID' });
    assert.equal((await handler!(trusted, { schemaVersion: 1, method: 'counting', enabled: false }) as { ok: boolean }).ok, true);
    assert.equal(f.service.view()!.countRuns, false);
    assert.deepEqual(await handler!(trusted, { schemaVersion: 1, method: 'chunks', characterChunks: { kind: 'fixed', size: 3 } }), { ok: false, code: 'RUN_REQUEST_FAILED' });
    assert.deepEqual(await handler!(trusted, { schemaVersion: 1, method: 'exportRecovery', path: 'untrusted' }), { ok: false, code: 'INVALID' });
    assert.deepEqual(await handler!(trusted, { schemaVersion: 1, method: 'openSource', actionId: 'unknown-action' }), { ok: false, code: 'UNAVAILABLE' });
    const action = f.service.view()!.snapshot.actions[0]!;
    assert.equal((await handler!(trusted, { schemaVersion: 1, method: 'openSource', actionId: action.actionId }) as { ok: boolean }).ok, true);
    assert.equal(openedSource, action.sourceRevision.revisionId);
    assert.deepEqual(await handler!(trusted, { schemaVersion: 1, method: 'openSource', actionId: action.actionId, path: 'untrusted' }), { ok: false, code: 'INVALID' });
    dispose(); assert.equal(handler, undefined);
  } finally { await f.close(); }
});

test('real shared Client.txt watcher feeds durable Game observations while the manual Guide holds', async () => {
  const f = await fixture(); let telemetry: JourneyTelemetry | null = null;
  try {
    await f.service.start(await input()); await f.service.setAccount('account-a');
    let pending = Promise.resolve();
    telemetry = new JourneyTelemetry({ rules: { dataset: dataset().ref, logNodeIds: {}, costs: { status: 'unknown', reason: 'No synthetic Atlas costs are needed.' } },
      onChange: state => { pending = Promise.all([pending, f.service.acceptTelemetry(state)]).then(() => {}); void pending.catch(() => {}); },
      commit: async () => { await pending; await f.service.flush(); } });
    telemetry.useNextDetectedCharacter();
    const log = join(f.directory, 'Client.txt'); await writeFile(log, ''); await telemetry.startReading(log, 20);
    const waitForLevel = async (level: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const observed = f.service.view()!.state.observedProgress.characterLevel;
        if (observed.status === 'known' && observed.value === level) return;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.fail('The shared watcher did not commit the live level.');
    };
    const line = (level: number) => `2026/10/11 12:00:00 1 a [INFO Client 1] : SyntheticCharacter (FixtureClass) is now level ${level}\n`;
    await appendFile(log, line(11)); await waitForLevel(11); await f.command('next');
    const position = f.service.view()!.state.guideCursor;
    await appendFile(log, line(31)); await waitForLevel(31); await pending;
    assert.deepEqual(f.service.view()!.state.guideCursor, position); assert.equal(f.service.view()!.state.reviewed.length, 1);
    assert.equal(f.service.queuedReceipts().length, 1); assert.equal(f.service.queuedReceipts()[0]!.method, 'final_trigger_observed');
    const cursor = f.service.view()!.state.eventCursor;
    assert.ok(cursor?.eventId); assert.ok(cursor!.byteOffset > 0);
    await f.command('follow'); await f.command('pause');
    const controls = new RunLogHost(telemetry, f.service, async () => null);
    await controls.call({ kind: 'continueManually' });
    assert.equal(f.service.view()!.state.mode, 'manual');
    telemetry.stopReading(); await telemetry.flush(); await pending;
  } finally { telemetry?.stopReading(); await f.close(); }
});

test('global hotkeys default off, prohibit area bindings, roll back conflicts and disable immediately', async () => {
  const f = await fixture();
  try {
    const registered = new Set<string>();
    const hotkeys = new RunHotkeys({ register: key => { if (key === 'blocked') return false; registered.add(key); return true; },
      unregister: key => { registered.delete(key); }, isRegistered: key => registered.has(key) }, f.service, () => {});
    assert.equal(hotkeys.enabled, false); assert.throws(() => hotkeys.configure('Ctrl+1', 'Alt+B'), /available/);
    assert.throws(() => hotkeys.configure('Alt+N', 'blocked'), /in use/); assert.equal(registered.size, 0);
    hotkeys.configure('Alt+N', 'Alt+B'); assert.equal(hotkeys.enabled, true); hotkeys.disable(); assert.equal(registered.size, 0);
  } finally { await f.close(); }
});

test('another live store cannot open the same Run index', async () => {
  const f = await fixture();
  try { const second = new RunStore(f.directory, limits); await assert.rejects(second.init()); }
  finally { await f.close(); }
});

test('log controls switch to manual explicitly and cannot inject evidence or local file paths', async () => {
  const f = await fixture();
  const telemetry = new JourneyTelemetry({ rules: { dataset: dataset().ref, logNodeIds: {},
    costs: { status: 'unknown', reason: 'No synthetic Atlas costs are needed.' } } });
  try {
    await f.service.start(await input());
    telemetry.useNextDetectedCharacter();
    const event = parseLogLine('2026/10/11 12:00:00 1 a [INFO Client 1] : Fixture (FixtureClass) is now level 11');
    assert.ok(event);
    telemetry.observe({ fileIdentity: 'fixture-file', generationId: 'fixture-generation', byteStart: 0, byteEnd: 100,
      parserVersion: LOG_PARSER_VERSION, eventId: 'fixture-identity', origin: 'live', event });
    await f.service.acceptTelemetry(telemetry.state());
    const log = new RunLogHost(telemetry, f.service, async () => null);
    await f.command('follow'); await log.call({ kind: 'continueManually' });
    assert.equal(f.service.view()!.state.mode, 'manual');
    await f.command('follow'); await log.call({ kind: 'autoFollow', enabled: false });
    assert.equal(f.service.view()!.state.mode, 'manual');
    await assert.rejects(log.call({ kind: 'observe', event }), /Invalid Run log request/);
    await assert.rejects(log.call({ kind: 'chooseFile', path: 'untrusted' }), /Invalid Run log request/);
    const cancelled = await log.call({ kind: 'chooseFile' });
    assert.equal(cancelled.filename, null); assert.equal(cancelled.reading, false);
    await assert.rejects(log.call({ kind: 'autoFollow', enabled: true }), /Character not confirmed/);
  } finally { telemetry.stopReading(); await f.close(); }
});

test('chunk settings recalculate future windows only; presented boundaries and action identities survive restart', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input());
    const before = await f.store.load(), first = before.sessions[0]!.schedule.chunks[0]!;
    const bundles = f.service.view()!.snapshot.bundles;
    await f.service.updateFutureChunks({ kind: 'fixed', size: 4 });
    const after = await f.store.load();
    assert.deepEqual(after.sessions[0]!.schedule.chunks.find(c => c.chunkId === first.chunkId), first);
    assert.deepEqual(f.service.view()!.snapshot.bundles, bundles);
    assert.ok(after.sessions[0]!.schedule.chunks.some(c => c.coordinate === 'level' && c.window.start === 11 && c.window.endExclusive === 15));
    await f.service.close();
    const service = new RunService(new RunStore(f.directory, limits), { documents: f.documents, limits });
    await service.init(); assert.deepEqual(service.view()!.snapshot.settings.characterChunks, { kind: 'fixed', size: 4 }); await service.close();
  } finally { await f.documents.close(); }
});

test('critical actions stay outstanding after an explicit skip until Reviewed; ordinary skipped coverage remains separate', async () => {
  const f = await fixture();
  try {
    const start = await input(), option = start.bundle.timeline.clips[0]!.options[0]!, ordinary = option.actions[1]!;
    option.actions[1] = await makeAction(option.source, { limits, laneId: ordinary.laneId, clipId: ordinary.clipId, optionId: ordinary.optionId },
      ordinary.actionId, ordinary.trigger, ordinary.instruction, [], false);
    await f.service.start(start); const actionId = f.service.view()!.snapshot.actions[0]!.actionId;
    await f.service.command({ kind: 'skip', commandId: 'skip', actionIds: [actionId, ordinary.actionId] });
    assert.ok(f.service.view()!.state.outstandingActionIds.includes(actionId));
    assert.equal(f.service.view()!.state.outstandingActionIds.includes(ordinary.actionId), false);
    await f.service.command({ kind: 'review', commandId: 'review', actionIds: [actionId] });
    assert.equal(f.service.view()!.state.outstandingActionIds.includes(actionId), false); assert.equal(f.service.view()!.state.skippedActionIds.includes(actionId), false);
  } finally { await f.close(); }
});

test('level, AreaLevel and respec observations never rewrite each other or replay Reviewed actions', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.command('next'); const reviewed = f.service.view()!.state.reviewed;
    await f.service.observe([observation(0, { kind: 'level', level: 11 }), observation(1, { kind: 'areaLevel', level: 7 }),
      observation(2, { kind: 'atlasAllocated', stepId: parseId('step', 'synthetic-step'), points: 5 }),
      observation(3, { kind: 'atlasAllocated', stepId: parseId('step', 'synthetic-step'), points: 3 })]);
    const observed = f.service.view()!.state.observedProgress;
    assert.equal(observed.characterLevel.status === 'known' && observed.characterLevel.value, 11);
    assert.equal(observed.areaLevel.status === 'known' && observed.areaLevel.value, 7);
    assert.equal(observed.atlas.allocatedCount.status === 'known' && observed.atlas.allocatedCount.value, 3);
    assert.deepEqual(f.service.view()!.state.reviewed, reviewed);
    assert.equal(observed.atlas.nodeIds.status, 'unknown'); assert.equal(observed.atlas.unspent.status, 'unknown');
  } finally { await f.close(); }
});

test('restricted log controls use a native file choice, reject paths and require live selected context before auto-follow', async () => {
  const f = await fixture();
  const telemetry = new JourneyTelemetry({ rules: { dataset: dataset().ref, logNodeIds: {}, costs: { status: 'unknown', reason: 'Synthetic rules are unverified.' } } });
  try {
    await f.service.start(await input()); const host = new RunLogHost(telemetry, f.service, async () => null);
    await assert.rejects(host.call({ kind: 'chooseFile', path: 'untrusted-path' }), /Invalid/);
    await host.call({ kind: 'chooseFile' }); assert.equal(host.state().reading, false);
    await assert.rejects(host.call({ kind: 'autoFollow', enabled: true }), /not confirmed/);
    await host.call({ kind: 'useNextCharacter' }); assert.equal(host.state().telemetry.context.state, 'waiting_next');
    await assert.rejects(host.call({ kind: 'setBaseline', count: -1 }), /baseline/);
    await host.call({ kind: 'selectCharacter', name: 'SyntheticCharacter' }); assert.equal(host.state().telemetry.context.state, 'unknown');
    await host.call({ kind: 'continueManually' }); assert.equal(f.service.view()!.state.mode, 'manual');
    await host.call({ kind: 'stopReading' }); assert.equal(host.state().reading, false);
  } finally { telemetry.stopReading(); await f.close(); }
});

test('pending critical actions only count chunks the player has reached (Missed actions is 0 at the start)', async () => {
  const f = await fixture();
  try {
    const view = await f.service.start(await input());
    assert.ok(view.snapshot.actions.some(action => action.critical && !view.displayed.actionIds.includes(action.actionId)), 'fixture has a critical action in a later chunk');
    assert.equal(view.pendingCriticalActionIds.length, 0);
  } finally { await f.close(); }
});

test('jump back, observe a later level, Follow game, then Review: passed critical actions stay listed as missed', async () => {
  const f = await fixture();
  try {
    const start = await f.service.start(await input());
    const second = start.snapshot.bundles[1]!;
    await f.service.command({ kind: 'jump', commandId: 'jump-second', bundleId: second.bundleId });
    await f.service.observe([observation(0, { kind: 'level', level: 31 })]);
    await f.command('follow');
    assert.ok(f.service.view()!.catchUp, 'follow offers catch-up');
    await f.service.command({ kind: 'catchUp', commandId: 'review-it', choice: 'review' });
    const v = f.service.view()!;
    const expected = v.state.outstandingActionIds.filter(id => { const a = v.snapshot.actions.find(x => x.actionId === id)!; return a.critical && !v.displayed.actionIds.includes(id); });
    assert.ok(expected.length > 0, 'fixture has outstanding critical actions outside the shown chunk');
    assert.deepEqual([...v.pendingCriticalActionIds].sort(), [...expected].sort());
  } finally { await f.close(); }
});

test('pending critical actions follow each coordinate on its own: Atlas points and character levels do not reach each other', async () => {
  const step = parseId('step', 'synthetic-step');
  const triggers = [{ kind: 'level', level: 1 }, { kind: 'level', level: 11 }, { kind: 'atlasAllocated', stepId: step, points: 5 }, { kind: 'level', level: 80 }] as const;
  const idsOf = (v: { snapshot: { actions: { actionId: string; trigger: { kind: string } }[] }; pendingCriticalActionIds: string[] }) =>
    v.pendingCriticalActionIds.map(id => v.snapshot.actions.find(a => a.actionId === id)!.trigger).map(t => JSON.stringify(t));
  const one = async (observed: Parameters<typeof observation>[1][]) => {
    const f = await fixture();
    try {
      await f.service.start(await input([...triggers]));
      await f.service.observe(observed.map((t, i) => observation(i, t)));
      return idsOf(f.service.view()! as never);
    } finally { await f.close(); }
  };
  // Atlas 25 reached, character still level 1: the Atlas-5 step is pending, Level 11 and Level 80 are not.
  const atlasOnly = await one([{ kind: 'atlasAllocated', stepId: step, points: 25 }]);
  assert.deepEqual(atlasOnly, [JSON.stringify({ kind: 'atlasAllocated', stepId: step, points: 5 })]);
  // Level 68 reached, no Atlas count: Level 11 is pending; the Level 80 and Atlas steps are not.
  const levelOnly = await one([{ kind: 'level', level: 68 }]);
  assert.deepEqual(levelOnly, [JSON.stringify({ kind: 'level', level: 11 })]);
});

test('pending critical actions include steps skipped by a manual jump and steps confirmed by First map or Atlas, also after catch-up Review', async () => {
  const step = parseId('step', 'synthetic-step');
  const f = await fixture();
  try {
    const start = await f.service.start(await input([{ kind: 'level', level: 1 }, { kind: 'level', level: 11 }, { kind: 'level', level: 21 }, { kind: 'level', level: 31 }]));
    const last = start.snapshot.bundles.at(-1)!;
    await f.service.command({ kind: 'jump', commandId: 'jump-far', bundleId: last.bundleId });
    const v = f.service.view()!;
    const skipped = v.state.skippedActionIds.filter(id => v.snapshot.actions.find(a => a.actionId === id)!.critical && !v.displayed.actionIds.includes(id));
    assert.ok(skipped.length > 0, 'a jump skips earlier critical steps');
    for (const id of skipped) assert.ok(v.pendingCriticalActionIds.includes(id), 'skipped critical step stays pending');
  } finally { await f.close(); }
  const g = await fixture();
  try {
    await g.service.start(await input([{ kind: 'level', level: 1 }, { kind: 'firstMap', anchorId: 'first-map' }, { kind: 'atlasAllocated', stepId: step, points: 5 }] as never));
    await g.service.observe([observation(0, { kind: 'firstMap', anchorId: 'first-map' } as never), observation(1, { kind: 'atlasAllocated', stepId: step, points: 25 })]);
    const before = [...g.service.view()!.pendingCriticalActionIds];
    if (g.service.view()!.catchUp) await g.service.command({ kind: 'catchUp', commandId: 'review-atlas', choice: 'review' });
    const after = g.service.view()!.pendingCriticalActionIds;
    assert.ok(after.length >= 1, 'reached First map / Atlas requirement is still pending');
    for (const id of before) assert.ok(after.includes(id), 'Review does not drop a reached required step');
  } finally { await g.close(); }
});
