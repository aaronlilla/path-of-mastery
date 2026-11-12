// Copies the native engine (a crates/napi build) to resources/engine/pom_napi.node, where electron-builder picks it up
// as an extra resource (electron-builder.yml). The packaged app loads it from <resources>/engine (src/main/config.ts).
// Build it first: `cargo build --profile fastrun -p pom-napi --target-dir target-fastrun` (for shipping: `node tools/build-engine.mjs`, which keeps build-machine paths out of the addon).
// POM_ADDON_BUILD=<path to pom_napi.dll / libpom_napi.so / libpom_napi.dylib> overrides the default location.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const lib = process.platform === 'win32' ? 'pom_napi.dll' : process.platform === 'darwin' ? 'libpom_napi.dylib' : 'libpom_napi.so';
const candidates = [
  process.env.POM_ADDON_BUILD,
  join(repo, 'target-fastrun', 'release', lib),
  join(repo, 'target-fastrun', 'fastrun', lib),
  join(repo, 'target', 'release', lib),
].filter(Boolean);
const src = candidates.find((p) => existsSync(p));
if (!src) {
  console.error('No native engine build found. Looked in:\n  ' + candidates.join('\n  ') + '\nBuild crates/napi first (see this script) or set POM_ADDON_BUILD.');
  process.exit(1);
}
// A build output goes stale against the Rust source: refuse an addon older than the newest commit touching crates/ or vendor/.
try {
  const newest = Number(execFileSync('git', ['log', '-1', '--format=%ct', '--', 'crates', 'vendor'], { cwd: repo, encoding: 'utf8' }).trim());
  if (newest && statSync(src).mtimeMs / 1000 < newest) {
    console.error(`The native engine ${src} is older than the newest commit touching crates/ or vendor/ (${new Date(newest * 1000).toISOString()}). Rebuild it (see the top of this file) and run this again.`);
    process.exit(1);
  }
} catch (e) {
  console.warn('engine freshness not checked (no git history here):', e instanceof Error ? e.message.split('\n')[0] : e);
}
const out = join(here, '..', 'resources', 'engine');
mkdirSync(out, { recursive: true });
copyFileSync(src, join(out, 'pom_napi.node'));
console.log(`engine staged: ${src} -> resources/engine/pom_napi.node (${(statSync(src).size / 1e6).toFixed(1)} MB)`);
// resources/engine is a build output and is untracked (see .gitignore); electron-builder still packs it because extraResources lists it.
