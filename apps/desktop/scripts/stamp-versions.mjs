// Writes dist/versions.json: the version numbers About shows for the layers of this build.
//   engine    = the version of the native engine module the app loads (crates/napi, which reports it as NativeEngineModule.version)
//   interface = the version of the desktop app's own interface layer (apps/desktop/package.json)
//   official  = true only when POM_OFFICIAL_BUILD=1 (the release build). Only an official build checks for updates on its own.
//   backend   = the hosted backend's addresses (POM_SUPABASE_URL, POM_SUPABASE_PUBLISHABLE_KEY, POM_SITE_ORIGIN), baked into official builds only.
//               A build without it has no sign-in, cloud or hosted AI.
// `npm run build:main` runs it after tsc; the file ships with dist/. When an update has swapped a layer, About shows the swapped version instead.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const repo = resolve(desktop, '..', '..');

/** The `version = "x.y.z"` line of the [package] table. */
export function cargoVersion(toml) {
  const pkg = /\[package\]([\s\S]*?)(?:\n\[|$)/.exec(toml)?.[1] ?? '';
  const m = /^\s*version\s*=\s*"(\d+\.\d+\.\d+[^"]*)"/m.exec(pkg);
  if (!m) throw new Error('no version in the [package] table');
  return m[1];
}

function backendFromEnv() {
  const e = process.env;
  const backend = { supabaseUrl: e.POM_SUPABASE_URL, supabaseKey: e.POM_SUPABASE_PUBLISHABLE_KEY, siteOrigin: e.POM_SITE_ORIGIN };
  if (!backend.supabaseUrl || !backend.supabaseKey || !backend.siteOrigin) throw new Error('an official build needs POM_SUPABASE_URL, POM_SUPABASE_PUBLISHABLE_KEY and POM_SITE_ORIGIN');
  return backend;
}

export function stamp() {
  const engine = cargoVersion(readFileSync(join(repo, 'crates', 'napi', 'Cargo.toml'), 'utf8'));
  const iface = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+/.test(iface)) throw new Error('apps/desktop/package.json has no x.y.z version');
  return { engine, interface: iface, ...(process.env.POM_OFFICIAL_BUILD === '1' ? { official: true, backend: backendFromEnv() } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const v = stamp();
  mkdirSync(join(desktop, 'dist'), { recursive: true });
  writeFileSync(join(desktop, 'dist', 'versions.json'), JSON.stringify(v) + '\n');
  console.log('stamped', JSON.stringify({ ...v, ...(v.backend ? { backend: 'set' } : {}) }));
}
