// Release build step (`npm run build:validated`, part of `npm run build`): runs the app's own validators over the bundled data and
// writes their records to dist/validated, which ships inside the app package with the code that made them.
//   dist/validated/atlas.json     one record per Atlas pack file that passed AtlasRegistry's full validation
//   dist/validated/starters.json  the starter qualification snapshot (cards + runtime-rule inputs), keyed by the pack's input digest
// Each file is keyed by the SHA-256 of the exact bytes validated, under the identity app version + validator code hash
// (src/main/validationCache.ts). The app re-hashes the files it loads and uses a record only on an exact match, so the first launch
// skips re-validating untouched release files and validates anything else in full.
// Run after build:main (it imports dist/). Exits non-zero when a bundled file fails validation: such a build must not ship.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const dist = (rel) => pathToFileURL(join(app, 'dist', rel)).href;
const { ValidationCache, validatorIdentity } = await import(dist('main/validationCache.js'));
const { atlasValidatorFiles, bundledRecords, starterBundle, BUNDLED_RECORDS_DIR } = await import(dist('main/validatedResources.js'));
const { AtlasRegistry } = await import(dist('main/atlas/registry.js'));
const { MASTERY_LIMITS } = await import(dist('main/mastery/context.js'));
const { starterInputs, qualifiedSameInputs } = await import(dist('main/mastery/starters.js'));
// app.getVersion() is this package.json's version, packaged or not.
const version = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version;

mkdirSync(BUNDLED_RECORDS_DIR, { recursive: true });
const t0 = performance.now();

// Atlas: the same registry, policy and limits wireAtlas uses, over the bundled archive (resources/atlas).
{
  rmSync(bundledRecords('atlas'), { force: true });
  const cache = await ValidationCache.open(bundledRecords('atlas'), await validatorIdentity(version, await atlasValidatorFiles()), { writer: true });
  const scratch = mkdtempSync(join(tmpdir(), 'pom-prevalidate-'));
  try {
    const registry = new AtlasRegistry(scratch, join(repo, 'resources', 'atlas'), { limits: MASTERY_LIMITS, maxSourceBytes: 200_000_000 }, { cache });
    await registry.init(); // throws on any pack that fails validation
    await cache.save();
    console.log(`atlas: ${cache.size} pack record(s) -> ${bundledRecords('atlas')}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// Starters: the release qualification (the same bundle the app runs), recorded only if no input changed while it ran.
{
  rmSync(bundledRecords('starters'), { force: true });
  const dir = join(repo, 'resources', 'mastery-starters');
  const bundle = starterBundle();
  const cache = await ValidationCache.open(bundledRecords('starters'), await validatorIdentity(version, [bundle]), { writer: true });
  const before = await starterInputs(dir);
  const snapshot = await createRequire(import.meta.url)(bundle).qualifyStarters(dir);
  const after = await starterInputs(dir);
  if (!qualifiedSameInputs(snapshot, before, after)) throw new Error('The starter pack changed while it was qualified.');
  cache.record(before.digest, snapshot);
  await cache.save();
  console.log(`starters: ${snapshot.release.current.length} current starter(s) -> ${bundledRecords('starters')}`);
}
console.log(`prevalidate: done in ${Math.round(performance.now() - t0)} ms (app ${version})`);
