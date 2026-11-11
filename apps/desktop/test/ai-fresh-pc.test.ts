// Fresh PC, first open: a new build that was never saved, the player not signed in. The panel must say what to do next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { FailureCode } from '@pom/mastery-contracts';
import { fixture } from '../src/main/aiGate/fixtures.js';
import { AssistantService } from '../src/main/assistant/service.js';
import { aiStatusView, gateStatusForError } from '../src/renderer/gates/ai/status.js';
import { buildSourceHash } from '../src/main/aiGate/scopedContext.js';
import { withPlayerStats } from '../src/shared/buildXml.js';

const NO_ENGINE = { send: () => Promise.reject(new Error('unused')), onEvent: () => () => undefined };

function service(signedIn: boolean, buildKey = 'unsaved:1', cli = '') {
  const svc = new AssistantService({
    ...fixture().deps, target: async () => null, isSignedIn: () => signedIn,
    engine: NO_ENGINE, dataDir: tmpdir(), version: 'test', bridgePath: 'unused',
    env: { ...process.env, POM_CLAUDE_CLI: cli, POM_CODEX_CLI: '' },
  });
  svc.setContext({ buildKey, buildId: 'b1', name: 'New build' });
  return svc;
}
const status = (signedIn: boolean) => service(signedIn).status();

test('signed out with a never-saved build: the panel asks to sign in', async () => {
  for (const s of await status(false)) assert.equal(s.gateCode, 'SIGN_IN_REQUIRED');
});

// The panel saves a never-saved build on its first question (useAssistant saveFirst), so its check must not stop there.
test('signed in with a never-saved build: no save dead end, the panel shows the programs (here: not installed)', async () => {
  for (const s of await status(true)) {
    assert.equal(s.gateCode, undefined, `${s.id}: ${s.detail ?? ''}`);
    assert.equal(s.state, 'missing');
  }
});

test('no code shows the "could not be reached" copy unless the site really could not be reached', () => {
  const codes: FailureCode[] = ['VALIDATION_FAILED', 'UNSUPPORTED_VERSION', 'LIMIT_EXCEEDED', 'CYCLIC_PAYLOAD', 'INVALID_LINK', 'UNAVAILABLE',
    'REVISION_CONFLICT', 'SIGN_IN_REQUIRED', 'AI_ACCESS_REQUIRED', 'ENTITLEMENT_UNAVAILABLE', 'HUMAN_CHECK_REQUIRED', 'CONNECTION_REVOKED',
    'AI_SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'MODERATION_REJECTED', 'FEATURE_PAUSED', 'MAINTENANCE', 'PROTECTED'];
  for (const code of codes) {
    const v = aiStatusView({ status: 'denied', code });
    assert.ok(v.title && v.message, code);
    if (code !== 'ENTITLEMENT_UNAVAILABLE') assert.doesNotMatch(v.message, /could not be reached/i, code);
  }
  assert.equal(aiStatusView({ status: 'denied', code: 'ENTITLEMENT_UNAVAILABLE' }).message, 'Path of Mastery could not be reached. Check your internet connection, then try again.');
});

test('after a save, the file and the open engine build hash the same (the assistant keeps working)', () => {
  const engine = '<PathOfBuilding>\n\t<Build level="1" className="Scion" ascendClassName="None">\n\t</Build>\n\t<Tree activeSpec="1"/>\n</PathOfBuilding>';
  // what textToSave writes: the engine text plus its PlayerStat lines and the class names from the tree
  const saved = withPlayerStats(engine.replace('ascendClassName="None"', 'ascendClassName="Ascendant"'), { Life: 60, CombinedDPS: 0.06 });
  assert.notEqual(saved, engine);
  assert.equal(buildSourceHash(saved), buildSourceHash(engine));
  assert.notEqual(buildSourceHash(engine.replace('level="1"', 'level="2"')), buildSourceHash(engine), 'a real change still differs');
});

test('the in-app panel never says to pair a client', () => {
  const v = aiStatusView({ status: 'denied', code: 'CONNECTION_REVOKED' }, Date.now(), true);
  assert.doesNotMatch(`${v.title} ${v.message}`, /pair|client/i);
  assert.equal(v.recovery, 'Try again');
});

// A saved build whose library copy could not be frozen also has no revision: that failure shows, it is not taken for a new build.
test('signed in, saved build with no revision: the real failure shows, not the programs', async () => {
  for (const s of await service(true, 'Saved build.xml').status()) assert.equal(s.gateCode, 'REVISION_CONFLICT', s.id);
});

// The fresh-PC path: a never-saved build, the program signed out. Its sign-in button must open the sign-in.
test('never-saved build, signed in: the program sign-in opens (no build is read)', async () => {
  // the CLI path is a folder: it resolves, and spawning it fails quietly, so no window opens
  assert.equal((await service(true, 'unsaved:1', tmpdir()).openLogin('claude')).started, true);
  assert.equal((await service(false, 'unsaved:1', tmpdir()).openLogin('claude')).started, false, 'signed out: no login window');
});

test('a turn that fails with a status code gets the copy for that code', () => {
  for (const code of ['REVISION_CONFLICT', 'FEATURE_PAUSED', 'MAINTENANCE', 'UNSUPPORTED_VERSION']) assert.equal(gateStatusForError({ code, message: '' } as never)?.code, code);
});
