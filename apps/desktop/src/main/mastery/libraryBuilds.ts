// Library Builds (the XML files under Builds) as Timeline sources. Each one is frozen once into a Documents-store 'build' object
// with its leveling guide (projectGuide); the Timeline source picker then lists it like any other own source.
// Freezing runs in the background, one build at a time, and pushes 'mastery:push:timeline-sources' when something new is ready.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseId, type BuildSnapshot, type LeagueStamp, type ObjectId } from '@pom/mastery-contracts';
import type { MasteryContext } from './context.js';
import { activeSpecOf, readFacts } from '../../shared/buildFacts.js';
import { projectGuide } from '../../shared/timelines/adapters/index.js';
import { LATEST_TREE_VERSION } from '../../shared/treeSets.js';
import { generateGuide, type GuideKit } from '../leveling/guideFor.js';
import { leagueOfTree, loadGemIndex, loadLevelingData } from '../leveling/data.js';
import { loadGameData } from '../lootfilter/buildData.js';
import { encodeBuildCode } from '../library/buildCode.js';
import { publicBuildXml } from '@pom/mastery-contracts/build-xml';
import { LEVELING_GUIDE } from '../../shared/leagueContent.js';

export const SOURCES_PUSH = 'mastery:push:timeline-sources';
/** The Builds library as main sees it (BuildStore). */
export type LibraryAccess = { list(): Promise<{ id: string; name: string; folder: string; mtimeMs: number }[]>; readXml(id: string): Promise<string>;
  /** BuildStore.signature: moves with every write to the file. */
  signature?(id: string): Promise<string> };
type Map_ = Record<string, { objectId: string; xmlHash: string; v?: number; noGuide?: boolean }>;
/** Version of the frozen form: 2 carries the build code, class and ascendancy (a Marketplace post's "Edit a copy" needs the code); 3 leaves the private notes and import account data out of that code. */
const FROZEN_VERSION = 4;
const MAX_BUILDS = 40;

/** The public build code: notes and import account data left out (parsed, not string-matched). A build file that is not valid XML gets none. */
function publicCode(xml: string): { buildCode?: string } {
  try { return { buildCode: encodeBuildCode(publicBuildXml(xml)) }; } catch { return {}; }
}

export type LibrarySources = ReturnType<typeof wireLibrarySources>;
export function wireLibrarySources(ctx: MasteryContext, library: LibraryAccess, activeStamp: () => LeagueStamp) {
  const file = join(ctx.userDataDir, 'mastery', 'library-sources.json');
  let map: Map_ | null = null;
  const load = async (): Promise<Map_> => {
    if (map) return map;
    try { map = JSON.parse(await readFile(file, 'utf8')) as Map_; } catch { map = {}; }
    return map;
  };
  const save = async () => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(map ?? {}), 'utf8');
    await rename(tmp, file);
  };
  let kit: Promise<GuideKit> | null = null;
  const getKit = () => (kit ??= (async () => {
    const engineDir = process.env.POM_ENGINE_DATA ?? '';
    const { data } = await loadLevelingData(join(ctx.resourcesDir, 'leveling'), leagueOfTree(LATEST_TREE_VERSION));
    return { data, idx: await loadGemIndex(engineDir, data), engineDir, game: () => loadGameData(engineDir) } satisfies GuideKit;
  })());

  /** Freezes one library build (or reuses the frozen copy while its XML is unchanged). Returns the Documents-store object id. */
  async function freeze(libraryId: string, name: string): Promise<ObjectId> {
    const m = await load();
    const xml = await library.readXml(libraryId);
    const xmlHash = createHash('sha256').update(xml).digest('hex');
    const known = m[libraryId];
    let expected: ReturnType<typeof ctx.documents.list>[number]['revisionId'] | null = null;
    if (known) {
      const row = ctx.documents.list().find(r => r.objectId === known.objectId);
      if (row && known.xmlHash === xmlHash && known.v === FROZEN_VERSION && (known.noGuide ?? false) === !LEVELING_GUIDE) return known.objectId as ObjectId;
      if (row) expected = row.revisionId;
    }
    const stamp = activeStamp();
    // Parked leveling guide (shared/leagueContent.ts): no guide is generated and no leveling data is loaded.
    const guide = LEVELING_GUIDE ? await projectGuide(await generateGuide(await getKit(), xml, undefined, true), stamp) : [];
    const facts = readFacts(xml), spec = activeSpecOf(facts);
    const payload: BuildSnapshot = { schemaVersion: 1, title: name, stamp, treeNodes: (spec?.nodes ?? []).map(String), skills: [], gear: [], configuration: [],
      calculatedStats: { status: 'unknown', reason: 'Not calculated for a Timeline source.' }, notes: 'Frozen from your Builds library.', guide,
      ...publicCode(xml), ...(facts.className ? { className: facts.className.slice(0, 40) } : {}), ...(facts.ascendClassName ? { ascendancy: facts.ascendClassName.slice(0, 40) } : {}) };
    const objectId = (known && expected ? known.objectId : randomUUID()) as ObjectId;
    await ctx.documents.write('build', { objectId: parseId('object', objectId), expectedRevisionId: expected, payload, stamp, idempotencyKey: randomUUID() }, { label: 'Frozen from library' });
    m[libraryId] = { objectId, xmlHash, v: FROZEN_VERSION, ...(LEVELING_GUIDE ? {} : { noGuide: true }) };
    await save();
    return objectId;
  }

  let running: Promise<void> | null = null;
  /** Freezes the newest library builds that have no up-to-date copy yet. Safe to call repeatedly: a call during a run waits for that run. */
  function refresh(): Promise<void> {
    if (running) return running;
    running = (async () => {
      const rows = (await library.list()).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_BUILDS);
      let changed = false;
      for (const row of rows) {
        try {
          const before = JSON.stringify((await load())[row.id] ?? null);
          await freeze(row.id, row.name);
          if (before !== JSON.stringify((await load())[row.id] ?? null)) changed = true;
        } catch (e) { console.warn(`Library build "${row.id}" could not be frozen for Timelines:`, e instanceof Error ? e.message : String(e)); }
        if (changed) { ctx.push(SOURCES_PUSH, null); changed = false; }
      }
    })().finally(() => { running = null; });
    return running;
  }
  return { freeze, refresh, objectOf: (libraryId: string): string | null => map?.[libraryId]?.objectId ?? null };
}
