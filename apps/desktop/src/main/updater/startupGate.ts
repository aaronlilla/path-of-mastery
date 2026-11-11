import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { UpdateChannel, UpdateLayer, UpdateLayerName } from '@pom/protocol';
import { pendingAction, updateBucket, updateDecision, type UpdatePolicyDoc } from '@pom/protocol/updatePolicy';
import { parseManifest } from './manifestClient.js';
import { verifyLayerSignature } from './signature.js';

/** What the next start does with a staged engine or interface: run it, keep it unused (paused, held back), or delete it. */
export type StagedVerdict = 'load' | 'hold' | 'delete';

/**
 * The next-launch policy gate for a staged layer. The
 * start has no network: it judges with the last verified manifest (its signed fields for that version, which may carry a
 * newer ceiling) and the last good server policy, both from user data. `staged` is the signed layer the copy was
 * verified against (the caller checked its signature and the file's hash).
 */
export function gateStaged(o: {
  name: UpdateLayerName;
  staged: UpdateLayer;
  cached: UpdateLayer | null;
  policy: UpdatePolicyDoc | null;
  channel: UpdateChannel;
  running: string;
  seed: string;
  installedApp?: string;
}): StagedVerdict {
  const layer = o.cached && o.cached.version === o.staged.version ? o.cached : o.staged;
  const p = o.policy ? (o.policy[o.channel]?.[o.name] ?? {}) : null;
  const d = updateDecision({ ...layer, verified: true }, p, o.running, updateBucket(o.seed, layer.version), o.name === 'interface' ? o.installedApp : undefined);
  if (d.action === 'offer') return 'load';
  return pendingAction(d) === 'delete' ? 'delete' : 'hold';
}

/** The last verified manifest (UpdateManager writes it); only layers whose signature still verifies are returned. */
export async function readManifestCache(path: string, key: KeyObject): Promise<{ layers: Partial<Record<UpdateLayerName, UpdateLayer>> } | null> {
  try {
    const m = parseManifest(JSON.parse(await readFile(path, 'utf8')));
    const layers: Partial<Record<UpdateLayerName, UpdateLayer>> = {};
    for (const n of ['app', 'engine', 'interface'] as const) if (verifyLayerSignature(n, m.layers[n], key)) layers[n] = m.layers[n];
    return { layers };
  } catch {
    return null;
  }
}
