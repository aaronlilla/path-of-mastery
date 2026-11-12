/**
 * The update manifest served by our own update endpoint. One manifest per channel, fetched from a configurable
 * URL. It describes three independently-updatable layers; each entry is
 * individually ed25519-signed so a compromised CDN can't swap in an
 * unsigned or mismatched payload.
 */
export type UpdateChannel = 'stable' | 'beta';

export type UpdateLayerName = 'engine' | 'interface' | 'app';

export interface UpdateLayer {
  version: string;
  sha256: string;
  size: number;
  url: string;
  /**
   * Delivery fields, signed inside layerSigningPayload. All optional; absent = the default.
   * minimumVersion: installs below it must update (the "Update required" dialog); the signed FLOOR.
   */
  minimumVersion?: string;
  /** A security fix: the required-update dialog says so. */
  critical?: boolean;
  /** 0-100, default 100: the CEILING of the share of installations offered this version (the dashboard ramps below it). */
  rolloutPercent?: number;
  /** Lets this version replace a HIGHER installed one (rolling back a bad release). */
  allowDowngrade?: boolean;
  /** The app version this layer was built for (the interface layer): it is only taken by that app version. */
  forApp?: string;
  /** base64-encoded ed25519 signature over the layer's canonical signing payload (see layerSigningPayload()). */
  signature: string;
}

/** The client's decision for a layer, the server policy and the semver order live in `@pom/protocol/updatePolicy` and `/semver`. */
export interface UpdateManifest {
  channel: UpdateChannel;
  generatedAt: string;
  layers: Record<UpdateLayerName, UpdateLayer>;
}

/** The delivery fields of a layer, in signing order. */
const DELIVERY = ['minimumVersion', 'critical', 'rolloutPercent', 'allowDowngrade', 'forApp'] as const;

function hasDelivery(layer: Omit<UpdateLayer, 'signature'>): boolean {
  return DELIVERY.some((k) => layer[k] !== undefined && layer[k] !== null);
}

/**
 * The exact bytes an ed25519 signature is computed over for one layer. Kept
 * here (rather than only in the verifier) so signing tooling and the
 * verifier can never drift apart. A layer with no delivery fields keeps the
 * original v1 form; one with any of them uses the v2 form, which names every
 * delivery field (with its default) before the url. The two forms have
 * different prefixes, so stripping the delivery fields from a v2 layer can
 * never produce a valid v1 payload, and the url stays last so it cannot
 * swallow a field.
 */
export function layerSigningPayload(layerName: UpdateLayerName, layer: Omit<UpdateLayer, 'signature'>): string {
  if (!hasDelivery(layer)) return `pom-update:${layerName}:${layer.version}:${layer.sha256}:${layer.size}:${layer.url}`;
  const d = [
    `min=${layer.minimumVersion ?? ''}`,
    `critical=${layer.critical ? 1 : 0}`,
    `rollout=${layer.rolloutPercent ?? 100}`,
    `downgrade=${layer.allowDowngrade ? 1 : 0}`,
    `forApp=${layer.forApp ?? ''}`,
  ].join(':');
  return `pom-update2:${layerName}:${layer.version}:${layer.sha256}:${layer.size}:${d}:${layer.url}`;
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'beta';
}
