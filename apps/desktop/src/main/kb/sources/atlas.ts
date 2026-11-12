import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { atlasDatasetSchema, parseId } from '@pom/mastery-contracts';
import type { AssetRef, AtlasDataset, AtlasNode, AtlasStat, CatalogEntry, Hash, Known, LeagueStamp, Provenance, ValidationLimits } from '@pom/mastery-contracts';
import type { DatRow, Schema } from './cdn.js';

export const ATLAS_NORMALIZER_VERSION = 'atlas-ingestion/1';
export const ATLAS_VARIANT_FILES = { base: 'data.json', league: 'league.json', ruthless: 'ruthless.json', 'ruthless-league': 'ruthless-league.json' } as const;
export type AtlasVariant = keyof typeof ATLAS_VARIANT_FILES;
export type FilePin = { file: string; hash: Hash; url: string; fetchedAt: string };
export type TablePin = FilePin & { columns: string[]; dat: FilePin };
export type AtlasSourceManifest = {
  schemaVersion: 1;
  export: { defaultBranch: string; commit: string; tag: string | null; files: Record<AtlasVariant, FilePin>; assets: Record<string, FilePin> };
  schema: FilePin & { commit: Known<string>; releasePublishedAt: string };
  parser: { version: string; files: Record<string, Hash>; runtimeDependencies?: Record<string, { version: string; files: Record<string, Hash> }> };
  cdn: { patchId: string; index: FilePin; tables: Record<string, TablePin> };
  latestCandidate: { url: string; value: string; fetchedAt: string; hash: Hash; role: 'candidate_only' };
  gamePatch: Known<string>;
};
export type AtlasSourceInput = { manifest: AtlasSourceManifest; files: Record<string, Uint8Array> };
export type Issue = { code: string; subject: string; reason: string };
export class AtlasQuarantine extends Error {
  constructor(readonly issues: Issue[]) { super(issues.map(i => `${i.code}: ${i.subject}: ${i.reason}`).join('\n')); }
}
export type NodeGeometry = { group: string; orbit: number; orbitIndex: number; position: Known<{ x: number; y: number }> };
export type CdnEffect = {
  passiveId: string; name: string; icon: string; stats: { statId: string; value: number }[];
  flags: Record<string, boolean>; grantedPoints: number; provenance: Provenance[];
};
export type AtlasDiff = {
  addedNodeIds: string[]; removedNodeIds: string[]; addedEdges: [string, string][]; removedEdges: [string, string][];
  changedGeometryIds: string[]; changedEffectIds: string[]; changedMetadataIds: string[];
  fields: { nodeId: string; field: string; before: unknown; after: unknown }[];
};
export type AtlasReview = {
  /** Each review file is immutable and must bind this exact source manifest and variant. */
  sourceManifestHash: Hash; variant: AtlasVariant; evidence: Provenance[];
  stamp: LeagueStamp; gamePatch: Known<string>;
  costs: AtlasDataset['costModel']; taxonomy: AtlasDataset['taxonomy'];
  orbitAngles: Record<string, number[]>;
  rootPosition: Known<{ x: number; y: number }>;
  statSemantics: Record<string, { aggregation: AtlasStat['aggregation']; unit: string; sourceText: string }>;
  checks: { topology: Known<'verified'>; variantMembership: Known<'verified'>; translations: Known<'verified'>;
    allocationRules: Known<'verified'>; liveCompatibility: Known<'verified'> };
};
export type AtlasPack = {
  schemaVersion: 1; datasetId: string; contentHash: Hash; sourceManifestHash: Hash; normalizerVersion: string; variant: AtlasVariant;
  gamePatch: Known<string>; stamp: LeagueStamp | null; verificationReportHash: Hash;
  export: AtlasSourceManifest['export']; cdn: AtlasSourceManifest['cdn']; schema: AtlasSourceManifest['schema']; parser: AtlasSourceManifest['parser'];
  graph: AtlasDataset['graph']; geometry: Record<string, NodeGeometry>;
  sourceLayout: { groups: Record<string, unknown>; constants: Record<string, unknown>; sprites: Record<string, unknown>; bounds: Record<string, number> };
  nodeMetadata: Record<string, Record<string, unknown>>; effects: Record<string, CdnEffect>;
  catalogs: AtlasDataset['catalogs']; catalogMetadata: Record<string, { tier?: number; areaId?: string; areaLevel?: number; iconPath: Known<string> }>;
  assets: AssetRef[]; costs: Known<AtlasDataset['costModel']>; taxonomy: AtlasDataset['taxonomy'];
  dataset: AtlasDataset | null;
  report: { sourceManifestHash: Hash; issues: Issue[]; warnings: Issue[]; rootComponent: string[]; isolatedNodeIds: string[];
    componentCount: number; edgeCount: number; cycleRank: number; asymmetries: [string, string][]; duplicateEdges: [string, string][];
    unmatchedExportIds: string[]; unmatchedCdnIds: string[]; exportCdnDifferences: { nodeId: string; field: string; exported: unknown; cdn: unknown }[];
    diff: AtlasDiff | null; liveCompatibility: Known<'verified'> };
};
export type AtlasBuildPolicy = { limits: ValidationLimits; maxSourceBytes: number };
const unknown = <T>(reason: string): Known<T> => ({ status: 'unknown', reason });
const known = <T>(value: T, evidenceId: string): Known<T> => ({ status: 'known', value, evidenceId });
export function hashBytes(bytes: Uint8Array | string): Hash { return parseId('hash', createHash('sha256').update(bytes).digest('hex')); }
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Non-JSON source value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(object[k])}`).join(',')}}`;
}
export const hashJson = (value: unknown): Hash => hashBytes(canonicalJson(value));
function fail(code: string, subject: string, reason: string): never { throw new AtlasQuarantine([{ code, subject, reason }]); }
function object(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SOURCE', subject, 'Expected an object');
  return value as Record<string, unknown>;
}
function text(value: unknown, subject: string): string {
  if (typeof value !== 'string' || !value) fail('INVALID_SOURCE', subject, 'Expected a nonempty source string');
  return value;
}
function sourceText(value: unknown, subject: string): string {
  if (typeof value !== 'string') fail('INVALID_SOURCE', subject, 'Expected a source string');
  return value;
}
function number(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_SOURCE', subject, 'Expected a finite source number');
  return value;
}
function integer(value: unknown, subject: string): number {
  const n = number(value, subject);
  if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_SOURCE', subject, 'Expected a nonnegative source integer');
  return n;
}
function array(value: unknown, subject: string): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_SOURCE', subject, 'Expected a source array');
  return value;
}
function sourceBytes(input: AtlasSourceInput, pin: FilePin, policy: AtlasBuildPolicy): Uint8Array {
  if (!/^\d{4}-\d\d-\d\dT/.test(pin.fetchedAt) || !Number.isFinite(Date.parse(pin.fetchedAt))) fail('INVALID_PIN', pin.file, 'Missing fetch timestamp');
  const bytes = input.files[pin.file];
  if (!bytes || bytes.byteLength > policy.maxSourceBytes) fail('SOURCE_BOUND', pin.file, 'Source missing or exceeds caller byte policy');
  if (hashBytes(bytes) !== pin.hash) fail('HASH_MISMATCH', pin.file, 'Source bytes differ from the pinned digest');
  return bytes;
}
function sourceJson(input: AtlasSourceInput, pin: FilePin, policy: AtlasBuildPolicy): unknown {
  return JSON.parse(new TextDecoder().decode(sourceBytes(input, pin, policy))) as unknown;
}
function provenance(pin: FilePin, field: string): Provenance { return { sourceId: pin.url, sourceHash: pin.hash, field, fetchedAt: pin.fetchedAt }; }
function indexed(rows: DatRow[], subject: string): Map<number, DatRow> {
  const result = new Map<number, DatRow>();
  for (const row of rows) {
    const index = integer(row._index, `${subject}._index`);
    if (result.has(index)) fail('DUPLICATE_ROW', subject, String(index));
    result.set(index, row);
  }
  return result;
}
function byForeign(rows: Map<number, DatRow>, key: unknown, subject: string): DatRow {
  const row = rows.get(integer(key, subject));
  if (!row) fail('UNKNOWN_JOIN', subject, `Missing exact row ${String(key)}`);
  return row;
}
function mediaType(file: string): AssetRef['mediaType'] {
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.webp')) return 'image/webp';
  return fail('UNSUPPORTED_ASSET', file, 'Unsupported artwork encoding');
}

/** Raw table and schema identity are verified before any exact-ID overlay is considered. */
export function buildAtlasPack(input: AtlasSourceInput, variant: AtlasVariant, policy: AtlasBuildPolicy,
  review: AtlasReview | null = null, previous: AtlasPack | null = null): AtlasPack {
  if (!Number.isSafeInteger(policy.maxSourceBytes) || policy.maxSourceBytes <= 0) fail('INVALID_POLICY', 'maxSourceBytes', 'Caller must provide a positive byte limit');
  const { manifest } = input;
  if (manifest.schemaVersion !== 1 || !Object.hasOwn(ATLAS_VARIANT_FILES, variant)) fail('UNSUPPORTED_VERSION', variant, 'Unsupported source manifest or variant');
  if (!/^[a-f0-9]{40}$/.test(manifest.export.commit)) fail('INVALID_PIN', 'export.commit', 'An exact repository commit is required');
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(manifest.cdn.patchId)) fail('INVALID_PIN', 'cdn.patchId', 'An exact CDN build is required');
  if (!manifest.cdn.index?.url.endsWith(`/${manifest.cdn.patchId}/Bundles2/_.index.bin`)) fail('INVALID_PIN', 'cdn.index', 'CDN index is not pinned to the selected build');
  sourceBytes(input, manifest.cdn.index, policy);
  const sourceManifestHash = hashJson(manifest);
  if (!manifest.parser.version || !Object.keys(manifest.parser.files).length) fail('INVALID_PIN', 'parser', 'Parser version and implementation digests are required');
  if (review && (review.sourceManifestHash !== sourceManifestHash || review.variant !== variant || !review.evidence.length)) fail('STALE_REVIEW', variant, 'Review does not bind these sources and variant');
  const exportFileHashes: Record<string, Hash> = {};
  for (const [v, file] of Object.entries(ATLAS_VARIANT_FILES)) {
    const pin = manifest.export.files[v as AtlasVariant];
    if (!pin || !pin.url.includes(`/${manifest.export.commit}/${file}`)) fail('INVALID_PIN', v, 'Variant file is not pinned to the export commit');
    sourceBytes(input, pin, policy);
    exportFileHashes[file] = pin.hash;
  }
  const exportPin = manifest.export.files[variant];
  const exported = object(sourceJson(input, exportPin, policy), variant);
  const exportNodes = object(exported.nodes, `${variant}.nodes`);
  if (!Object.hasOwn(exportNodes, 'root')) fail('MISSING_ROOT', variant, 'Export root is absent');
  const groups = object(exported.groups, `${variant}.groups`);
  const constants = object(exported.constants, `${variant}.constants`);
  const sprites = object(exported.sprites, `${variant}.sprites`);
  const perOrbit = array(constants.skillsPerOrbit, 'skillsPerOrbit').map((v, i) => integer(v, `skillsPerOrbit.${i}`));
  const radii = array(constants.orbitRadii, 'orbitRadii').map((v, i) => number(v, `orbitRadii.${i}`));
  const schema = sourceJson(input, manifest.schema, policy) as Schema;
  if (schema.version !== 7 || !Array.isArray(schema.tables) || !Array.isArray(schema.enumerations)) fail('INVALID_SCHEMA', 'dat-schema', 'Unsupported schema format');
  const tables: Record<string, DatRow[]> = {};
  for (const [name, pin] of Object.entries(manifest.cdn.tables)) {
    if (pin.dat.url !== `${manifest.cdn.index.url}#Data/${name}.datc64` || pin.url !== pin.dat.url) fail('INVALID_PIN', name, 'Table is not pinned to the selected build/index');
    const sch = schema.tables.find(t => t.name === name && (t.validFor & 1));
    if (!sch || pin.columns.some(c => !sch.columns.some(sc => sc.name === c))) fail('MISSING_COLUMN', name, 'Required columns are absent from the pinned schema');
    sourceBytes(input, pin.dat, policy);
    const rows = sourceJson(input, pin, policy);
    tables[name] = array(rows, name).map(value => {
      const row = object(value, name) as DatRow;
      if (pin.columns.some(c => !Object.hasOwn(row, c))) fail('MISSING_COLUMN', name, `A row omits a requested column at ${row._index}`);
      return row;
    });
  }
  const requireTable = (name: string): DatRow[] => tables[name] ?? fail('MISSING_TABLE', name, 'Pinned extraction is required');
  for (const [table, fields] of Object.entries({ PassiveSkills: ['Id', 'PassiveSkillGraphId', 'SkillType', 'Stats', 'StatsHardmode', 'Name', 'HasHardmodeAlternate'],
    Stats: ['Id'], BaseItemTypes: ['Id', 'Name', 'ItemVisualIdentity'], ItemVisualIdentity: ['Id', 'DDSFile'],
    Maps: ['BaseItemTypesKey', 'Regular_WorldAreasKey', 'Tier'], WorldAreas: ['Id', 'AreaLevel'], Scarabs: ['Items'] })) {
    requireTable(table);
    if (fields.some(f => !manifest.cdn.tables[table]!.columns.includes(f))) fail('MISSING_COLUMN', table, 'Extraction omits a required join column');
  }
  const statRows = indexed(requireTable('Stats'), 'Stats');
  const passiveRows = requireTable('PassiveSkills');
  const typeEnum = schema.enumerations.find(e => e.name === 'PassiveSkillTypes' && (e.validFor & 1));
  const atlasType = typeEnum?.enumerators.indexOf('ATLAS_TREE');
  if (!typeEnum || atlasType === undefined || atlasType < 0) fail('MISSING_ENUM', 'PassiveSkillTypes', 'Atlas membership cannot be guessed');
  const candidates = passiveRows.filter(r => r.SkillType === atlasType + typeEnum.indexing);
  const effects: Record<string, CdnEffect> = Object.create(null) as Record<string, CdnEffect>;
  const hardmode = variant === 'ruthless' || variant === 'ruthless-league';
  const cdnPin = manifest.cdn.tables.PassiveSkills!;
  for (const row of candidates) {
    const id = String(integer(row.PassiveSkillGraphId, 'PassiveSkillGraphId'));
    if (Object.hasOwn(effects, id)) fail('AMBIGUOUS_JOIN', id, 'Multiple Atlas rows share this graph ID');
    if (typeof row.HasHardmodeAlternate !== 'boolean') fail('INVALID_SOURCE', id, 'Hardmode alternate flag is missing');
    const alternate = hardmode && row.HasHardmodeAlternate;
    const refs = array(row[alternate ? 'StatsHardmode' : 'Stats'], `${id}.Stats`);
    if (refs.length > 5) fail('UNSUPPORTED_EFFECT', id, 'More stat references than named value columns');
    const stats = refs.map((key, i) => ({ statId: text(byForeign(statRows, key, `${id}.Stats.${i}`).Id, 'Stats.Id'),
      value: number(row[`Stat${i + 1}Value${alternate ? 'Hardmode' : ''}`], `${id}.Stat${i + 1}Value`) }));
    const flags: Record<string, boolean> = {};
    for (const field of ['IsNotable', 'IsKeystone', 'IsJustIcon', 'IsMultipleChoice', 'IsMultipleChoiceOption', 'IsAtlasWormhole']) {
      if (typeof row[field] !== 'boolean') fail('INVALID_SOURCE', id, `Missing ${field}`);
      flags[field] = row[field];
    }
    effects[id] = { passiveId: text(row.Id, `${id}.Id`), name: sourceText(row[alternate ? 'NameHardmode' : 'Name'], `${id}.Name`),
      icon: sourceText(row.Icon_DDSFile, `${id}.Icon_DDSFile`), stats, flags,
      grantedPoints: integer(row[alternate ? 'SkillPointsGrantedHardmode' : 'SkillPointsGranted'], `${id}.SkillPointsGranted`),
      provenance: [provenance(cdnPin, `PassiveSkills[${row._index}]`), provenance(manifest.cdn.tables.Stats!, 'Stats.Id')] };
  }
  const ids = Object.keys(exportNodes).sort();
  const idSet = new Set(ids);
  const adjacent = new Map(ids.map(id => [id, new Set<string>()]));
  const duplicateEdges: [string, string][] = [];
  const asymmetries: [string, string][] = [];
  const geometry: Record<string, NodeGeometry> = Object.create(null) as Record<string, NodeGeometry>;
  const nodeMetadata: AtlasPack['nodeMetadata'] = Object.create(null) as AtlasPack['nodeMetadata'];
  const exportCdnDifferences: AtlasPack['report']['exportCdnDifferences'] = [];
  const warnings: Issue[] = [];
  const assets: AssetRef[] = [];
  const assetsByFile = new Map<string, AssetRef>();
  for (const [path, pin] of Object.entries(manifest.export.assets).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    sourceBytes(input, pin, policy);
    if (!pin.url.includes(`/${manifest.export.commit}/${path}`)) fail('INVALID_PIN', path, 'Artwork is not from the pinned export');
    const asset: AssetRef = { assetId: path, contentHash: pin.hash, mediaType: mediaType(path) };
    assets.push(asset); assetsByFile.set(path, asset);
  }
  const iconAssets = new Map<string, AssetRef>();
  for (const [family, levels] of Object.entries(sprites)) {
    for (const [zoom, rawSprite] of Object.entries(object(levels, family))) {
      const sprite = object(rawSprite, `${family}.${zoom}`);
      const url = new URL(text(sprite.filename, 'sprite.filename'));
      const file = `assets/${url.pathname.split('/').at(-1)}`;
      const asset = assetsByFile.get(file);
      if (!asset) fail('MISSING_ASSET', file, 'Export references an artwork file outside the pinned asset inventory');
      for (const [icon, rawCoords] of Object.entries(object(sprite.coords, 'sprite.coords'))) {
        const coords = object(rawCoords, icon);
        const x = number(coords.x, `${icon}.x`), y = number(coords.y, `${icon}.y`);
        const w = number(coords.w, `${icon}.w`), h = number(coords.h, `${icon}.h`);
        if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > number(sprite.w, 'sprite.w') || y + h > number(sprite.h, 'sprite.h')) fail('INVALID_ASSET_RECT', icon, 'Sprite rectangle lies outside source dimensions');
        if (!iconAssets.has(icon)) iconAssets.set(icon, asset);
      }
    }
  }
  const nodes: AtlasNode[] = [];
  for (const id of ids) {
    const n = object(exportNodes[id], id);
    if (id !== 'root' && String(integer(n.skill, `${id}.skill`)) !== id) fail('ID_MISMATCH', id, 'Node key does not equal its canonical source skill');
    for (const direction of ['out', 'in']) {
      const links = array(n[direction], `${id}.${direction}`).map(l => text(l, `${id}.${direction}`));
      const seen = new Set<string>();
      for (const link of links) {
        if (!idSet.has(link) || link === id) fail('DANGLING_EDGE', id, `Invalid ${direction} link ${link}`);
        if (seen.has(link)) duplicateEdges.push([id, link]);
        seen.add(link);
        adjacent.get(id)!.add(link); adjacent.get(link)!.add(id);
        const reverse = array(object(exportNodes[link], link)[direction === 'out' ? 'in' : 'out'], `${link}.reverse`);
        if (!reverse.includes(id)) asymmetries.push([id, link]);
      }
    }
    const group = String(integer(n.group, `${id}.group`));
    const orbit = integer(n.orbit, `${id}.orbit`), orbitIndex = integer(n.orbitIndex, `${id}.orbitIndex`);
    let position: NodeGeometry['position'];
    if (id === 'root') position = review?.rootPosition ?? unknown('Export root has no group geometry; its presentation anchor needs review.');
    else {
      const g = object(groups[group], `${id}.group`);
      const gx = number(g.x, `${group}.x`), gy = number(g.y, `${group}.y`);
      const count = perOrbit[orbit], radius = radii[orbit];
      if (count === undefined || !count || radius === undefined || orbitIndex >= count) fail('INVALID_GEOMETRY', id, 'Orbit slot does not exist in source constants');
      const angle = review?.orbitAngles[String(count)]?.[orbitIndex];
      if (radius === 0) position = known({ x: gx, y: gy }, exportPin.hash);
      else if (angle !== undefined && Number.isFinite(angle)) position = known({ x: gx + Math.sin(angle) * radius, y: gy - Math.cos(angle) * radius }, hashJson(review));
      else position = unknown('Orbit origin/radius/slot are sourced; the angle convention has not been qualified.');
    }
    geometry[id] = { group, orbit, orbitIndex, position };
    const { out: _out, in: _in, group: _group, orbit: _orbit, orbitIndex: _index, stats: _stats, ...metadata } = n;
    nodeMetadata[id] = metadata;
    const effect = effects[id];
    if (effect) {
      for (const [exportField, cdnField] of [['name', 'name'], ['isNotable', 'IsNotable'], ['isKeystone', 'IsKeystone'], ['isWormhole', 'IsAtlasWormhole']] as const) {
        const value = exportField === 'name' ? effect.name : effect.flags[cdnField];
        const exportedValue = exportField === 'name' ? n.name : n[exportField] === true;
        if (canonicalJson(exportedValue) !== canonicalJson(value)) exportCdnDifferences.push({ nodeId: id, field: exportField, exported: exportedValue, cdn: value });
      }
    }
    const statText = id === 'root' ? [] : array(n.stats ?? [], `${id}.stats`).map(v => text(v, `${id}.stats`));
    // Export translations and raw dat stats remain separate until a reviewed translation maps exact stat IDs.
    const stats: AtlasStat[] = statText.map((sourceText, index) => ({ statId: `export-text:${exportPin.hash}:${id}:${index}`, sourceText,
      aggregation: 'nonadditive', value: unknown('Rendered export text has no verified numeric stat-ID join.'),
      unit: unknown('Export text unit is not a qualified effect schema.'), effectSchemaHash: manifest.schema.hash, provenance: [provenance(exportPin, `nodes.${id}.stats.${index}`)] }));
    if (effect) for (const raw of effect.stats) {
      const semantics = review?.statSemantics[raw.statId];
      stats.push({ statId: raw.statId, sourceText: semantics?.sourceText ?? raw.statId, aggregation: semantics?.aggregation ?? 'nonadditive',
        value: known(raw.value, cdnPin.hash), unit: semantics ? known(semantics.unit, hashJson(review)) : unknown('Stat unit and aggregation require reviewed translation semantics.'),
        effectSchemaHash: manifest.schema.hash, provenance: effect.provenance });
    }
    nodes.push({ nodeId: id, name: id === 'root' ? 'root' : sourceText(n.name, `${id}.name`) || id, adjacentIds: [], stats,
      asset: typeof n.icon === 'string' ? iconAssets.get(n.icon) ?? null : null });
  }
  for (const node of nodes) node.adjacentIds = [...adjacent.get(node.nodeId)!].sort();
  const components: string[][] = [];
  const visited = new Set<string>();
  for (const id of ids) {
    if (visited.has(id)) continue;
    const pending = [id], component: string[] = []; visited.add(id);
    for (let i = 0; i < pending.length; i++) {
      const at = pending[i]!; component.push(at);
      for (const next of adjacent.get(at)!) if (!visited.has(next)) { visited.add(next); pending.push(next); }
    }
    components.push(component.sort());
  }
  const rootComponent = components.find(c => c.includes('root'))!;
  const unmatchedExportIds = ids.filter(id => id !== 'root' && !Object.hasOwn(effects, id));
  const unmatchedCdnIds = Object.keys(effects).filter(id => !idSet.has(id)).sort();
  for (const id of unmatchedExportIds) warnings.push({ code: 'UNKNOWN_JOIN', subject: id, reason: 'No exact Atlas PassiveSkills graph-ID join; export data remains unchanged.' });
  if (unmatchedCdnIds.length) warnings.push({ code: 'UNRECONCILED_MEMBERSHIP', subject: variant, reason: 'CDN Atlas rows outside this variant lack verified topology/coordinates/membership.' });
  const catalogs: AtlasDataset['catalogs'] = { maps: [], scarabs: [] };
  const catalogMetadata: AtlasPack['catalogMetadata'] = Object.create(null) as AtlasPack['catalogMetadata'];
  const bases = indexed(requireTable('BaseItemTypes'), 'BaseItemTypes');
  const areas = indexed(requireTable('WorldAreas'), 'WorldAreas');
  const visuals = indexed(requireTable('ItemVisualIdentity'), 'ItemVisualIdentity');
  for (const [kind, name, column] of [['maps', 'Maps', 'BaseItemTypesKey'], ['scarabs', 'Scarabs', 'Items']] as const) {
    const seen = new Set<string>();
    for (const row of requireTable(name)) {
      const keys = kind === 'scarabs' ? array(row[column], `${name}.${column}`) : [row[column]];
      for (const key of keys) {
      const base = byForeign(bases, key, `${name}.${column}`);
      const catalogId = text(base.Id, 'BaseItemTypes.Id');
      if (seen.has(catalogId)) fail('AMBIGUOUS_JOIN', catalogId, 'Duplicate catalog item ID');
      seen.add(catalogId);
      const p = [provenance(manifest.cdn.tables[name]!, `${name}[${row._index}]`), provenance(manifest.cdn.tables.BaseItemTypes!, `BaseItemTypes[${base._index}]`)];
      const entry: CatalogEntry = { catalogId, name: text(base.Name, `${catalogId}.Name`), asset: null, provenance: p };
      catalogs[kind].push(entry);
      const visual = visuals.get(typeof base.ItemVisualIdentity === 'number' ? base.ItemVisualIdentity : -1);
      const iconPath = visual && typeof visual.DDSFile === 'string' && visual.DDSFile ? known(visual.DDSFile, manifest.cdn.tables.ItemVisualIdentity!.hash) : unknown<string>('No exact item artwork join.');
      if (kind === 'maps') {
        const area = byForeign(areas, row.Regular_WorldAreasKey, `${catalogId}.Regular_WorldAreasKey`);
        catalogMetadata[catalogId] = { tier: integer(row.Tier, `${catalogId}.Tier`), areaId: text(area.Id, 'WorldAreas.Id'), areaLevel: integer(area.AreaLevel, 'WorldAreas.AreaLevel'), iconPath };
      } else catalogMetadata[catalogId] = { iconPath };
      }
    }
    catalogs[kind].sort((a, b) => a.catalogId < b.catalogId ? -1 : a.catalogId > b.catalogId ? 1 : 0);
  }
  const emptyTaxonomy: AtlasDataset['taxonomy'] = { revision: 'unverified', targets: [], contentHash: hashJson([]) };
  const taxonomy = review?.taxonomy ?? emptyTaxonomy;
  for (const target of taxonomy.targets) {
    for (const id of target.nodeIds) {
      if (!idSet.has(id)) fail('UNKNOWN_TARGET', target.targetId, id);
      if (!rootComponent.includes(id)) fail('UNREACHABLE_TARGET', target.targetId, id);
      if (nodeMetadata[id]?.isKeystone === true || nodeMetadata[id]?.isNotable !== true) fail('INVALID_TARGET', target.targetId, 'Mechanic targets must be reviewed notables; keystones are separate.');
    }
  }
  const issues: Issue[] = [];
  if (!review) issues.push({ code: 'UNVERIFIED_SEMANTICS', subject: variant, reason: 'Allocation costs, taxonomy, angle conventions, variant scope and live compatibility have not been qualified.' });
  if (review) {
    if (hashJson({ revision: review.costs.revision, nodeCosts: review.costs.nodeCosts, maximumPoints: review.costs.maximumPoints, grantedPoints: review.costs.grantedPoints, provenance: review.costs.provenance }) !== review.costs.contentHash) fail('HASH_MISMATCH', 'costModel', 'Review cost digest mismatch');
    if (hashJson({ revision: taxonomy.revision, targets: taxonomy.targets }) !== taxonomy.contentHash) fail('HASH_MISMATCH', 'taxonomy', 'Review taxonomy digest mismatch');
    if (!review.costs.provenance.length || ids.some(id => !Object.hasOwn(review.costs.nodeCosts, id))) fail('MISSING_COST', variant, 'Every node, including root, requires sourced costs');
    if (Object.keys(review.costs.nodeCosts).some(id => !idSet.has(id))) fail('UNKNOWN_COST_ID', variant, 'Cost metadata includes absent nodes');
    for (const [id, cost] of Object.entries(review.costs.nodeCosts)) if (!Number.isFinite(cost) || cost < 0) fail('INVALID_COST', id, 'Cost must be finite and nonnegative');
    for (const [field, check] of Object.entries(review.checks)) if (check.status !== 'known') issues.push({ code: 'UNVERIFIED_REVIEW', subject: field, reason: check.reason });
    if (Object.values(geometry).some(g => g.position.status !== 'known')) issues.push({ code: 'UNVERIFIED_GEOMETRY', subject: variant, reason: 'Some presentation coordinates are unresolved.' });
    if (taxonomy.targets.some(t => t.verified.status !== 'known' || !t.verified.value)) issues.push({ code: 'UNVERIFIED_TAXONOMY', subject: variant, reason: 'Targets have not been reviewed.' });
    if (review.gamePatch.status !== 'known') issues.push({ code: 'UNVERIFIED_PATCH', subject: variant, reason: review.gamePatch.reason });
    if (review.stamp.leagueId.status !== 'known' || review.stamp.realm.status !== 'known' || review.stamp.mode.status !== 'known'
      || review.stamp.patchVersion.status !== 'known' || review.gamePatch.status !== 'known'
      || review.stamp.patchVersion.value !== review.gamePatch.value || review.stamp.datasetVersion.status !== 'known') issues.push({ code: 'UNVERIFIED_SCOPE', subject: variant, reason: 'Variant has no reviewed matching league/realm/mode/patch/dataset mapping.' });
    if (review.stamp.mode.status === 'known' && review.stamp.mode.value.ruthless !== hardmode) fail('VARIANT_MISMATCH', variant, 'Reviewed mode does not match the sourced variant');
    if (review.costs.maximumPoints.status !== 'known' || review.costs.grantedPoints.status !== 'known') issues.push({ code: 'UNVERIFIED_CAPACITY', subject: variant, reason: 'Maximum/granted point semantics are unresolved.' });
    // The point ceiling the app shows is the tree data's own: the export's points.totalPoints must equal the reviewed maximum.
    const exportTotal = typeof exported.points === 'object' && exported.points !== null ? (exported.points as Record<string, unknown>).totalPoints : undefined;
    if (review.costs.maximumPoints.status === 'known' && exportTotal !== undefined && exportTotal !== review.costs.maximumPoints.value)
      fail('CAPACITY_MISMATCH', variant, `Reviewed maximum ${review.costs.maximumPoints.value} points differs from the tree export's points.totalPoints ${String(exportTotal)}`);
    const unresolvedStats = new Set(Object.values(effects).flatMap(e => e.stats).map(s => s.statId).filter(id => !review.statSemantics[id]));
    if (unresolvedStats.size) issues.push({ code: 'UNVERIFIED_STAT_SEMANTICS', subject: variant, reason: 'Some numeric effects lack reviewed units, aggregation and translations.' });
    if (unmatchedExportIds.length || unmatchedCdnIds.length) issues.push({ code: 'UNRECONCILED_STRUCTURE', subject: variant, reason: 'ID coverage requires membership reconciliation before qualification.' });
  }
  if (asymmetries.length) warnings.push({ code: 'ASYMMETRIC_EXPORT', subject: variant, reason: 'Graph uses the full in/out union; source asymmetries are recorded.' });
  warnings.push({ code: 'UNKNOWN_TRANSLATION_JOIN', subject: variant, reason: 'Export stat lines are preserved separately from CDN stat IDs; no positional text join is assumed.' });
  warnings.push({ code: 'UNVERIFIED_ITEM_ART', subject: variant, reason: 'Catalog DDS paths are sourced; decoded public item art is not included.' });
  const edgeCount = nodes.reduce((sum, n) => sum + n.adjacentIds.length, 0) / 2;
  const graphBody = { rootId: 'root', nodes };
  const graph: AtlasDataset['graph'] = { graphHash: hashJson(graphBody), ...graphBody };
  const report: AtlasPack['report'] = { sourceManifestHash, issues, warnings, rootComponent,
    isolatedNodeIds: ids.filter(id => adjacent.get(id)!.size === 0), componentCount: components.length,
    edgeCount, cycleRank: edgeCount - ids.length + components.length, asymmetries, duplicateEdges,
    unmatchedExportIds, unmatchedCdnIds, exportCdnDifferences, diff: null,
    liveCompatibility: issues.length ? unknown('Live compatibility unverified; inspect the pinned validation report.') : review!.checks.liveCompatibility };
  const layout = { groups, constants, sprites, bounds: Object.fromEntries(['min_x', 'min_y', 'max_x', 'max_y'].map(k => [k, number(exported[k], k)])) };
  const datasetId = `atlas:${manifest.export.commit}:${manifest.cdn.patchId}`;
  const pack: AtlasPack = { schemaVersion: 1, datasetId, contentHash: hashJson(null), sourceManifestHash, normalizerVersion: ATLAS_NORMALIZER_VERSION,
    gamePatch: review?.gamePatch ?? manifest.gamePatch, stamp: review?.stamp ?? null, verificationReportHash: hashJson(report),
    variant, export: manifest.export, cdn: manifest.cdn, schema: manifest.schema, parser: manifest.parser,
    graph, geometry, sourceLayout: layout, nodeMetadata, effects, catalogs, catalogMetadata, assets,
    costs: review ? known(review.costs, hashJson(review)) : unknown('No validated additive allocation model; no unit costs or free-root defaults are supplied.'),
    taxonomy, dataset: null, report };
  if (previous) report.diff = diffAtlasPacks(previous, pack);
  pack.verificationReportHash = hashJson(report);
  if (review) {
    const stamp = review.stamp;
    const dataset: AtlasDataset = { schemaVersion: 1,
      ref: { datasetId, contentHash: hashJson(null), variant, stamp },
      exportTag: manifest.export.tag ? known(manifest.export.tag, exportPin.hash) : unknown('Commit has no verified export tag.'),
      exportCommit: known(manifest.export.commit, exportPin.hash), exportFileHashes, gamePatch: review.gamePatch,
      cdnPatchId: known(manifest.cdn.patchId, cdnPin.dat.hash), schemaHash: manifest.schema.hash, schemaCommit: manifest.schema.commit,
      parserVersion: manifest.parser.version, normalizerVersion: ATLAS_NORMALIZER_VERSION, verificationReportHash: hashJson(report),
      compatibility: report.liveCompatibility,
      fieldProvenance: { topology: { data: known('Official export in/out union; CDN does not establish replacement topology.', exportPin.hash), provenance: [provenance(exportPin, 'nodes')] },
        numericEffects: { data: known('Exact Atlas skill-type and graph-ID join; raw stat IDs remain separate from rendered translations.', cdnPin.hash), provenance: [provenance(cdnPin, 'PassiveSkillGraphId/SkillType/Stats')] } },
      graph, assets, catalogs, taxonomy, costModel: review.costs };
    dataset.ref.contentHash = atlasDatasetDigest(dataset);
    const validated = atlasDatasetSchema.parse(dataset, policy.limits);
    if (!validated.ok) fail('INVALID_DATASET', variant, validated.issues.map(i => `${i.path}: ${i.message}`).join('; '));
    pack.dataset = validated.value;
  }
  pack.contentHash = atlasPackDigest(pack);
  return pack;
}

/** Identity fields are excluded to avoid recursive hashes; every remaining field is bound. */
export function atlasDatasetDigest(dataset: AtlasDataset): Hash {
  const { contentHash: _hash, ...ref } = dataset.ref;
  return hashJson({ ...dataset, ref });
}
export function atlasPackDigest(pack: AtlasPack): Hash { const { contentHash: _hash, ...body } = pack; return hashJson(body); }
function edgeList(pack: AtlasPack): [string, string][] {
  return pack.graph.nodes.flatMap(n => n.adjacentIds.filter(id => n.nodeId < id).map(id => [n.nodeId, id] as [string, string]));
}
export function diffAtlasPacks(before: AtlasPack, after: AtlasPack): AtlasDiff {
  if (before.variant !== after.variant) fail('VARIANT_MISMATCH', after.variant, 'Compare within one exact variant');
  const a = new Set(before.graph.nodes.map(n => n.nodeId)), b = new Set(after.graph.nodes.map(n => n.nodeId));
  const ae = edgeList(before), be = edgeList(after);
  const aset = new Set(ae.map(canonicalJson)), bset = new Set(be.map(canonicalJson));
  const shared = [...b].filter(id => a.has(id)).sort();
  const effectBody = (effect: CdnEffect | undefined) => {
    if (!effect) return null;
    const { provenance: _provenance, ...body } = effect;
    return body;
  };
  const fields: AtlasDiff['fields'] = [];
  for (const id of shared) {
    const oldEffect = effectBody(before.effects[id]), newEffect = effectBody(after.effects[id]);
    const oldValues = { ...oldEffect, geometry: before.geometry[id], metadata: before.nodeMetadata[id] };
    const newValues = { ...newEffect, geometry: after.geometry[id], metadata: after.nodeMetadata[id] };
    for (const field of Object.keys({ ...oldValues, ...newValues }).sort()) {
      const oldValue = (oldValues as Record<string, unknown>)[field] ?? null;
      const newValue = (newValues as Record<string, unknown>)[field] ?? null;
      if (canonicalJson(oldValue) !== canonicalJson(newValue)) fields.push({ nodeId: id, field, before: oldValue, after: newValue });
    }
  }
  return { addedNodeIds: [...b].filter(id => !a.has(id)).sort(), removedNodeIds: [...a].filter(id => !b.has(id)).sort(),
    addedEdges: be.filter(e => !aset.has(canonicalJson(e))), removedEdges: ae.filter(e => !bset.has(canonicalJson(e))),
    changedGeometryIds: shared.filter(id => canonicalJson(before.geometry[id]) !== canonicalJson(after.geometry[id]) || canonicalJson(before.sourceLayout.groups[before.geometry[id]!.group] ?? null) !== canonicalJson(after.sourceLayout.groups[after.geometry[id]!.group] ?? null) || canonicalJson(before.sourceLayout.constants) !== canonicalJson(after.sourceLayout.constants)),
    changedEffectIds: shared.filter(id => canonicalJson(effectBody(before.effects[id])) !== canonicalJson(effectBody(after.effects[id])) || canonicalJson(before.graph.nodes.find(n => n.nodeId === id)!.stats.map(s => s.sourceText)) !== canonicalJson(after.graph.nodes.find(n => n.nodeId === id)!.stats.map(s => s.sourceText))),
    changedMetadataIds: shared.filter(id => canonicalJson(before.nodeMetadata[id]) !== canonicalJson(after.nodeMetadata[id])), fields };
}

export async function loadAtlasSources(directory: string, policy: AtlasBuildPolicy): Promise<AtlasSourceInput> {
  const manifestBytes = await readFile(join(directory, 'sources.json'));
  if (manifestBytes.length > policy.maxSourceBytes) fail('SOURCE_BOUND', 'sources.json', 'Manifest exceeds caller byte policy');
  const manifest = JSON.parse(manifestBytes.toString()) as AtlasSourceManifest;
  const pins: FilePin[] = [manifest.schema, manifest.cdn.index, ...Object.values(manifest.export.files), ...Object.values(manifest.export.assets),
    ...Object.values(manifest.cdn.tables).flatMap(p => [p, p.dat])];
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const root = resolve(directory) + sep;
  for (const pin of pins) {
    const path = resolve(directory, pin.file);
    if (!path.startsWith(root)) fail('UNSAFE_PATH', pin.file, 'Source path escapes the input directory');
    files[pin.file] = await readFile(path);
  }
  const input = { manifest, files };
  for (const pin of pins) sourceBytes(input, pin, policy);
  return input;
}
async function durableFile(path: string, bytes: string, exclusive: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, exclusive ? 'wx' : 'w');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
/** Derived packs live outside KB raw-bundle caches. This writer never prunes either. */
export async function writeAtlasPack(directory: string, pack: AtlasPack): Promise<string> {
  if (atlasPackDigest(pack) !== pack.contentHash) fail('HASH_MISMATCH', pack.variant, 'Pack content changed after validation');
  const path = join(directory, 'packs', `${pack.contentHash}.json`);
  const temp = join(directory, 'packs', `${pack.contentHash}.${randomUUID()}.tmp`);
  await durableFile(temp, canonicalJson(pack) + '\n', true);
  try { await link(temp, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(path, 'utf8')) as AtlasPack;
    if (atlasPackDigest(existing) !== pack.contentHash) fail('HASH_MISMATCH', path, 'Existing immutable pack is corrupt');
  } finally { await unlink(temp).catch(() => undefined); }
  return path;
}
export type AtlasCatalogPointer = { schemaVersion: 1; variants: Record<AtlasVariant, { contentHash: Hash; datasetHash: Hash }> };
export async function promoteAtlasCatalog(directory: string, packs: AtlasPack[], policy: AtlasBuildPolicy): Promise<AtlasCatalogPointer> {
  const variants = Object.create(null) as AtlasCatalogPointer['variants'];
  for (const pack of packs) {
    if (Object.hasOwn(variants, pack.variant)) fail('DUPLICATE_VARIANT', pack.variant, 'Catalog needs one pack per variant');
    if (!pack.dataset || pack.dataset.compatibility.status !== 'known' || pack.report.issues.length || pack.report.liveCompatibility.status !== 'known') fail('UNQUALIFIED_PACK', pack.variant, 'Current catalog only accepts qualified complete packs');
    const result = atlasDatasetSchema.parse(pack.dataset, policy.limits);
    if (!result.ok || atlasDatasetDigest(pack.dataset) !== pack.dataset.ref.contentHash || hashJson(pack.report) !== pack.dataset.verificationReportHash) fail('INVALID_DATASET', pack.variant, 'Schema or dataset/report digest failed');
    await writeAtlasPack(directory, pack);
    variants[pack.variant] = { contentHash: pack.contentHash, datasetHash: pack.dataset.ref.contentHash };
  }
  for (const variant of Object.keys(ATLAS_VARIANT_FILES)) if (!Object.hasOwn(variants, variant)) fail('MISSING_VARIANT', variant, 'All four variants must pass before pointer publication');
  if (new Set(packs.map(p => p.sourceManifestHash)).size !== 1) fail('MIXED_SOURCES', 'catalog', 'Variants must share one acquisition');
  const pointer: AtlasCatalogPointer = { schemaVersion: 1, variants };
  const temp = join(directory, `catalog.${randomUUID()}.tmp`);
  await durableFile(temp, canonicalJson(pointer) + '\n', true);
  await rename(temp, join(directory, 'catalog.json'));
  return pointer;
}
