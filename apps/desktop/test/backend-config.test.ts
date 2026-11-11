import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackend } from '../src/main/accounts/config.js';
import { LocalAiAccess } from '../src/main/aiGate/local.js';
import { AiDenied } from '../src/main/aiGate/gate.js';
import { target } from '../src/main/aiGate/fixtures.js';

const baked = { supabaseUrl: 'https://p.example.test/', supabaseKey: 'k1', siteOrigin: 'https://site.example.test' };
const env = { POM_SUPABASE_URL: 'http://127.0.0.1:1', POM_SUPABASE_PUBLISHABLE_KEY: 'k2', POM_SITE_ORIGIN: 'http://localhost:4330' } as NodeJS.ProcessEnv;

test('a build with nothing baked and nothing in the environment has no backend', () => {
  assert.equal(resolveBackend(undefined, {}, true), null);
  assert.equal(resolveBackend(undefined, {}, false), null);
  assert.equal(resolveBackend({ supabaseUrl: 'https://p.example.test', supabaseKey: 'k' }, {}, true), null, 'all three values are needed');
});

test('a packaged app uses only the baked values; a dev run may override them from the environment', () => {
  assert.deepEqual(resolveBackend(baked, env, true), { supabaseUrl: 'https://p.example.test', supabaseKey: 'k1', siteOrigin: 'https://site.example.test' });
  assert.deepEqual(resolveBackend(baked, env, false), { supabaseUrl: 'http://127.0.0.1:1', supabaseKey: 'k2', siteOrigin: 'http://127.0.0.1:4330' });
  assert.equal(resolveBackend(undefined, env, true), null, 'the environment alone never configures a packaged app');
  assert.ok(resolveBackend(undefined, env, false));
});

test('without a backend the assistant gate is local: ready, no hosted model, no pairing', async () => {
  const t = target();
  let stale = false;
  const gate = new LocalAiAccess(async () => !stale);
  assert.equal(gate.state.status, 'ready');
  assert.equal(await gate.run({ clientId: null }, 'ai:plan', t, {}, async () => 7), 7);
  assert.equal(await gate.model(), null);
  await assert.rejects(gate.pair(), (e: unknown) => e instanceof AiDenied && e.code === 'AI_ACCESS_REQUIRED');
  stale = true;
  await assert.rejects(gate.verify({ clientId: null }, t), (e: unknown) => e instanceof AiDenied && e.code === 'REVISION_CONFLICT');
});
