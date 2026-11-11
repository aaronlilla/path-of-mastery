#!/usr/bin/env node
// Builds the game knowledge base from its sources: GGG's patch CDN (datamined tables),
// the patch-notes forum, and the data the app already ships. Needs `npm run build:main` first (it runs the compiled
// src/main/kb). Idempotent; each run appends what changed to .kb-cache/kb-build.log.jsonl.
// Output: the working copy .kb-cache/kb.sqlite and the shipped snapshot
// resources/kb/kb.sqlite.br + kb-manifest.json (skip with --no-pack).
//
//   node scripts/kb-build.mjs                 all sources
//   node scripts/kb-build.mjs --only forum    refresh one source, keep the others from the current file
//   node scripts/kb-build.mjs --out <file>    write elsewhere
//   node scripts/kb-build.mjs --fresh         re-fetch everything (sources normally reuse old forum threads)
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const repo = resolve(desktop, '..', '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const built = join(desktop, 'dist', 'main', 'kb', 'build.js');
if (!existsSync(built)) {
  console.error('dist/main/kb/build.js is missing: run `npm run build:main` in apps/desktop first.');
  process.exit(1);
}
const { buildKb } = await import(pathToFileURL(built).href);
const { packSnapshot, ensureWorkingCopy } = await import(pathToFileURL(join(desktop, 'dist', 'main', 'kb', 'snapshot.js')).href);
const cacheDir = join(repo, '.kb-cache');
const out = resolve(arg('--out') ?? join(cacheDir, 'kb.sqlite'));
const snapshot = join(desktop, 'resources', 'kb', 'kb.sqlite.br');
// start from the shipped snapshot when there is no working copy (so --only keeps the other sources' rows)
if (!arg('--out')) await ensureWorkingCopy(snapshot, out);
const only = arg('--only')?.split(',');
const t0 = Date.now();
try {
  const report = await buildKb({
    out,
    cacheDir,
    app: {
      levelingDir: join(desktop, 'resources', 'leveling'),
      lootfilterDir: join(desktop, 'resources', 'lootfilter'),
      engineDataDir: process.env.POM_ENGINE_DATA ?? join(repo, 'engine-data'),
    },
    only,
    force: process.argv.includes('--force'),
    fresh: process.argv.includes('--fresh'),
    log: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`),
  });
  const manifest = {
    builtAt: report.builtAt,
    livePatch: report.livePatch,
    dataPatch: report.dataPatch,
    bytes: report.bytes,
    sources: report.sources.map(({ id, type, status, rows, patch, url }) => ({ id, type, status, rows, patch, url })),
    validation: report.validation,
  };
  if (!process.argv.includes('--no-pack') && !arg('--out')) {
    const br = await packSnapshot(out, snapshot, manifest);
    console.log(`snapshot ${snapshot}: ${(br / 1e6).toFixed(1)} MB`);
  }
  console.log('\nsources:');
  for (const s of report.sources) console.log(`  ${s.id.padEnd(6)} ${s.status.padEnd(7)} ${String(s.rows).padStart(7)} rows  patch ${s.patch}${s.error ? `  ERROR ${s.error}` : ''}`);
  console.log('changes:');
  for (const c of report.changes) if (c.added || c.removed || c.changed) console.log(`  ${c.table.padEnd(16)} ${c.before} -> ${c.after}  +${c.added} -${c.removed} ~${c.changed}`);
  if (!report.changes.some((c) => c.added || c.removed || c.changed)) console.log('  no changes');
  console.log('validation:');
  for (const c of report.validation.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name} ${c.detail}`);
  console.log(`\n${out}: ${(report.bytes / 1e6).toFixed(1)} MB, data patch ${report.dataPatch}, live ${report.livePatch}, ${(report.ms / 1000).toFixed(1)} s`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
