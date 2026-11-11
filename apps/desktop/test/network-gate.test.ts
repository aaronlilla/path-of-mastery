import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,sign } from 'node:crypto';
import { NetworkGate } from '../src/main/networkGate/service.js';
import { summarizeSignals,signalState } from '../src/main/networkGate/signals.js';
import { automationNetworkAllowed } from '../src/main/automation.js';
import { parseId,publishedRevisionRefSchema,type PendingIntent,type ValidationLimits } from '@pom/mastery-contracts';

const limits: ValidationLimits = { maxBytes: 65536,maxDepth: 32,maxNodes: 2048,maxArrayLength: 128,maxStringLength: 10000 };
const now = Date.now(); const hash = parseId('hash','a'.repeat(64));
function targetAt(displayRevision: number) {
  const result = publishedRevisionRefSchema.parse({ postId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayRevision },limits);
  if (!result.ok) throw new Error('Invalid fixture'); return result.value;
}
const target = targetAt(1);
const noExecute = async () => assert.fail('Unexpected execution');
const noReview = () => assert.fail('Unexpected review');
const gateForTest = () => new NetworkGate(limits,async (_intent,grant) => grant);
function intent(operation: PendingIntent['operation'] = 'vote'): PendingIntent {
  return { schemaVersion: 1,requestId: operation,idempotencyKey: operation,accountBinding: 'account-A',target,requestHash: hash,
    operation,resumePolicy: ['read','vote','save'].includes(operation) ? 'once' : 'return_to_review' };
}
const context = { accountBinding: 'account-A',target,requestHash: hash };
const clearance = { status: 'clear' as const,clearanceId: 'server-clearance',requestHash: hash,expiresAt: new Date(now+60000).toISOString() };

test('every local operation remains available during uncertain, failed, or absent network checks', () => {
  const gate = gateForTest();
  gate.pause(intent());
  for (const operation of ['run','log','edit','save_local','import_file','optimizer','cache'] as const) assert.equal(gate.allowsLocal(operation),true);
});
test('Run, scheduler and log observations are excluded; focus, timing and input trust alone never pause', () => {
  for (const source of ['run','scheduler','log'] as const) assert.deepEqual(summarizeSignals([{ source,debug: true,trusted: false,focused: false,regularTiming: true }],'test',now,60000).categories,[]);
  for (const input of [{ focused: false },{ regularTiming: true },{ trusted: false },{ debug: true },{}]) {
    assert.equal(signalState(summarizeSignals([{ source: 'user',...input }],'test',now,60000),now),'clear');
  }
  const summary = summarizeSignals([{ source: 'user',debug: true,trusted: false }],'test',now,60000);
  assert.equal(signalState(summary,now),'uncertain'); assert.equal(signalState(summary,now+60000),'uncertain');
  assert.deepEqual(Object.keys(summary).sort(),['categories','expiresAt','observedAt','ruleVersion']);
});
test('read, vote and save resume once even with concurrent Continue and preserve idempotency', async () => {
  for (const op of ['read','vote','save'] as const) {
    const gate = gateForTest(); gate.pause(intent(op)); let calls = 0;
    const execute = async (pending: PendingIntent) => { calls++; assert.equal(pending.idempotencyKey,op); await Promise.resolve(); };
    assert.deepEqual(await Promise.all([gate.resume(op,clearance,context,execute,noReview),gate.resume(op,clearance,context,execute,noReview)]),['resumed','stale']);
    assert.equal(calls,1); gate.pause(intent(op)); assert.equal(await gate.resume(op,clearance,context,execute,noReview),'stale');
  }
});
test('publish, report, feedback, checkout and external edit return to the exact reviewed draft', async () => {
  for (const op of ['publish','report','feedback','checkout','external_edit'] as const) {
    const gate = gateForTest(); const value = intent(op); gate.pause(value); let reviews = 0;
    assert.equal(await gate.resume(op,clearance,context,async () => assert.fail('submission ran'),draft => { reviews++; assert.deepEqual(draft,value); }),'review');
    assert.equal(reviews,1);
  }
});
test('expired/unavailable checks preserve drafts; changed account, hash or revision cannot resume', async () => {
  const gate = gateForTest(); gate.pause(intent());
  for (const grant of [{ status: 'unavailable' as const,retryAt: null },{ ...clearance,expiresAt: new Date(now-1).toISOString() }]) {
    assert.equal(await gate.resume('vote',grant,context,noExecute,noReview,now),'unavailable');
  }
  for (const current of [{ ...context,accountBinding: 'B' },{ ...context,requestHash: parseId('hash','b'.repeat(64)) },{ ...context,target: targetAt(2) }]) {
    const other = gateForTest(); other.pause(intent()); assert.equal(await other.resume('vote',clearance,current,noExecute,noReview),'stale');
  }
  gate.cancelAccount(); assert.equal(await gate.resume('vote',clearance,context,noExecute,noReview),'stale');
});
test('unknown network outcome is never automatically retried', async () => {
  const gate = gateForTest(); gate.pause(intent()); let calls = 0;
  await assert.rejects(gate.resume('vote',clearance,context,async () => { calls++; throw new Error('unknown'); },noReview));
  assert.equal(await gate.resume('vote',clearance,context,noExecute,noReview),'stale'); assert.equal(calls,1);
});
test('a renderer-supplied pass cannot replace server admission; sign-out during admission cannot execute',async () => {
  const gate = new NetworkGate(limits); gate.pause(intent());
  assert.equal(await gate.resume('vote',clearance,context,noExecute,noReview),'unavailable');
  const other = new NetworkGate(limits,async () => { other.cancelAccount(); return clearance; }); other.pause(intent());
  assert.equal(await other.resume('vote',clearance,context,noExecute,noReview),'stale');
  let current = context;
  const changed = new NetworkGate(limits,async () => { current = { ...context,target: targetAt(2) }; return clearance; }); changed.pause(intent());
  assert.equal(await changed.resume('vote',clearance,() => current,noExecute,noReview),'stale');
});
test('test allowance is signed, build-bound, expiring and unusable in production or via automation env alone', () => {
  const keys = generateKeyPairSync('ed25519'); const buildHash = 'b'.repeat(64);
  const ctx = { channel: 'test' as const,buildHash,publicKey: keys.publicKey,now };
  const payload = Buffer.from(JSON.stringify({ version: 1,buildHash,purpose: 'e2e',expiresAt: new Date(now+60000).toISOString(),nonce: 'fixture_nonce_12345' })).toString('base64url');
  const signed = `${payload}.${sign(null,Buffer.from(payload),keys.privateKey).toString('base64url')}`;
  assert.equal(automationNetworkAllowed({ POM_SIGNED_TEST_ALLOWANCE: signed },ctx),true);
  for (const env of [{ POM_AUTOMATION: '1' },{ POM_FORCE_PRO: '1' },{ POM_SIGNED_TEST_ALLOWANCE: `${signed}x` }]) assert.equal(automationNetworkAllowed(env,ctx),false);
  for (const bad of [{ ...ctx,channel: 'production' as const },{ ...ctx,buildHash: 'c'.repeat(64) },{ ...ctx,now: now+60001 },{ ...ctx,publicKey: generateKeyPairSync('ed25519').publicKey }]) assert.equal(automationNetworkAllowed({ POM_SIGNED_TEST_ALLOWANCE: signed },bad),false);
});
