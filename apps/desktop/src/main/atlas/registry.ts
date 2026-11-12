import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { apiResultSchema, atlasDatasetSchema, parseId, type AtlasDataset, type DatasetRef, type Hash, type Known, type LeagueStamp } from '@pom/mastery-contracts';
import { ATLAS_VARIANT_FILES, atlasDatasetDigest, atlasPackDigest, canonicalJson, hashJson, writeAtlasPack,
  type AtlasBuildPolicy, type AtlasCatalogPointer, type AtlasPack, type AtlasVariant } from '../kb/sources/atlas.js';
import { flushDirectory } from '../documents/blobs.js';
import { AtlasDomainError, createGraph, known, unknown, type AtlasGraph } from '../../shared/atlas/graph.js';
import { sha256, type ValidationCache } from '../validationCache.js';
import { ATLAS_MECHANICS } from '../../shared/leagueContent.js';

export type AtlasCatalogView = {
  ref: DatasetRef; qualification: 'qualified' | 'unverified'; isCurrent: boolean;
  liveCompatibility: Known<'verified'>; statusText: string; warnings: AtlasPack['report']['issues'];
  exportTag: Known<string>; cdnPatchId: string; costs: Known<AtlasDataset['costModel']>;
  graph: AtlasGraph; catalogs: AtlasDataset['catalogs']; taxonomy: AtlasDataset['taxonomy'];
  catalogMetadata: AtlasPack['catalogMetadata']; geometry: AtlasPack['geometry']; sourceLayout: AtlasPack['sourceLayout'];
  nodeMetadata: AtlasPack['nodeMetadata']; assets: AtlasPack['assets'];
};
const boundedPackJson = apiResultSchema<unknown>({ parse: value => ({ ok: true, value }) });

export class AtlasRegistry {
  readonly root: string;
  private readonly packs = new Map<Hash, AtlasPack>();
  private readonly references = new Map<Hash, Hash>();
  private current: AtlasCatalogPointer | null = null;
  private retained: Record<string, Hash[]> = Object.create(null) as Record<string, Hash[]>;
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  warning: string | null = null;

  /** Records of pack files this installation already validated in full (main/validationCache.ts); null validates every read. */
  private readonly cache: ValidationCache | null;

  constructor(userData: string, private readonly resources: string, private readonly policy: AtlasBuildPolicy, options: { cache?: ValidationCache | null } = {}) {
    this.cache = options.cache ?? null;
    this.root = join(userData, 'mastery', 'atlas');
    if (!Number.isSafeInteger(policy.maxSourceBytes) || policy.maxSourceBytes <= 0) throw new AtlasDomainError('INVALID', 'Catalog byte limit must be positive.');
  }

  private async readJson(path: string): Promise<unknown> {
    if ((await stat(path)).size > this.policy.maxSourceBytes) throw new AtlasDomainError('INVALID', 'Catalog file exceeds the configured size limit.');
    const bytes = await readFile(path);
    if (bytes.length > this.policy.maxSourceBytes) throw new AtlasDomainError('INVALID', 'Catalog file exceeds the configured size limit.');
    return JSON.parse(bytes.toString()) as unknown;
  }

  /**
   * Reads one pack file and returns it validated. With a validation cache, bytes whose SHA-256 this installation already
   * validated with the same validator code are not validated again; any other bytes are validated in full and, when they
   * pass, recorded. Same size limits either way.
   */
  private async readPack(path: string): Promise<AtlasPack> {
    if ((await stat(path)).size > this.policy.maxSourceBytes) throw new AtlasDomainError('INVALID', 'Catalog file exceeds the configured size limit.');
    const bytes = await readFile(path);
    if (bytes.length > this.policy.maxSourceBytes) throw new AtlasDomainError('INVALID', 'Catalog file exceeds the configured size limit.');
    const input = JSON.parse(bytes.toString()) as unknown;
    if (!this.cache) return this.validate(input, true);
    const digest = sha256(bytes);
    const hit = this.cache.lookup<{ contentHash: string }>(digest);
    if (hit && (input as AtlasPack | null)?.contentHash === hit.contentHash) return input as AtlasPack; // freshly parsed: nothing else holds it
    const pack = this.validate(input, true);
    this.cache.record(digest, { contentHash: pack.contentHash });
    return pack;
  }

  private async optionalJson(path: string): Promise<unknown | null> {
    try { return await this.readJson(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  /** `owned`: the caller just parsed `input` and holds no other reference, so the validated pack is returned without a deep copy. */
  private validate(input: unknown, owned = false): AtlasPack {
    const bounded = boundedPackJson.parse({ ok: true, value: input }, this.policy.limits);
    if (!bounded.ok) throw new AtlasDomainError('INVALID', 'Atlas pack exceeds the configured validation limits or contains invalid JSON.');
    const pack = input as AtlasPack;
    try {
      if (!pack || pack.schemaVersion !== 1 || !Object.hasOwn(ATLAS_VARIANT_FILES, pack.variant) || !pack.datasetId ||
        atlasPackDigest(pack) !== parseId('hash', pack.contentHash) || hashJson(pack.report) !== pack.verificationReportHash ||
        pack.report.sourceManifestHash !== pack.sourceManifestHash || hashJson({ rootId: pack.graph.rootId, nodes: pack.graph.nodes }) !== pack.graph.graphHash) {
        throw new Error();
      }
      createGraph(pack.graph, pack.costs);
      if (pack.dataset) {
        const result = atlasDatasetSchema.parse(pack.dataset, this.policy.limits);
        if (!result.ok || atlasDatasetDigest(pack.dataset) !== pack.dataset.ref.contentHash ||
          pack.dataset.ref.datasetId !== pack.datasetId || pack.dataset.ref.variant !== pack.variant ||
          pack.dataset.verificationReportHash !== pack.verificationReportHash ||
          canonicalJson(pack.dataset.graph) !== canonicalJson(pack.graph) || canonicalJson(pack.dataset.catalogs) !== canonicalJson(pack.catalogs) ||
          canonicalJson(pack.dataset.taxonomy) !== canonicalJson(pack.taxonomy) || pack.costs.status !== 'known' ||
          canonicalJson(pack.dataset.costModel) !== canonicalJson(pack.costs.value) || canonicalJson(pack.dataset.ref.stamp) !== canonicalJson(pack.stamp)) throw new Error();
        createGraph(pack.dataset.graph, pack.costs);
      }
      for (const kind of ['maps', 'scarabs'] as const) {
        const ids = pack.catalogs[kind].map(row => row.catalogId);
        if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length ||
          pack.catalogs[kind].some(row => typeof row.name !== 'string' || !row.name || !Array.isArray(row.provenance))) throw new Error();
      }
      return owned ? pack : structuredClone(pack);
    } catch { throw new AtlasDomainError('INVALID', 'Atlas pack failed its identity or data checks.'); }
  }

  private qualified(pack: AtlasPack): boolean {
    const dataset = pack.dataset;
    if (!dataset || dataset.compatibility.status !== 'known' || dataset.compatibility.value !== 'verified' ||
      pack.report.liveCompatibility.status !== 'known' || pack.report.liveCompatibility.value !== 'verified' || pack.report.issues.length) return false;
    const stamp = dataset.ref.stamp, model = dataset.costModel;
    const { contentHash: _costHash, ...costBody } = model;
    const { contentHash: _taxonomyHash, ...taxonomyBody } = dataset.taxonomy;
    return stamp.leagueId.status === 'known' && stamp.realm.status === 'known' && stamp.mode.status === 'known' &&
      stamp.mode.value.ruthless === (pack.variant === 'ruthless' || pack.variant === 'ruthless-league') &&
      stamp.patchVersion.status === 'known' && dataset.gamePatch.status === 'known' && pack.gamePatch.status === 'known' &&
      stamp.patchVersion.value === dataset.gamePatch.value && dataset.gamePatch.value === pack.gamePatch.value && stamp.datasetVersion.status === 'known' &&
      model.maximumPoints.status === 'known' && model.grantedPoints.status === 'known' && hashJson(costBody) === model.contentHash &&
      hashJson(taxonomyBody) === dataset.taxonomy.contentHash && dataset.taxonomy.targets.every(target => target.verified.status === 'known' && target.verified.value);
  }

  // The cost model has its own evidence (small, notable, keystone and Gateway nodes cost 1; start and masteries cost 0).
  // It is usable whenever it is known and matches its own hash, even while patch, league or live compatibility stay Unknown.
  private costsKnown(pack: AtlasPack): boolean {
    if (pack.costs.status !== 'known') return false;
    const { contentHash, ...body } = pack.costs.value;
    return pack.costs.value.maximumPoints.status === 'known' && hashJson(body) === contentHash; // granted points may stay Unknown
  }

  private ref(pack: AtlasPack): DatasetRef {
    if (pack.dataset) return structuredClone(pack.dataset.ref);
    const stamp: LeagueStamp = {
      leagueId: unknown('Archived export has no qualified league mapping.'), realm: unknown('Archived export has no qualified realm mapping.'),
      mode: unknown('Archived export has no qualified mode mapping.'), patchVersion: structuredClone(pack.gamePatch),
      datasetVersion: known(pack.contentHash, pack.contentHash), createdAt: pack.export.files[pack.variant].fetchedAt,
    };
    return { datasetId: pack.datasetId, contentHash: pack.contentHash, variant: pack.variant, stamp };
  }

  private remember(pack: AtlasPack): void {
    this.packs.set(pack.contentHash, pack);
    this.references.set(this.ref(pack).contentHash, pack.contentHash);
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => {}); return result;
  }

  private async atomicJson(name: string, value: unknown): Promise<void> {
    const temp = join(this.root, `${name}.${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(canonicalJson(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, join(this.root, name));
    await flushDirectory(this.root);
  }

  async init(): Promise<void> {
    if (this.initialized) throw new AtlasDomainError('INVALID', 'Atlas registry is already initialized.');
    await mkdir(join(this.root, 'packs'), { recursive: true });
    for (const file of await readdir(join(this.root, 'packs'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const pack = await this.readPack(join(this.root, 'packs', file));
      if (file !== `${pack.contentHash}.json`) throw new AtlasDomainError('INVALID', 'Cached pack filename does not match its identity.');
      this.remember(pack);
    }
    const archive = await this.optionalJson(join(this.resources, 'archive.json')) as { schemaVersion: number; variants: Record<string, { contentHash: Hash }> } | null;
    if (archive) {
      if (archive.schemaVersion !== 1 || !archive.variants) throw new AtlasDomainError('INVALID', 'Archived catalog is invalid.');
      for (const [variant, entry] of Object.entries(archive.variants)) {
        if (!Object.hasOwn(ATLAS_VARIANT_FILES, variant)) throw new AtlasDomainError('INVALID', 'Archived variant is unsupported.');
        const hash = parseId('hash', entry.contentHash);
        const pack = await this.readPack(join(this.resources, 'packs', `${hash}.json`));
        if (pack.contentHash !== hash || pack.variant !== variant) throw new AtlasDomainError('INVALID', 'Archived catalog does not match its pack.');
        this.remember(pack);
      }
    }
    const retention = await this.optionalJson(join(this.root, 'retention.json')) as { schemaVersion: number; owners: Record<string, Hash[]> } | null;
    if (retention) {
      if (retention.schemaVersion !== 1 || !retention.owners || typeof retention.owners !== 'object' || Array.isArray(retention.owners)) throw new AtlasDomainError('INVALID', 'Atlas retention index is invalid.');
      for (const [owner, hashes] of Object.entries(retention.owners)) {
        if (!owner || !Array.isArray(hashes)) throw new AtlasDomainError('INVALID', 'Atlas retention entry is invalid.');
        this.retained[owner] = hashes.map(hash => parseId('hash', hash));
        if (hashes.some(hash => !this.packs.has(hash))) throw new AtlasDomainError('NOT_FOUND', 'A retained Atlas pack is unavailable.');
      }
    }
    this.initialized = true;
    const cached = await stat(join(this.root, 'catalog.json')).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    if (cached) await this.refreshCurrent(this.root);
    else await this.refreshCurrent(this.resources);
    await this.cache?.save();
  }

  async refreshCurrent(directory: string): Promise<{ updated: boolean; warning: string | null }> {
    return this.queue(async () => {
      try {
        const pointer = await this.optionalJson(join(directory, 'catalog.json')) as AtlasCatalogPointer | null;
        if (!pointer) { this.warning = this.current ? 'Catalog refresh is unavailable. The previous qualified catalog is retained.' : 'Live compatibility unverified. Choose archived tree data to plan.'; return { updated: false, warning: this.warning }; }
        if (pointer.schemaVersion !== 1 || !pointer.variants || Object.keys(pointer.variants).length !== Object.keys(ATLAS_VARIANT_FILES).length) throw new AtlasDomainError('INVALID', 'Qualified catalog must contain every variant.');
        const packs: AtlasPack[] = [];
        for (const variant of Object.keys(ATLAS_VARIANT_FILES) as AtlasVariant[]) {
          const entry = pointer.variants[variant];
          if (!entry) throw new AtlasDomainError('INVALID', 'Qualified catalog variant is missing.');
          const hash = parseId('hash', entry.contentHash);
          const pack = await this.readPack(join(directory, 'packs', `${hash}.json`));
          if (pack.contentHash !== hash || pack.variant !== variant || !this.qualified(pack) || pack.dataset!.ref.contentHash !== entry.datasetHash) {
            throw new AtlasDomainError('UNVERIFIED', 'Catalog contains an unverified or mismatched pack.');
          }
          packs.push(pack);
        }
        if (new Set(packs.map(pack => pack.sourceManifestHash)).size !== 1) throw new AtlasDomainError('INVALID', 'Catalog variants have different source acquisitions.');
        for (const pack of packs) await writeAtlasPack(this.root, pack);
        await flushDirectory(join(this.root, 'packs'));
        await this.atomicJson('catalog.json', pointer);
        for (const pack of packs) this.remember(pack);
        this.current = structuredClone(pointer); this.warning = null;
        return { updated: true, warning: null };
      } catch (error) {
        const reason = error instanceof AtlasDomainError ? error.message : 'Catalog could not be read or saved.';
        this.warning = `Could not refresh Atlas data. ${reason} The previous catalog and archived plans are retained.`;
        return { updated: false, warning: this.warning };
      }
    });
  }

  available(): Omit<AtlasCatalogView, 'graph' | 'catalogs' | 'taxonomy' | 'catalogMetadata' | 'geometry' | 'sourceLayout' | 'costs' | 'nodeMetadata' | 'assets'>[] {
    // The same rows get() gives minus its heavy parts, without building every graph and cloning every catalog on each call.
    return [...this.packs.values()].sort((a, b) => a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : a.contentHash < b.contentHash ? -1 : 1)
      .map(pack => this.summary(pack, this.ref(pack)));
  }

  /** The allocation costs get() would report for this reference, without building its graph. */
  costs(ref: DatasetRef): Known<AtlasDataset['costModel']> {
    const pack = this.resolve(ref);
    return structuredClone(this.qualified(pack) || this.costsKnown(pack) ? pack.costs : unknown<AtlasDataset['costModel']>('Allocation costs and root rules are unverified.'));
  }

  private resolve(ref: DatasetRef): AtlasPack {
    parseId('hash', ref.contentHash);
    const pack = this.packs.get(this.references.get(ref.contentHash)!);
    if (!pack) throw new AtlasDomainError('NOT_FOUND', 'Tree data is unavailable. The plan snapshot is preserved.');
    if (canonicalJson(this.ref(pack)) !== canonicalJson(ref)) throw new AtlasDomainError('INVALID', 'Tree data reference does not match its pinned identity and stamp.');
    return pack;
  }

  private summary(pack: AtlasPack, ref: DatasetRef) {
    const qualified = this.qualified(pack);
    const isCurrent = this.current?.variants[pack.variant].contentHash === pack.contentHash;
    const liveCompatibility = qualified && isCurrent ? pack.report.liveCompatibility : unknown<'verified'>('Live compatibility unverified. This source is outside the current qualified catalog.');
    return { ref: structuredClone(ref), qualification: qualified ? 'qualified' as const : 'unverified' as const, isCurrent, liveCompatibility,
      statusText: liveCompatibility.status === 'known' ? 'Qualified current tree data' : 'Live compatibility unverified',
      warnings: structuredClone([...pack.report.issues, ...pack.report.warnings]),
      exportTag: pack.export.tag ? known(pack.export.tag, pack.export.files[pack.variant].hash) : unknown<string>('Export tag is unknown.'), cdnPatchId: pack.cdn.patchId };
  }

  install(input: unknown): Promise<DatasetRef> {
    return this.queue(async () => {
      const pack = this.validate(input);
      if (Buffer.byteLength(canonicalJson(pack)) > this.policy.maxSourceBytes) throw new AtlasDomainError('INVALID', 'Atlas pack exceeds the configured size limit.');
      await writeAtlasPack(this.root, pack);
      await flushDirectory(join(this.root, 'packs'));
      this.remember(pack);
      return this.ref(pack);
    });
  }

  get(ref: DatasetRef): AtlasCatalogView {
    const pack = this.resolve(ref);
    const costs = this.qualified(pack) || this.costsKnown(pack) ? pack.costs : unknown<AtlasDataset['costModel']>('Allocation costs and root rules are unverified.');
    return { ...this.summary(pack, ref),
      costs: structuredClone(costs), graph: createGraph(pack.graph, costs), catalogs: structuredClone(pack.catalogs),
      // Parked mechanic optimizer (shared/leagueContent.ts): no view carries the hand-curated taxonomy's targets; its hash stays for saved plans.
      taxonomy: ATLAS_MECHANICS ? structuredClone(pack.taxonomy) : { ...pack.taxonomy, targets: [] }, catalogMetadata: structuredClone(pack.catalogMetadata), geometry: structuredClone(pack.geometry), sourceLayout: structuredClone(pack.sourceLayout),
      nodeMetadata: structuredClone(pack.nodeMetadata), assets: structuredClone(pack.assets) };
  }

  retain(owner: string, refs: readonly DatasetRef[]): Promise<void> {
    return this.queue(async () => {
      if (!owner || ['__proto__', 'constructor', 'prototype'].includes(owner)) throw new AtlasDomainError('INVALID', 'Atlas retention owner is invalid.');
      const hashes = new Set(this.retained[owner] ?? []);
      for (const ref of refs) {
        this.get(ref);
        const pack = this.packs.get(this.references.get(ref.contentHash)!)!;
        await writeAtlasPack(this.root, pack); hashes.add(pack.contentHash);
      }
      await flushDirectory(join(this.root, 'packs'));
      const next = { ...this.retained, [owner]: [...hashes].sort() };
      await this.atomicJson('retention.json', { schemaVersion: 1, owners: next });
      this.retained = next;
    });
  }

  retentionRoots(): Hash[] { return [...new Set(Object.values(this.retained).flat())].sort(); }
}
