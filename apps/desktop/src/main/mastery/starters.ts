// First-launch starter chooser. The qualifier runs over the bundled pack (tools/mastery-starters/chooser.ts, bundled to
// dist/mastery-starters/chooser.cjs by `build:starters`); the renderer gets display cards only. Follow hands back one build's XML for
// the Builds library. Nothing is fetched and no sign-in is needed.
//   'mastery:starters'  { method: 'state' } -> StarterChooser;  { method: 'build', starterId } -> { name, xml }
//
// Start-up: the qualification takes 6-10 s, so the release build runs it (`npm run build:validated`) and ships its result (display
// cards and the runtime rule's inputs, no build XML) in dist/validated, inside the app package, keyed by the SHA-256 of every file
// the qualifier reads. Each start re-hashes those files and uses the record only when every byte and the qualifier bundle itself are
// unchanged; then only the cheap runtime rule (flag, league end, active league) runs. Otherwise the pack is qualified in full on a
// worker thread that starts with main (every start: nothing is recorded in userData, see main/validationCache.ts). Following a
// starter reads its XML from the pack, after checking the manifest still hashes to the one the qualification passed on.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { MasteryContext } from './context.js';
import { startupMark, startupStep } from '../startupTrace.js';
import { sha256, ValidationCache, validatorIdentity } from '../validationCache.js';
import { bundledRecords, starterBundle } from '../validatedResources.js';

type Snapshot = { schemaVersion: 1; release: { current: unknown[]; buildable: string[] }; inputs?: Record<string, string> };
type Inputs = { digest: string; manifest: string; files: Record<string, string> };
type View = { chooserFor(o: { now?: string; flag?: boolean | null; activeLeagueId?: string | null }): unknown; canBuild(starterId: string): boolean };
type StarterModule = {
  startersFrom(snapshot: Snapshot): View;
  starterBuild(dir: string, starterId: string, manifestSha256: string): Promise<{ name: string; xml: string }>;
};
type Loaded = { view: View; manifest: string; mod: StarterModule };

/**
 * Remote flag `starters.current`, read from the cached remote-config document when one exists
 * (<userData>/remote-config.json, `flags['starters.current'].state`). Fail-safe: no document, unreadable or the key absent = on.
 * POM_STARTERS_CURRENT=off is the same switch for tests.
 */
export function readStartersFlag(userDataDir: string, env: NodeJS.ProcessEnv = process.env): boolean | null {
  if (env.POM_STARTERS_CURRENT === 'off') return false;
  try {
    const state = (JSON.parse(readFileSync(join(userDataDir, 'remote-config.json'), 'utf8')) as { flags?: Record<string, { state?: unknown }> }).flags?.['starters.current']?.state;
    return state === 'off' ? false : state === 'on' ? true : null;
  } catch { return null; }
}
export const STARTERS_CHANNEL = 'mastery:starters';

/**
 * The league the app is working in: the active workspace's verified league (main's workspace manifest). Null when there is no
 * workspace yet (first run, no verified league) or it cannot be read; then only the pack's own league rules apply.
 */
export function activeLeagueId(ctx: Pick<MasteryContext, 'workspaces'>): string | null {
  try {
    const league = ctx.workspaces?.active().stamp.leagueId;
    return league && league.status === 'known' ? String(league.value) : null;
  } catch { return null; }
}

/** One digest over the SHA-256 of every file the qualifier reads (manifest, live context, scope, every blob), and the manifest's own. */
export async function starterInputs(dir: string): Promise<Inputs> {
  const names = ['manifest.json', 'live-context.json', 'scope.json', ...(await readdir(join(dir, 'blobs'))).sort().map(name => `blobs/${name}`)];
  const all = createHash('sha256');
  const files: Record<string, string> = {};
  for (const rel of names) {
    files[rel] = sha256(await readFile(join(dir, rel)));
    all.update(`${rel} ${files[rel]}\n`);
  }
  return { digest: all.digest('hex'), manifest: files['manifest.json']!, files };
}

/**
 * True when a qualification read exactly the files hashed before and after it: the three JSON inputs it parsed hash to the same
 * digests as `before`, and nothing changed between `before` and `after`. Only then may its snapshot stand for those bytes.
 */
export function qualifiedSameInputs(snapshot: Snapshot, before: Inputs, after: Inputs): boolean {
  const read = snapshot.inputs;
  return before.digest === after.digest && !!read && ['manifest.json', 'live-context.json', 'scope.json'].every(name => read[name] === before.files[name]);
}

const isSnapshot = (v: unknown): v is Snapshot => {
  const s = v as Snapshot | null;
  return !!s && s.schemaVersion === 1 && !!s.release && Array.isArray(s.release.current) && Array.isArray(s.release.buildable);
};

/**
 * The starter chooser's data: the cached snapshot when every input byte and the qualifier are unchanged, otherwise a full
 * qualification on a worker thread (recorded when the inputs did not change while it ran). Exported for the cache tests.
 */
export async function loadStarterView(o: { dir: string; bundle: string; records: string | null; writer?: boolean; appVersion: string;
  onWorker?(w: Worker | null): void }): Promise<Loaded & { cached: boolean }> {
  const mod = createRequire(import.meta.url)(o.bundle) as StarterModule;
  const cache = await ValidationCache.open(o.records, await validatorIdentity(o.appVersion, [o.bundle]), { writer: o.writer });
  const inputs = await starterInputs(o.dir);
  const hit = cache.lookup<unknown>(inputs.digest);
  if (isSnapshot(hit)) {
    try { return { view: mod.startersFrom(hit), manifest: inputs.manifest, mod, cached: true }; }
    catch { cache.forget(inputs.digest); } // an unusable record: qualify again
  }
  // A pack that changes while it is qualified is qualified again; its result is used only for the bytes it actually read.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = attempt === 0 ? inputs : await starterInputs(o.dir);
    const snapshot = await qualifyOnWorker(o.bundle, o.dir, o.onWorker);
    const after = await starterInputs(o.dir);
    if (!qualifiedSameInputs(snapshot, before, after)) continue;
    cache.record(before.digest, snapshot); await cache.save();
    return { view: mod.startersFrom(snapshot), manifest: before.manifest, mod, cached: false };
  }
  throw new Error('The starter pack kept changing while it was qualified.');
}

function qualifyOnWorker(bundle: string, dir: string, onWorker?: (w: Worker | null) => void): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(bundle, { workerData: { job: 'qualify-starters', dir } });
    onWorker?.(worker);
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; onWorker?.(null); fn(); void worker.terminate(); };
    worker.once('message', (m: { ok: true; snapshot: unknown } | { ok: false; message: string }) => finish(() => {
      if (m.ok && isSnapshot(m.snapshot)) resolve(m.snapshot);
      else reject(new Error(m.ok ? 'The starter qualification returned no snapshot.' : m.message));
    }));
    worker.once('error', e => finish(() => reject(e)));
    worker.once('exit', code => finish(() => reject(new Error(`The starter qualification stopped (${code}).`))));
  });
}

export function wireStarters(ctx: MasteryContext, paths: { dir?: string; bundle?: string; records?: string | null } = {}): { dispose(): void } {
  // Scripted runs only (POM_AUTOMATION=1): POM_STARTERS_DIR points at another pack, e.g. a missing one to show the load failure.
  const testDir = process.env.POM_AUTOMATION === '1' ? process.env.POM_STARTERS_DIR : undefined;
  const dir = paths.dir ?? testDir ?? (ctx.isPackaged ? join(process.resourcesPath, 'mastery-starters') : fileURLToPath(new URL('../../../../../resources/mastery-starters', import.meta.url)));
  const bundle = paths.bundle ?? starterBundle();
  const records = paths.records !== undefined ? paths.records : bundledRecords('starters');
  let worker: Worker | null = null;
  let loaded: Promise<Loaded> | null = null;
  const load = (): Promise<Loaded> => (loaded ??= startupStep('starters load', async () => {
    const r = await loadStarterView({ dir, bundle, records, appVersion: ctx.appVersion ?? '', onWorker: w => { worker = w; } });
    startupMark(r.cached ? 'starters from the release record' : 'starters qualified on a worker thread');
    return r;
  }).catch((e) => { loaded = null; throw e; }));
  // Starts with main, so the chooser's first request finds it done (or nearly) instead of starting it.
  void load().catch((e: unknown) => console.warn('Starters unavailable:', e instanceof Error ? e.message : String(e)));
  ctx.ipc.handle(STARTERS_CHANNEL, async (event, input) => {
    try {
      if (!ctx.isMainSender(event)) throw new TypeError('not trusted');
      const call = (input ?? {}) as { method?: unknown; starterId?: unknown };
      const starters = await load();
      if (call.method === 'state') return { ok: true, value: starters.view.chooserFor({ flag: readStartersFlag(ctx.userDataDir), activeLeagueId: activeLeagueId(ctx) }) };
      if (call.method === 'build' && typeof call.starterId === 'string') {
        if (!starters.view.canBuild(call.starterId)) throw new TypeError('This starter is not available.');
        try { return { ok: true, value: await starters.mod.starterBuild(dir, call.starterId, starters.manifest) }; }
        catch (e) { loaded = null; throw e; } // the pack changed under a cached result: qualify again next time
      }
      throw new TypeError('Starter request is unsupported.');
    } catch (e) {
      console.warn('Starters unavailable:', e instanceof Error ? e.message : String(e));
      return { ok: false, error: { code: 'UNAVAILABLE', message: 'Starters are unavailable right now.' } };
    }
  });
  return { dispose: () => { ctx.ipc.removeHandler(STARTERS_CHANNEL); void worker?.terminate(); } };
}
