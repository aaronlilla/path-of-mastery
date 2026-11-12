import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationWindowOptions, exitWhenLauncherDies, launcherPid, pidAlive } from '../src/main/automation.js';

test('normal launch keeps throttling and shows normally', () => {
  assert.deepEqual(automationWindowOptions({}), { backgroundThrottling: true, showInactive: false });
});

test('bench launch only turns throttling off', () => {
  assert.deepEqual(automationWindowOptions({ POM_BENCH_BUILD: 'x' }), { backgroundThrottling: false, showInactive: false });
});

test('automation launch parks the window off-screen, unfocused, unthrottled', () => {
  assert.deepEqual(automationWindowOptions({ POM_AUTOMATION: '1' }), { x: -20000, y: -20000, skipTaskbar: true, backgroundThrottling: false, showInactive: true });
});

test('launcher watch: not in automation mode, nothing runs', () => {
  assert.equal(exitWhenLauncherDies({ env: {}, ppid: 1, exit: () => assert.fail('exit'), isAlive: () => false }), undefined);
});

test('launcher watch: alive keeps running, dead exits once', async () => {
  let alive = true; let exits = 0;
  const t = exitWhenLauncherDies({ env: { POM_AUTOMATION: '1' }, ppid: 123, exit: () => { exits++; }, intervalMs: 5, isAlive: () => alive })!;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(exits, 0);
  alive = false;
  await new Promise((r) => setTimeout(r, 60));
  clearInterval(t);
  assert.equal(exits, 1);
});

test('launcher watch: writes the marker before exiting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-launcher-'));
  let seen = false;
  exitWhenLauncherDies({ env: { POM_AUTOMATION: '1' }, ppid: 77, markerDir: dir, intervalMs: 5, isAlive: () => false,
    exit: () => { seen = existsSync(join(dir, 'hunter-launcher-gone')); } });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(seen, 'marker existed when exit ran');
  assert.match(readFileSync(join(dir, 'hunter-launcher-gone'), 'utf8'), /^77 \d{4}-/);
  rmSync(dir, { recursive: true, force: true });
});

test('pidAlive: EPERM is alive, ESRCH is dead', () => {
  const failing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(pidAlive(1, failing('EPERM')), true);
  assert.equal(pidAlive(1, failing('ESRCH')), false);
  assert.equal(pidAlive(1, () => true), true);
});

test('launcherPid accepts only positive integers, else the parent', () => {
  assert.equal(launcherPid({ POM_LAUNCHER_PID: '4242' }, 9), 4242);
  for (const bad of ['', '0', '-5', '1.5', 'abc', undefined]) assert.equal(launcherPid({ POM_LAUNCHER_PID: bad }, 9), 9, String(bad));
});
