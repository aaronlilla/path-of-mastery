import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateChannel } from '@pom/protocol';
import { BAKED_UPDATE_PUBLIC_KEY } from './updater/updateKey.js';
import { backendConfig } from './accounts/config.js';

/**
 * App-level configuration. Everything here is meant to move to a real
 * settings file/UI once one exists; env vars are the placeholder source so
 * the shell is runnable and testable today without inventing a config
 * format we'd just replace.
 */
export interface AppConfig {
  /** Path to the native engine module (a crates/napi build). Absent until that lands. */
  nativeEngineModulePath?: string;
  /** Base URL the update manifest is fetched from; ?channel=<channel> is appended. Empty in a build without a backend: it never checks. */
  updateManifestBaseUrl: string;
  /** base64 SPKI-encoded ed25519 public key the manifest's per-layer signatures are checked against. */
  updateSigningPublicKey: string;
  /** The remote config document read for its unsigned `updatePolicy` (POM_REMOTE_CONFIG_URL in development only). */
  remoteConfigUrl: string | null;
  channel: UpdateChannel;
}

export interface PackagedInfo {
  isPackaged: boolean;
  /** Electron's `process.resourcesPath`. */
  resourcesPath?: string;
  exists?: (path: string) => boolean;
}

/** Where an installed app keeps its engine: `<resources>/engine/pom_napi.node` (see electron-builder.yml). */
export function packagedEnginePath(info: PackagedInfo): string | undefined {
  if (!info.isPackaged || !info.resourcesPath) return undefined;
  const p = join(info.resourcesPath, 'engine', 'pom_napi.node');
  return (info.exists ?? existsSync)(p) ? p : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, packaged?: PackagedInfo): AppConfig {
  const channel = env.POM_UPDATE_CHANNEL === 'beta' ? 'beta' : 'stable';
  // The update URL and key overrides are for development only: a packaged build always uses the baked values,
  // so an environment variable on a user's machine can never point it at another server or key.
  const dev = !packaged?.isPackaged;
  const site = backendConfig()?.siteOrigin;
  return {
    nativeEngineModulePath: env.POM_NATIVE_ENGINE_PATH ?? (packaged ? packagedEnginePath(packaged) : undefined),
    updateManifestBaseUrl: (dev && env.POM_UPDATE_MANIFEST_URL) || (site ? `${site}/updates/manifest.json` : ''),
    updateSigningPublicKey: (dev && env.POM_UPDATE_PUBLIC_KEY) || BAKED_UPDATE_PUBLIC_KEY,
    remoteConfigUrl: (dev && env.POM_REMOTE_CONFIG_URL) || (site ? `${site}/api/app/config` : null),
    channel,
  };
}
