/**
 * The update trust model: signed fields say what may be installed; the unsigned server policy
 * from the remote config document can only hold back or hurry an already-signed version.
 *
 * Shapes agree with the auto-updater's manifest.ts (signed delivery fields `minimumVersion`, `critical`,
 * `rolloutPercent` (a CEILING, default 100), `allowDowngrade`, `forApp` inside layerSigningPayload; `LayerPolicy`;
 * the `{action: 'none' | 'offer'}` decision). One extra input here: `verified`, the result of the signature check, so the
 * "never installs unsigned bytes" invariant is part of the function and its property test.
 */
import { compareVersions, isSemver } from './semver.js';
import { bucketOf } from './sha256.js';

export type PolicyChannel = 'stable' | 'beta';
export type PolicyLayer = 'app' | 'engine' | 'interface';

/** The server's unsigned policy for one channel and layer (`updatePolicy.{channel}.{layer}` in the config document). */
export interface LayerPolicy {
  rolloutPercent?: number;
  paused?: boolean;
  minimumVersion?: string;
  blockedVersions?: string[];
  /** 'auto' when the auto-pause rule (8.5) set `paused`; display only. */
  pausedBy?: 'admin' | 'auto';
}
export type UpdatePolicyDoc = Partial<Record<PolicyChannel, Partial<Record<PolicyLayer, LayerPolicy>>>>;

/** The fields of one manifest layer the decision reads, after the caller checked its ed25519 signature. */
export interface SignedLayerInput {
  /** True only when the layer's signature verified over layerSigningPayload. */
  verified: boolean;
  version: string;
  minimumVersion?: string;
  critical?: boolean;
  rolloutPercent?: number;
  allowDowngrade?: boolean;
  forApp?: string;
}

export type UpdateDecision =
  | { action: 'none'; reason: 'unsigned' | 'inconsistentSigned' | 'upToDate' | 'downgradeRefused' | 'blocked' | 'paused' | 'notInRollout' | 'otherApp' }
  | { action: 'offer'; required: boolean; critical: boolean; downgrade: boolean; rollout: number; minimum?: string };

/** What to do with an installer for this version that was already downloaded (8.2 steps 3-4). */
export type PendingAction = 'install' | 'hold' | 'delete';

const MAX_BLOCKED = 50;

function percent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, Math.floor(value)));
}
const lt = (a: string, b: string): boolean => (compareVersions(a, b) ?? 0) < 0;

/** Per-version rollout bucket 0-99: raising the percent keeps every earlier installation in (8.2 step 5). */
export function updateBucket(rolloutSeed: string, version: string): number {
  return bucketOf(`${rolloutSeed}:${version}`);
}

/** Reads one layer policy from untrusted JSON; anything malformed is dropped, so it can only ever be less restrictive. */
export function parseLayerPolicy(raw: unknown): LayerPolicy | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: LayerPolicy = {};
  if (typeof r.rolloutPercent === 'number' && Number.isFinite(r.rolloutPercent)) out.rolloutPercent = percent(r.rolloutPercent);
  if (typeof r.paused === 'boolean') out.paused = r.paused;
  if (isSemver(r.minimumVersion)) out.minimumVersion = r.minimumVersion;
  if (Array.isArray(r.blockedVersions)) out.blockedVersions = r.blockedVersions.filter(isSemver).slice(0, MAX_BLOCKED);
  if (r.pausedBy === 'admin' || r.pausedBy === 'auto') out.pausedBy = r.pausedBy;
  return out;
}

export function parseUpdatePolicyDoc(raw: unknown): UpdatePolicyDoc {
  const out: UpdatePolicyDoc = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const channel of ['stable', 'beta'] as const) {
    const c = (raw as Record<string, unknown>)[channel];
    if (c === null || typeof c !== 'object' || Array.isArray(c)) continue;
    const layers: Partial<Record<PolicyLayer, LayerPolicy>> = {};
    for (const layer of ['app', 'engine', 'interface'] as const) {
      const p = parseLayerPolicy((c as Record<string, unknown>)[layer]);
      if (p) layers[layer] = p;
    }
    out[channel] = layers;
  }
  return out;
}

/**
 * The client's decision for one signed layer (8.2). `policy` is null when the config was never fetched (step 7: signed
 * fields only). `rolloutSeed` is the installation's local random seed (never sent), or an already computed 0-99 bucket.
 *  1. unsigned or bad signature, or a signed minimum above the signed version (inconsistent): no offer.
 *  2. v <= installed without signed allowDowngrade: nothing to do.
 *  3. v blocked: no offer (a pending installer for v is deleted).   4. paused: no offer (a pending installer is held).
 *  5. rollout = min(signed ceiling, policy percent); eligible when bucket < rollout.
 *  6. required = installed < max(signed min, min(policy min, v)) or installed is blocked; overrides 4 and 5, never 3.
 */
export function updateDecision(layer: SignedLayerInput, policy: LayerPolicy | null, installed: string, rolloutSeed: string | number, installedApp?: string): UpdateDecision {
  if (layer.verified !== true) return { action: 'none', reason: 'unsigned' };
  const v = layer.version;
  // A signed layer that contradicts itself (a minimum that is not a version, or above the version it ships) is refused:
  // the effective minimum may never drop below the signed one (8.2), and v cannot satisfy it.
  if (layer.minimumVersion !== undefined && (!isSemver(layer.minimumVersion) || lt(v, layer.minimumVersion))) return { action: 'none', reason: 'inconsistentSigned' };
  if (layer.forApp && installedApp !== undefined && layer.forApp !== installedApp) return { action: 'none', reason: 'otherApp' };
  const cmp = compareVersions(v, installed);
  if (v === installed || cmp === 0) return { action: 'none', reason: 'upToDate' };
  const downgrade = cmp !== null && cmp < 0;
  const newer = cmp === null ? v !== installed : cmp > 0;
  if (!newer && !(downgrade && layer.allowDowngrade === true)) return { action: 'none', reason: 'downgradeRefused' };
  const p = policy === null ? null : parseLayerPolicy(policy);
  const blocked = p?.blockedVersions ?? [];
  if (blocked.includes(v)) return { action: 'none', reason: 'blocked' };
  const signedMin = isSemver(layer.minimumVersion) ? layer.minimumVersion : undefined;
  // The server may raise the floor, but never above the signed version itself.
  const serverMin = p?.minimumVersion !== undefined ? (lt(p.minimumVersion, v) ? p.minimumVersion : v) : undefined;
  const floor = signedMin && serverMin ? (lt(signedMin, serverMin) ? serverMin : signedMin) : signedMin ?? serverMin;
  const required = (floor !== undefined && lt(installed, floor)) || blocked.includes(installed);
  const rollout = Math.min(percent(layer.rolloutPercent), percent(p?.rolloutPercent));
  const offer = { action: 'offer' as const, required, critical: layer.critical === true, downgrade, rollout, ...(floor ? { minimum: floor } : {}) };
  if (required) return offer;
  if (p?.paused === true) return { action: 'none', reason: 'paused' };
  const bucket = typeof rolloutSeed === 'number' ? rolloutSeed : updateBucket(rolloutSeed, v);
  if (!(bucket < rollout)) return { action: 'none', reason: 'notInRollout' };
  return offer;
}

/** A downloaded installer for the decided version: delete when blocked, hold while paused or not offered, else install. */
export function pendingAction(decision: UpdateDecision): PendingAction {
  if (decision.action === 'offer') return 'install';
  if (decision.reason === 'blocked' || decision.reason === 'unsigned' || decision.reason === 'inconsistentSigned' || decision.reason === 'downgradeRefused') return 'delete';
  return 'hold';
}

/**
 * Server-side check of a dashboard policy change against the verified signed layer (AC20, API half). Returns the list of
 * problems; empty means the policy can be stored. The SQL `admin_set_update_policy` enforces the same rules.
 */
export function policyProblems(policy: LayerPolicy, signed: { version: string; rolloutPercent?: number; minimumVersion?: string }): string[] {
  const problems: string[] = [];
  if (policy.rolloutPercent !== undefined && policy.rolloutPercent > percent(signed.rolloutPercent)) problems.push('ABOVE_SIGNED_CEILING');
  if (policy.minimumVersion !== undefined && (compareVersions(policy.minimumVersion, signed.version) ?? 1) > 0) problems.push('ABOVE_SIGNED_VERSION');
  return problems;
}
