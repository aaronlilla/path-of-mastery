// Packaging guard: refuses to build an installer with an electron-builder whose NSIS template crashes fresh installs.
//
// app-builder-lib before the fix (25.1.8 has the bug; package-lock.json pins 26.15.3) reads the
// per-user Program Files path with `System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'`: it copies NSIS_MAX_STRLEN wide chars
// out of a short CoTaskMemAlloc string, reading past the end of the heap block. On a FRESH per-user install (no previous
// InstallLocation in the registry) the 32-bit installer then dies with 0xC0000005 in System.dll+0x1581 whenever the
// string sits near the end of committed heap: 4 of 10 fresh silent installs crashed in testing. Updates never take that
// branch. The fixed template uses lstrcpynW.
//
//   node scripts/check-builder.mjs [path to an electron-builder package dir]   (exit 1 = do not package)
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builderDir = process.argv[2] ? resolve(process.argv[2]) : dirname(createRequire(join(desktop, 'package.json')).resolve('electron-builder/package.json'));
const abl = dirname(createRequire(join(builderDir, 'package.json')).resolve('app-builder-lib/package.json'));
const template = join(abl, 'templates', 'nsis', 'multiUser.nsh');
const version = JSON.parse(readFileSync(join(abl, 'package.json'), 'utf8')).version;
const nsh = existsSync(template) ? readFileSync(template, 'utf8') : '';
const buggy = /\*\$2\(&w\$\{NSIS_MAX_STRLEN\}\s*\.s\)/.test(nsh);
if (!nsh) {
  console.error(`check-builder: ${template} not found`);
  process.exit(1);
}
if (buggy) {
  console.error(
    `check-builder: app-builder-lib ${version} (${abl}) has the NSIS per-user install-path over-read that crashes fresh installs with 0xC0000005.\n` +
      'Install the locked version first (package-lock.json pins electron-builder 26.15.3): run `npm ci` at the repository root.',
  );
  process.exit(1);
}
console.log(`check-builder: app-builder-lib ${version} NSIS template is safe (bounded lstrcpynW copy)`);
