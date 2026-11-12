// Where the validation records for the bundled data live, and which code files make up each validator's identity
// (main/validationCache.ts). Shared by the app (mastery/atlas.ts, mastery/starters.ts) and the release build step
// scripts/prevalidate.mjs, so both compute the same identity from the same files.
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** dist/validated: the release's records, written by `npm run build:validated` and shipped inside the app package. */
export const BUNDLED_RECORDS_DIR = here('../validated');
export const bundledRecords = (kind: 'atlas' | 'starters'): string => join(BUNDLED_RECORDS_DIR, `${kind}.json`);

/**
 * The code that validates an Atlas pack: the registry, the pack digests, the graph checks, the validation limits the app passes
 * (mastery/context.js) and the contract schemas. Its bytes are part of the identity, so records made by another build never count.
 */
export async function atlasValidatorFiles(): Promise<string[]> {
  const contracts = dirname(createRequire(import.meta.url).resolve('@pom/mastery-contracts'));
  const contractFiles = (await readdir(contracts)).filter(name => name.endsWith('.js')).map(name => join(contracts, name));
  return [here('./atlas/registry.js'), here('./kb/sources/atlas.js'), here('../shared/atlas/graph.js'), here('./mastery/context.js'), ...contractFiles];
}

/** The starter qualifier is one bundle (tools/mastery-starters/chooser.ts, with its policy and the contract schemas inside). */
export const starterBundle = (): string => here('../mastery-starters/chooser.cjs');
