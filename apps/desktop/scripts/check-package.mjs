// Packaging-time check: fails (exit 1) when the unpacked app is missing something the installed app needs.
// usage: node scripts/check-package.mjs [path to the *-unpacked folder]   (default: release/win-unpacked or the first release/*-unpacked)
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const repo = resolve(desktop, '..', '..');
const release = join(desktop, 'release');
// Windows and Linux builds leave release/<os>-unpacked; a Mac build leaves release/mac-arm64/<name>.app.
const macApp = existsSync(release) ? readdirSync(release).filter((d) => d.startsWith('mac')).flatMap((d) => readdirSync(join(release, d)).filter((a) => a.endsWith('.app')).map((a) => join(release, d, a)))[0] : undefined;
const unpacked = process.argv[2] ?? (existsSync(release) ? readdirSync(release).filter((d) => d.endsWith('-unpacked')).map((d) => join(release, d))[0] : undefined) ?? macApp;
if (!unpacked || !existsSync(unpacked)) {
  console.error('check-package: no unpacked app found (run electron-builder --dir first).');
  process.exit(1);
}
const resources = existsSync(join(unpacked, 'resources')) ? join(unpacked, 'resources') : join(unpacked, 'Contents', 'Resources');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// The native engine: next to app.asar, a real binary.
const addon = join(resources, 'engine', 'pom_napi.node');
ok(existsSync(addon), `engine: ${addon} is missing (build crates/napi, then run scripts/stage-engine.mjs)`);
ok(existsSync(addon) && statSync(addon).size > 5e6, `engine: ${addon} missing or smaller than 5 MB (run scripts/stage-engine.mjs)`);
if (existsSync(addon)) {
  const fd = openSync(addon, 'r'); const b = Buffer.alloc(4); readSync(fd, b, 0, 4, 0); closeSync(fd);
  const magic = b.toString('latin1');
  ok(magic.startsWith('MZ') || magic === '\x7fELF' || b.readUInt32BE(0) === 0xcffaedfe, 'engine: pom_napi.node is not an executable library');
}

// The data folder: the files the engine reads (src/main/engineDataDir.ts), every tree version, no answer keys.
const data = join(resources, 'engine-data');
const srcData = join(repo, 'engine-data');
for (const f of ['data_index.json', 'data_gems.json', 'data_skills.json', 'parse_cache.bin']) ok(existsSync(join(data, f)), `engine-data: ${f} missing`);
const want = existsSync(srcData) ? readdirSync(srcData).filter((f) => /^(data_.*|tree_.*)\.json$/.test(f)) : [];
const have = existsSync(data) ? new Set(readdirSync(data)) : new Set();
const missing = want.filter((f) => !have.has(f));
ok(want.length > 0 && missing.length === 0, `engine-data: ${missing.length} of ${want.length} data/tree files missing, e.g. ${missing.slice(0, 3).join(', ')}`);
ok(want.filter((f) => f.startsWith('tree_')).length >= 41, 'engine-data: fewer than 41 tree versions in the source');
const stray = existsSync(data) ? readdirSync(data).filter((f) => !/^(data_.*|tree_.*|synergies)\.json$|^parse_cache\.bin$/.test(f)) : [];
ok(stray.length === 0, `engine-data: files the app should not ship: ${stray.slice(0, 5).join(', ')}`);

// The timeless jewel tables, compressed, with the manifest the app inflates them by (src/main/timelessData.ts).
const timeless = join(resources, 'timeless');
ok(existsSync(join(timeless, 'manifest.json')) && existsSync(join(timeless, 'NodeIndexMapping.lua')), 'timeless: manifest.json or NodeIndexMapping.lua missing (run scripts/pack-timeless.mjs; git lfs pull)');
if (existsSync(join(timeless, 'manifest.json'))) {
  const manifest = JSON.parse(readFileSync(join(timeless, 'manifest.json'), 'utf8'));
  const names = manifest.files.map((f) => f.name);
  for (const need of ['GloriousVanity', 'LethalPride', 'BrutalRestraint', 'MilitantFaith', 'ElegantHubris', 'HeroicTragedy', 'AbyssTecrod', 'AbyssUlaman', 'AbyssKurgal', 'AbyssAmanamu', 'AbyssZorath']) ok(names.includes(need), `timeless: ${need} is not in the manifest`);
  let packedTotal = 0;
  for (const f of manifest.files) {
    const p = join(timeless, f.name + '.br');
    const size = existsSync(p) ? statSync(p).size : -1;
    packedTotal += Math.max(size, 0);
    ok(size === f.packed, `timeless: ${f.name}.br is ${size} bytes, the manifest says ${f.packed} (an LFS pointer file? run git lfs pull)`);
  }
  ok(packedTotal > 130e6, `timeless: the tables are ${(packedTotal / 1e6).toFixed(1)} MB, expected over 130 MB`);
}

// Beside the asar: the loot filter base and the MCP bridge Claude Desktop launches.
ok(existsSync(join(resources, 'neversink')) && readdirSync(join(resources, 'neversink')).length > 0, 'neversink: missing');
ok(existsSync(join(resources, 'mcp', 'bridge.cjs')), 'mcp/bridge.cjs missing');
ok(existsSync(join(resources, 'atlas', 'archive.json')), 'atlas/archive.json missing');
// The Atlas canvas art: every official sprite sheet at all five zoom levels (40; the hover-only mastery overlay stays out).
ok(existsSync(join(resources, 'atlas', 'sources')), 'atlas/sources missing (no Atlas art)');
for (const dir of existsSync(join(resources, 'atlas', 'sources')) ? readdirSync(join(resources, 'atlas', 'sources')) : []) {
  const assets = join(resources, 'atlas', 'sources', dir, 'official', 'assets');
  if (!existsSync(assets)) continue;
  const sheets = readdirSync(assets).filter((f) => /\.(png|jpg)$/.test(f));
  console.log(`atlas art: ${sheets.length} sheets in atlas/sources/${dir}/official/assets`);
  ok(sheets.length === 40, `atlas art: ${sheets.length} sheets in ${dir}, expected 40`);
  const league = join(assets, '..', 'assets-league');
  ok(existsSync(join(assets, '..', 'assets-league.json')) && existsSync(league) && readdirSync(league).length === 16, `atlas art: league sheets (16) missing in ${dir}`);
}

// Inside app.asar: code, renderer with all art, and the runtime packages main imports.
const require = createRequire(import.meta.url);
const asar = require(require.resolve('@electron/asar', { paths: [repo, desktop] }));
const inside = new Set(asar.listPackage(join(resources, 'app.asar')).map((p) => p.replace(/\\/g, '/').replace(/^\//, '')));
for (const f of ['dist/main/boot.js', 'dist/main/index.js', 'dist/engine-host/main.js', 'dist/preload/index.cjs', 'dist/renderer/index.html', 'node_modules/zod/package.json', 'node_modules/@modelcontextprotocol/sdk/package.json', 'node_modules/@pom/protocol/dist/index.js',
  // The new areas' contracts, the Run window page and its restricted preload, the Atlas solver worker, and the
  // WASM SQLite driver the document, workspace, Run and Marketplace stores open.
  'node_modules/@pom/mastery-contracts/dist/index.js', 'dist/renderer/run/index.html', 'dist/main/run/preload.cjs',
  'dist/main/atlas/solver.worker.js', 'node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm']) {
  ok(inside.has(f), `app.asar: ${f} missing`);
}
const artRoot = join(desktop, 'src', 'renderer', 'public');
const countFiles = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(join(d, e.name)) : 1), 0);
for (const sub of ['game/tree', 'game/poe', 'game/ui', 'ds']) {
  const src = join(artRoot, sub);
  if (!existsSync(src)) continue;
  const packed = [...inside].filter((p) => p.startsWith(`dist/renderer/${sub}/`)).length;
  ok(packed >= countFiles(src), `app.asar: dist/renderer/${sub} has ${packed} files, source has ${countFiles(src)}`);
}
for (const v of existsSync(join(artRoot, 'game', 'tree')) ? readdirSync(join(artRoot, 'game', 'tree')) : []) {
  ok([...inside].some((p) => p.startsWith(`dist/renderer/game/tree/${v}/`)) || !statSync(join(artRoot, 'game', 'tree', v)).isDirectory(), `app.asar: tree art for ${v} missing`);
}

if (failures.length) {
  console.error('check-package FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`check-package ok: ${unpacked} (engine ${(statSync(addon).size / 1e6).toFixed(1)} MB, ${want.length} data files, ${inside.size} files in app.asar)`);
