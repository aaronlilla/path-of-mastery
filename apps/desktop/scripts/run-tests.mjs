// npm test: runs every compiled test in dist-test/test. Most tests resolve files from apps/desktop; the Atlas /
// Timeline / Run packages were written against the repository root, so those run with the repo
// root as their working directory. Renderer .css imports load as empty modules (scripts/test-hooks), and the
// Atlas solver worker is the tsc-compiled one. Concurrency stays at 2 on this machine (pass --concurrency=N).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const dir = join(app, 'dist-test', 'test');
const concurrency = process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '2';
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const ROOT_CWD = new Set(['atlas-domain', 'atlas-exact', 'mastery-formats', 'run-telemetry', 'timeline-adapters']);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).filter((f) => only.length === 0 || only.some((o) => f.includes(o)));
const groups = [
  { cwd: app, files: files.filter((f) => !ROOT_CWD.has(f.replace('.test.js', ''))) },
  { cwd: repo, files: files.filter((f) => ROOT_CWD.has(f.replace('.test.js', ''))) },
];
const env = {
  ...process.env,
  P11_WORKER: process.env.P11_WORKER ?? join(app, 'dist-test', 'src', 'main', 'atlas', 'solver.worker.js'),
  P12_REPO_ROOT: process.env.P12_REPO_ROOT ?? repo,
  POM_P24_ROOT: process.env.POM_P24_ROOT ?? repo,
  // Electron's main process (Node 20) runs the WASM SQLite driver; the document tests assert that driver.
  KB_SQLITE_DRIVER: process.env.KB_SQLITE_DRIVER ?? 'wasm',
};
if (!process.env.POM_ENGINE_DATA && existsSync(join(repo, 'engine-data'))) env.POM_ENGINE_DATA = join(repo, 'engine-data');

let status = 0;
for (const g of groups) {
  if (g.files.length === 0) continue;
  const r = spawnSync(process.execPath, [
    '--import', pathToFileURL(join(app, 'scripts', 'test-hooks', 'register.mjs')).href,
    '--test', `--test-concurrency=${concurrency}`, ...g.files.map((f) => join(dir, f)),
  ], { cwd: g.cwd, env, stdio: 'inherit' });
  if (r.status !== 0) status = r.status ?? 1;
}
process.exit(status);
