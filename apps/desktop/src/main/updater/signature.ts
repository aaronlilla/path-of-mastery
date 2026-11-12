import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { UpdateLayer, UpdateLayerName } from '@pom/protocol';
import { layerSigningPayload } from '@pom/protocol';

export function importEd25519PublicKey(spkiDerBase64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiDerBase64, 'base64'), format: 'der', type: 'spki' });
}

/** Verifies a layer's ed25519 signature over its own manifest fields (see layerSigningPayload). */
export function verifyLayerSignature(
  layerName: UpdateLayerName,
  layer: UpdateLayer,
  publicKey: KeyObject,
): boolean {
  const payload = Buffer.from(layerSigningPayload(layerName, layer), 'utf8');
  const signature = Buffer.from(layer.signature, 'base64');
  try {
    // ed25519 uses the null algorithm identifier in Node's crypto.verify.
    return cryptoVerify(null, payload, publicKey, signature);
  } catch {
    return false;
  }
}

/** Streams a file to compute its sha256, without holding the whole thing in memory. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface LayerVerificationResult {
  ok: boolean;
  reason?: string;
}

/** Full verification for a downloaded pack: hash must match, signature must be valid over the manifest's own fields. */
export async function verifyDownloadedLayer(
  layerName: UpdateLayerName,
  layer: UpdateLayer,
  filePath: string,
  publicKey: KeyObject,
): Promise<LayerVerificationResult> {
  if (!verifyLayerSignature(layerName, layer, publicKey)) {
    return { ok: false, reason: `signature verification failed for ${layerName} layer` };
  }
  const actualHash = await sha256File(filePath);
  if (actualHash !== layer.sha256.toLowerCase()) {
    return { ok: false, reason: `sha256 mismatch for ${layerName} layer: expected ${layer.sha256}, got ${actualHash}` };
  }
  return { ok: true };
}
