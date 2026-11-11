import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../src/semver.js';
import {
  parseUpdatePolicyDoc, pendingAction, policyProblems, updateBucket, updateDecision, type LayerPolicy, type SignedLayerInput,
} from '../src/updatePolicy.js';
import { prng, type Rng } from './prng.js';

const L = (over: Partial<SignedLayerInput> = {}): SignedLayerInput => ({ verified: true, version: '0.3.2', ...over });
const cmp = (a: string, b: string) => compareVersions(a, b)!;
const ceiling = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(100, Math.max(0, Math.floor(x))) : 100);

test('8.2 walk-through on fixed cases', () => {
  assert.deepEqual(updateDecision(L({ verified: false }), null, '0.3.1', 0), { action: 'none', reason: 'unsigned' });
  assert.deepEqual(updateDecision(L(), null, '0.3.2', 0), { action: 'none', reason: 'upToDate' });
  assert.deepEqual(updateDecision(L({ version: '0.3.0' }), null, '0.3.1', 0), { action: 'none', reason: 'downgradeRefused' });
  assert.equal(updateDecision(L({ version: '0.3.0', allowDowngrade: true }), null, '0.3.1', 0).action, 'offer');
  assert.deepEqual(updateDecision(L(), { blockedVersions: ['0.3.2'] }, '0.3.1', 0), { action: 'none', reason: 'blocked' });
  assert.deepEqual(updateDecision(L(), { paused: true }, '0.3.1', 0), { action: 'none', reason: 'paused' });
  assert.deepEqual(updateDecision(L({ rolloutPercent: 50 }), { rolloutPercent: 25 }, '0.3.1', 25), { action: 'none', reason: 'notInRollout' });
  assert.deepEqual(updateDecision(L({ rolloutPercent: 50 }), { rolloutPercent: 25 }, '0.3.1', 24),
    { action: 'offer', required: false, critical: false, downgrade: false, rollout: 25 });
  // The server cannot raise rollout above the signed ceiling of 50 (AC20 client half).
  assert.equal((updateDecision(L({ rolloutPercent: 50 }), { rolloutPercent: 100 }, '0.3.1', 10) as { rollout: number }).rollout, 50);
  assert.deepEqual(updateDecision(L({ rolloutPercent: 50 }), { rolloutPercent: 100 }, '0.3.1', 60), { action: 'none', reason: 'notInRollout' });
  // Required (policy minimum) overrides pause and rollout 0, but is capped at the signed version.
  assert.deepEqual(updateDecision(L(), { paused: true, rolloutPercent: 0, minimumVersion: '0.3.2' }, '0.3.1', 99),
    { action: 'offer', required: true, critical: false, downgrade: false, rollout: 0, minimum: '0.3.2' });
  assert.deepEqual(updateDecision(L(), { minimumVersion: '9.9.9' }, '0.3.1', 99),
    { action: 'offer', required: true, critical: false, downgrade: false, rollout: 100, minimum: '0.3.2' }, 'a minimum above the signed version means "the signed version"');
  // An installed version on the block list must move.
  assert.equal((updateDecision(L(), { blockedVersions: ['0.3.1'], paused: true }, '0.3.1', 99) as { required: boolean }).required, true);
  // Rollback: re-signed older build with allowDowngrade, bad version blocked: users of the bad one are required to move.
  assert.deepEqual(updateDecision(L({ version: '0.3.0', allowDowngrade: true }), { blockedVersions: ['0.3.1'] }, '0.3.1', 99),
    { action: 'offer', required: true, critical: false, downgrade: true, rollout: 100 });
  // Signed minimum is the floor the server cannot lower.
  assert.equal((updateDecision(L({ minimumVersion: '0.3.0' }), { minimumVersion: '0.1.0' }, '0.2.0', 99) as { minimum: string }).minimum, '0.3.0');
  // An inconsistent signed layer (minimum above the version it ships, or not a version) is refused, never clamped.
  assert.deepEqual(updateDecision(L({ minimumVersion: '0.3.3' }), null, '0.2.0', 0), { action: 'none', reason: 'inconsistentSigned' });
  assert.deepEqual(updateDecision(L({ minimumVersion: '0.3.3' }), { minimumVersion: '0.3.2' }, '0.3.1', 0), { action: 'none', reason: 'inconsistentSigned' });
  assert.deepEqual(updateDecision(L({ minimumVersion: 'latest' }), null, '0.2.0', 0), { action: 'none', reason: 'inconsistentSigned' });
  assert.equal(pendingAction(updateDecision(L({ minimumVersion: '0.3.3' }), null, '0.2.0', 0)), 'delete');
  // The interface layer for another app version is not taken.
  assert.deepEqual(updateDecision(L({ forApp: '0.3.2' }), null, '0.3.1', 0, '0.3.1'), { action: 'none', reason: 'otherApp' });
});

test('pendingAction: blocked deletes, paused holds, offer installs', () => {
  assert.equal(pendingAction(updateDecision(L(), { blockedVersions: ['0.3.2'] }, '0.3.1', 0)), 'delete');
  assert.equal(pendingAction(updateDecision(L(), { paused: true }, '0.3.1', 0)), 'hold');
  assert.equal(pendingAction(updateDecision(L(), { paused: false }, '0.3.1', 0)), 'install');
  assert.equal(pendingAction(updateDecision(L({ verified: false }), null, '0.3.1', 0)), 'delete');
});

test('policyProblems (server side of AC20): above the signed ceiling or the signed version is refused', () => {
  assert.deepEqual(policyProblems({ rolloutPercent: 60 }, { version: '0.3.2', rolloutPercent: 50 }), ['ABOVE_SIGNED_CEILING']);
  assert.deepEqual(policyProblems({ minimumVersion: '0.3.3' }, { version: '0.3.2' }), ['ABOVE_SIGNED_VERSION']);
  assert.deepEqual(policyProblems({ rolloutPercent: 50, minimumVersion: '0.3.2' }, { version: '0.3.2', rolloutPercent: 50 }), []);
});

test('untrusted policy JSON can only be less restrictive when malformed', () => {
  const doc = parseUpdatePolicyDoc({ stable: { app: { rolloutPercent: 'all', paused: 'yes', minimumVersion: 'latest', blockedVersions: ['0.3.1', 7, 'x'] } }, nightly: {} });
  assert.deepEqual(doc, { stable: { app: { blockedVersions: ['0.3.1'] } } });
});

test('bucket is per version, so raising the percent keeps earlier installs (AC17 client half: 20 seeds)', () => {
  const seeds = Array.from({ length: 20 }, (_, i) => `seed-${i}`);
  const eligible = (p: number) => seeds.filter((s) => updateDecision(L(), { rolloutPercent: p }, '0.3.1', s).action === 'offer');
  assert.equal(eligible(0).length, 0, 'offer at 0%: none');
  assert.equal(eligible(100).length, 20);
  const at50 = eligible(50), at75 = eligible(75);
  for (const s of at50) assert.ok(at75.includes(s), `${s} dropped out when raising 50 -> 75`);
  assert.ok(at50.length >= 4 && at50.length <= 16, `about half eligible at 50%: ${at50.length}`);
  // A new version reshuffles who goes first (the bucket includes the version).
  const differ = Array.from({ length: 200 }, (_, i) => updateBucket(`s${i}`, '0.3.2') !== updateBucket(`s${i}`, '0.3.3')).filter(Boolean).length;
  assert.ok(differ > 180, `buckets differ across versions for ${differ}/200 seeds`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Property tests: the 8.2 invariants over 200,000 generated (layer, policy, installed, seed) cases.

const VERS = ['0.1.0', '0.2.0', '0.2.1', '0.3.0', '0.3.1', '0.3.2', '0.4.0-beta.1', '0.4.0', '1.0.0'];
function genLayer(r: Rng): SignedLayerInput {
  const l: SignedLayerInput = { verified: r.bool(0.85), version: r.pick(VERS) };
  if (r.bool(0.4)) l.minimumVersion = r.bool(0.9) ? r.pick(VERS) : 'garbage';
  if (r.bool(0.6)) l.rolloutPercent = r.bool(0.9) ? r.int(0, 100) : r.pick([NaN, -5, 150, 33.7]);
  if (r.bool(0.3)) l.allowDowngrade = true;
  if (r.bool(0.2)) l.critical = true;
  return l;
}
function genPolicy(r: Rng): LayerPolicy | null {
  if (r.bool(0.2)) return null;
  const p: Record<string, unknown> = {};
  if (r.bool(0.6)) p.rolloutPercent = r.bool(0.85) ? r.int(0, 100) : r.pick([NaN, -1, 1000, '50']);
  if (r.bool(0.3)) p.paused = r.bool();
  if (r.bool(0.4)) p.minimumVersion = r.bool(0.9) ? r.pick(VERS) : 'nope';
  if (r.bool(0.4)) p.blockedVersions = Array.from({ length: r.int(1, 3) }, () => r.pick(VERS));
  return p as LayerPolicy;
}

test('property: 8.2 invariants hold on 200,000 generated cases', () => {
  const r = prng(20261017);
  const counts = { offer: 0, required: 0, none: 0, inconsistent: 0 };
  for (let i = 0; i < 200_000; i++) {
    const layer = genLayer(r), policy = genPolicy(r), installed = r.pick(VERS), bucket = r.int(0, 99);
    const d = updateDecision(layer, policy, installed, bucket);
    const why = () => `case ${i}: ${JSON.stringify({ layer, policy, installed, bucket, d })}`;
    const blocked = Array.isArray(policy?.blockedVersions) ? policy!.blockedVersions.filter((v) => VERS.includes(v)) : [];
    if (layer.verified && layer.minimumVersion !== undefined && (!VERS.includes(layer.minimumVersion) || cmp(layer.minimumVersion, layer.version) > 0)) {
      assert.deepEqual(d, { action: 'none', reason: 'inconsistentSigned' }, why());
      counts.inconsistent++;
    }
    if (d.action === 'none') { counts.none++; }
    else {
      counts.offer++;
      if (d.required) counts.required++;
      // Never installs unsigned bytes, and never from a layer whose signed minimum contradicts its version.
      assert.equal(layer.verified, true, why());
      assert.ok(layer.minimumVersion === undefined || (VERS.includes(layer.minimumVersion) && cmp(layer.minimumVersion, layer.version) <= 0), why());
      // Never downgrades without signed allowDowngrade; never re-offers the installed version.
      assert.notEqual(layer.version, installed, why());
      if (cmp(layer.version, installed) < 0) { assert.equal(layer.allowDowngrade, true, why()); assert.equal(d.downgrade, true, why()); }
      // Effective rollout never exceeds the signed ceiling.
      assert.ok(d.rollout <= ceiling(layer.rolloutPercent), why());
      // Effective minimum never exceeds the signed v, never drops below the signed minimum.
      if (d.minimum !== undefined) {
        assert.ok(cmp(d.minimum, layer.version) <= 0, why());
        if (layer.minimumVersion !== undefined) assert.ok(cmp(d.minimum, layer.minimumVersion!) >= 0, why());
      }
      // A blocked version is never offered, required or not.
      assert.ok(!blocked.includes(layer.version), why());
      // Not required: must be inside the rollout and not paused.
      if (!d.required) {
        assert.ok(bucket < d.rollout, why());
        assert.notEqual((policy as Record<string, unknown> | null)?.paused, true, why());
      }
      // The unsigned policy can only hold back or hurry: a non-required offer under any policy is also an offer
      // (or a required one) under the signed fields alone.
      if (!d.required) assert.equal(updateDecision(layer, null, installed, bucket).action, 'offer', why());
    }
    // Monotone rollout: raising the policy percent never removes an installation from the offer.
    if (policy && typeof policy.rolloutPercent === 'number' && Number.isFinite(policy.rolloutPercent) && policy.rolloutPercent < 100 && d.action === 'offer') {
      const higher = updateDecision(layer, { ...policy, rolloutPercent: Math.min(100, Math.floor(policy.rolloutPercent) + r.int(1, 50)) }, installed, bucket);
      assert.equal(higher.action, 'offer', why());
    }
    // Never fetched (null) and empty policy decide the same (step 7).
    assert.deepEqual(updateDecision(layer, {}, installed, bucket), updateDecision(layer, null, installed, bucket), why());
  }
  // The generator really reaches every branch.
  assert.ok(counts.offer > 20_000 && counts.required > 5_000 && counts.none > 50_000 && counts.inconsistent > 5_000, JSON.stringify(counts));
});
