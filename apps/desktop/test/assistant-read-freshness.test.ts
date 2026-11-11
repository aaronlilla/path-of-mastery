import { fixture } from '../src/main/aiGate/fixtures.js';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { AssistantService } from '../src/main/assistant/service.js';
import { ReadOnce } from '../src/main/assistant/readOnce.js';
import { runViaApp, setPlanRunner } from '../src/main/assistant/planTools.js';
import { askFor, turnAsk } from '../src/main/assistant/tools.js';

// Smaller assistant bugs, one test each.

test('a read is fresh again when the build state differs (Undo, player edits), not only after an app apply', () => {
  const r = new ReadOnce();
  r.note('t1', 'getItems', {}, 'rk1', 'xml-A');
  assert.ok(r.repeat('t1', 'getItems', {}, 'xml-A'), 'same state: repeat note');
  assert.equal(r.repeat('t1', 'getItems', {}, 'xml-B'), null, 'build changed without an app apply');
});

test('an outside MCP client never runs through the panel runner or reads the panel ask', async () => {
  let calls = 0;
  setPlanRunner(async () => { calls++; return { listings: [] }; });
  turnAsk.text = 'I do not care about suppression, trade-off is fine';
  assert.equal(await runViaApp({ origin: 'external' } as never, 'searchTrade', {}), null);
  assert.equal(calls, 0, 'panel runner untouched');
  assert.ok(await runViaApp({ origin: 'panel' } as never, 'searchTrade', {}), 'panel still runs');
  assert.equal(askFor({ origin: 'external' } as never).allowsSuppressionLoss(), false);
  assert.equal(askFor({ origin: 'panel' } as never).allowsSuppressionLoss(), true);
  setPlanRunner(null);
});

test('per-turn memory is empty after the turn ends', () => {
  const svc = new AssistantService({ ...fixture().deps, dataDir: join(tmpdir(), 'pom-review-minor'), version: 'test', bridgePath: 'unused' } as never);
  const s = svc as any;
  s.reads.note('t1', 'getItems', {}, undefined, 'x');
  s.liveApplied.set('t1', { id: 'p1', buildKey: 'k' });
  s.liveTurn = 't1';
  s.mergedRows.set('p1', []);
  s.endTurn('t1');
  assert.equal(s.reads.seen.size, 0);
  assert.equal(s.liveApplied.size, 0);
  assert.equal(s.mergedRows.size, 0);
});
