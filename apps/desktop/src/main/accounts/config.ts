import { readFileSync } from 'node:fs';
import { resolveSiteOrigin } from '../mastery/siteOrigin.js';

/**
 * The hosted backend: the Supabase project and the site API. Official builds get these three values when they are built
 * (stamp-versions.mjs writes them into dist/versions.json). A copy built without them has no backend: no sign-in, no
 * cloud, no sharing, no hosted AI, and every network feature below asks backendConfig() before it reaches out.
 * The publishable key only reaches what row level security allows. There is no service-role key in the app.
 */
export interface BackendConfig {
  supabaseUrl: string;
  supabaseKey: string;
  siteOrigin: string;
}

export interface SupabaseConfig {
  url: string;
  key: string;
}

/** The address the sign-in links bring the player back to. Registered in supabase/config.toml. */
export const AUTH_REDIRECT = 'pathofmastery://auth/callback';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Baked values first. An unpackaged run may override each one from POM_SUPABASE_URL, POM_SUPABASE_PUBLISHABLE_KEY and
 * POM_SITE_ORIGIN (POM_SUPABASE_KEY is the older name of the key); a packaged app never reads the environment, so
 * nothing on a player's machine can point it at another server. Null unless all three values are there.
 */
export function resolveBackend(baked: unknown, env: NodeJS.ProcessEnv, isPackaged: boolean): BackendConfig | null {
  const b = (baked && typeof baked === 'object' ? baked : {}) as Record<string, unknown>;
  const e = isPackaged ? {} : env;
  const supabaseUrl = (str(e.POM_SUPABASE_URL) || str(b.supabaseUrl)).replace(/\/+$/, '');
  const supabaseKey = str(e.POM_SUPABASE_PUBLISHABLE_KEY) || str(e.POM_SUPABASE_KEY) || str(b.supabaseKey);
  const siteOrigin = resolveSiteOrigin(e, isPackaged, str(b.siteOrigin));
  return supabaseUrl && supabaseKey && siteOrigin ? { supabaseUrl, supabaseKey, siteOrigin } : null;
}

/** Reads the `backend` entry of dist/versions.json (absent in a build without a backend). */
export function loadBackend(versionsFile: string | URL, env: NodeJS.ProcessEnv, isPackaged: boolean): BackendConfig | null {
  let baked: unknown;
  try {
    baked = (JSON.parse(readFileSync(versionsFile, 'utf8')) as { backend?: unknown }).backend;
  } catch {
    /* no stamp: nothing baked */
  }
  return resolveBackend(baked, env, isPackaged);
}

let current: BackendConfig | null = null;
/** Called once, first thing in the main process. */
export function setBackend(b: BackendConfig | null): void {
  current = b;
}
export function backendConfig(): BackendConfig | null {
  return current;
}

/** GitHub sign-in is wired but off until the GitHub app is set up. POM_GITHUB_SIGNIN=1 turns it on. */
export function githubAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.POM_GITHUB_SIGNIN === '1';
}
