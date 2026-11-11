import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UpdateChannel, UpdateLayerName } from '@pom/protocol';
import { updateDecision, type UpdateDecision, type UpdatePolicyDoc } from '@pom/protocol/updatePolicy';
import type { ParsedManifest } from './manifestClient.js';

export const UNTRUSTED_MANIFEST = 'The update information is not signed with the trusted key, so it was rejected and no update is offered.';
export const INCONSISTENT_MANIFEST = 'The update information is signed but inconsistent (a required minimum version above the version it offers), so it was rejected and no update is offered.';

export interface InstalledVersions {
  app: string;
  /** The engine that runs at the next start (a staged one counts). */
  engine: string;
  interface: string;
}

/** What one manifest means for this installation, per layer, and what the window is told. */
export interface ReleaseDecision {
  layers: Record<UpdateLayerName, UpdateDecision>;
  /** The server policy was used (false: never fetched, the signed manifest alone decided). */
  policyUsed: boolean;
  /** A layer that is taken is required: the Update required dialog. */
  required: boolean;
  critical: boolean;
  minimumVersion?: string;
}

const NAMES: UpdateLayerName[] = ['app', 'engine', 'interface'];

/**
 * Every layer through the protocol's updateDecision (packages/protocol/src/updatePolicy.ts, the one implementation of
 * the update rule) with the channel's server policy (null when never fetched) and this installation's rollout seed.
 * `verify` checks a layer's ed25519 signature. A layer that would be offered but is not signed by the trusted key
 * refuses the whole manifest with a message; one that would not be offered anyway is just not taken.
 */
export function decideRelease(
  manifest: ParsedManifest,
  installed: InstalledVersions,
  seed: string,
  policy: UpdatePolicyDoc | null,
  verify: (name: UpdateLayerName) => boolean = () => true,
  /** The channel this installation is configured for. It picks the policy; the manifest's own `channel` is unsigned and never does. */
  configuredChannel: UpdateChannel = 'stable',
): ReleaseDecision {
  const channel = policy ? (policy[configuredChannel] ?? {}) : null;
  const layers = {} as Record<UpdateLayerName, UpdateDecision>;
  for (const name of NAMES) {
    const layer = manifest.layers[name];
    const p = channel ? (channel[name] ?? {}) : null;
    const app = name === 'interface' ? installed.app : undefined;
    const d = updateDecision({ ...layer, verified: verify(name) }, p, installed[name], seed, app);
    if (d.action === 'none' && d.reason === 'unsigned' && updateDecision({ ...layer, verified: true }, p, installed[name], seed, app).action === 'offer') {
      throw new Error(UNTRUSTED_MANIFEST);
    }
    // A mis-signed layer (signed minimum above its own version) refuses the whole manifest too.
    if (d.action === 'none' && d.reason === 'inconsistentSigned') throw new Error(INCONSISTENT_MANIFEST);
    layers[name] = d;
  }
  const taken = NAMES.map((n) => layers[n]).filter((d): d is Extract<UpdateDecision, { action: 'offer' }> => d.action === 'offer');
  const req = taken.find((d) => d.required);
  return {
    layers,
    policyUsed: !!policy,
    required: !!req,
    critical: taken.some((d) => d.required && d.critical),
    ...(req?.minimum ? { minimumVersion: req.minimum } : {}),
  };
}

/** The installation's random rollout seed, made once and kept in user data (never sent anywhere). */
export async function loadInstallId(filePath: string): Promise<string> {
  try {
    const id = (await readFile(filePath, 'utf8')).trim();
    if (/^[a-f0-9]{32}$/.test(id)) return id;
  } catch { /* first run */ }
  const id = randomBytes(16).toString('hex');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, id, 'utf8');
  return id;
}
