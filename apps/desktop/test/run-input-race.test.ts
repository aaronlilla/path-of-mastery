import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input, observation } from '../src/main/run/testing/fixture.js';

test('pointer-down freezes the target while a matching log arrives; release and event replay acknowledge once', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.command('follow');
    const displayed = f.service.view()!;
    await f.service.command({ kind: 'pointerDown', commandId: 'down', gestureId: 'gesture', x: 10, y: 10, button: 'next', surface: 'instruction' });
    const log = observation(0, { kind: 'level', level: 11 });
    await f.service.observe([log]);
    assert.equal(f.service.view()!.displayed.bundleId, displayed.displayed.bundleId);
    await f.service.command({ kind: 'pointerUp', commandId: 'up', gestureId: 'gesture', x: 16, y: 10, dragged: false });
    const after = f.service.view()!;
    assert.equal(after.state.reviewed.length, 1); assert.equal(after.displayed.trigger.kind === 'level' && after.displayed.trigger.level, 11);
    await f.service.observe([log]);
    await f.service.command({ kind: 'pointerUp', commandId: 'up', gestureId: 'gesture', x: 16, y: 10, dragged: false });
    assert.deepEqual(f.service.view(), after); assert.equal(after.state.mode, 'manual');
  } finally { await f.close(); }
});

test('movement over six pixels, a drag, chrome and mismatched release never acknowledge', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input());
    for (const [i, surface, x, dragged] of [[0, 'instruction', 6.01, false], [1, 'instruction', 0, true], [2, 'chrome', 0, false]] as const) {
      await f.service.command({ kind: 'pointerDown', commandId: `down-${i}`, gestureId: `gesture-${i}`, x: 0, y: 0, button: 'next', surface });
      await f.service.command({ kind: 'pointerUp', commandId: `up-${i}`, gestureId: `gesture-${i}`, x, y: 0, dragged });
    }
    await f.service.command({ kind: 'pointerUp', commandId: 'stray', gestureId: 'other', x: 0, y: 0, dragged: false });
    assert.equal(f.service.view()!.state.reviewed.length, 0);
  } finally { await f.close(); }
});

test('250ms debounce, repeated keys, stale versions and duplicate command IDs cannot advance a second target', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); const first = f.service.view()!;
    const a = { kind: 'next', commandId: 'first', bundleId: first.displayed.bundleId, presentationVersion: first.presentationVersion };
    await f.service.command(a); await f.service.command(a);
    const second = f.service.view()!;
    const b = { kind: 'next', commandId: 'debounced', bundleId: second.displayed.bundleId, presentationVersion: second.presentationVersion };
    await f.service.command(b); assert.equal(f.service.view()!.state.reviewed.length, 1);
    f.tick(250); await f.service.command({ ...b, commandId: 'repeat', repeat: true });
    await f.service.command({ ...a, commandId: 'stale' }); assert.equal(f.service.view()!.state.reviewed.length, 1);
    await f.service.command({ ...b, commandId: 'boundary' }); assert.equal(f.service.view()!.state.reviewed.length, 2);
    await assert.rejects(f.service.command({ ...a, kind: 'back' }), /Invalid Run command/);
    await assert.rejects(f.service.command({ kind: 'back', commandId: 'first' }), /reused/);
  } finally { await f.close(); }
});

test('manual Next, Back and jump hold guide position until explicit Follow game', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); await f.command('next'); const manual = f.service.view()!;
    await f.service.observe([observation(0, { kind: 'level', level: 31 })]);
    assert.equal(f.service.view()!.displayed.bundleId, manual.displayed.bundleId);
    await f.command('back'); const back = f.service.view()!;
    await f.service.observe([observation(1, { kind: 'level', level: 35 })]);
    assert.equal(f.service.view()!.displayed.bundleId, back.displayed.bundleId); assert.equal(back.state.reviewed.length, 1);
    await f.service.command({ kind: 'jump', commandId: 'jump', bundleId: manual.displayed.bundleId });
    await f.command('follow'); assert.ok(f.service.view()!.catchUp);
    await f.service.command({ kind: 'catchUp', commandId: 'catch-up', choice: 'catch_up' });
    const target = f.service.view()!.displayed.trigger;
    assert.equal(target.kind === 'level' && target.level, 31);
    assert.equal(f.service.view()!.state.reviewed.length, 1);
  } finally { await f.close(); }
});

test('right-button release revisits history and never clears reviewed coverage', async () => {
  const f = await fixture();
  try {
    await f.service.start(await input()); const first = f.service.view()!; await f.command('next');
    await f.service.command({ kind: 'pointerDown', commandId: 'down', gestureId: 'back', x: 0, y: 0, button: 'back', surface: 'instruction' });
    await f.service.command({ kind: 'pointerUp', commandId: 'up', gestureId: 'back', x: 0, y: 0, dragged: false });
    assert.equal(f.service.view()!.displayed.bundleId, first.displayed.bundleId); assert.equal(f.service.view()!.state.reviewed.length, 1);
  } finally { await f.close(); }
});

test('jump records earlier actions as skipped and Next continues forward with critical actions still outstanding', async () => {
  const f = await fixture();
  try {
    const first = await f.service.start(await input());
    const target = first.snapshot.bundles[2]!;
    await f.service.command({ kind: 'jump', commandId: 'jump-ahead', bundleId: target.bundleId });
    const jumped = f.service.view()!;
    assert.deepEqual(jumped.state.skippedActionIds, first.snapshot.actions.slice(0, 2).map(a => a.actionId));
    assert.equal(jumped.state.reviewed.length, 0);
    assert.equal(jumped.state.outstandingActionIds.length, 4);
    await f.command('next');
    const trigger = f.service.view()!.displayed.trigger;
    assert.equal(trigger.kind === 'level' && trigger.level, 31);
    assert.equal(f.service.view()!.state.reviewed.length, 1);
  } finally { await f.close(); }
});
