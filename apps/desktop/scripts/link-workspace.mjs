// Points <checkout>/node_modules/@pom/<name> at this checkout's packages/<name>, then builds those packages.
// A linked git worktree nested inside the main checkout shares that checkout's node_modules through a link. Writing
// @pom through it would repoint the main checkout's links, so the link is removed (the link only, never its target)
// and the worktree gets its own node_modules/@pom; every other dependency still resolves from the folders above. A
// worktree outside the main checkout cannot resolve upward, so its shared link is left alone.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packages = ['protocol', 'mastery-contracts'];
const nm = join(root, 'node_modules');
const scope = join(nm, '@pom');

/** True when this checkout is a linked git worktree that sits inside the main checkout's folder. */
function insideMainCheckout() {
  try {
    if (!lstatSync(join(root, '.git')).isFile()) return false;
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    const main = resolve(dirname(common)).toLowerCase();
    return resolve(root).toLowerCase().startsWith(main + sep);
  } catch { return false; }
}
let sharedNm = false;
try { sharedNm = lstatSync(nm).isSymbolicLink(); } catch { /* missing */ }
if (sharedNm && insideMainCheckout()) {
  rmSync(nm); // non-recursive on the link itself: never follows it into the target
  sharedNm = false;
}
if (!sharedNm) mkdirSync(scope, { recursive: true });
else console.warn(`${nm} is a shared link and deps do not resolve upward from here: @pom links not changed.`);

const same = (a, b) => resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase();
for (const name of sharedNm ? [] : packages) {
  const target = join(root, 'packages', name);
  const link = join(scope, name);
  let current = null;
  try {
    if (lstatSync(link).isSymbolicLink()) current = readlinkSync(link);
    else current = link; // a real folder (an installed copy): replace it with the link
  } catch { /* missing */ }
  if (current && same(current, target)) continue;
  if (current) rmSync(link, { recursive: current === link, force: true });
  symlinkSync(target, link, 'junction');
  console.log(`linked ${link} -> ${target}`);
}

if (!process.argv.includes('--no-build')) {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  for (const name of packages) {
    const dir = join(root, 'packages', name);
    if (!existsSync(join(dir, 'tsconfig.json'))) continue;
    execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { stdio: 'inherit' });
  }
}
