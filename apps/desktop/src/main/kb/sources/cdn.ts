import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { EntityRow, KbSource, Pulled, SourceCtx } from './types.js';

/**
 * The game's own tables, read from GGG's patch CDN at the live patch (datamined). `pathofexile-dat` reads the bundle
 * index and .datc64 files; `dat-schema` (poe-tool-dev) names the columns. Bundles are cached per patch, so a rebuild at
 * the same patch downloads nothing.
 */

export const LATEST_TXT = 'https://raw.githubusercontent.com/poe-tool-dev/latest-patch-version/main/latest.txt';
export const SCHEMA_URL = 'https://github.com/poe-tool-dev/dat-schema/releases/download/latest/schema.min.json';
const SCHEMA_VERSION = 7;
const PATCH_CDN = 'https://patch.poecdn.com';

export interface SchemaColumn { name: string | null; type: string; array: boolean; interval?: boolean; references?: { table: string; column?: string } | null }
export interface SchemaTable { name: string; validFor: number; columns: SchemaColumn[] }
interface SchemaEnum { name: string; validFor: number; indexing: number; enumerators: (string | null)[] }
export interface Schema { version: number; createdAt: number; tables: SchemaTable[]; enumerations: SchemaEnum[] }
export interface PinnedCdnOptions {
  schema: { bytes: Uint8Array; sha256: string };
  /** Explicit installed parser entry, recorded and hashed by the ingestion tool. */
  bundlesModuleUrl?: string;
}

type Cell = unknown;
export type DatRow = Record<string, Cell> & { _index: number };

interface DatHeader {
  name: string;
  offset: number;
  type: { array?: boolean; interval?: boolean; boolean?: object; integer?: { unsigned: boolean; size: number }; decimal?: { size: number }; string?: object; key?: { foreign: boolean } };
}

interface DatLib {
  readDatFile(ext: string, file: Uint8Array): { rowCount: number };
  readColumn(h: DatHeader, f: unknown): Cell[];
  getHeaderLength(h: Pick<DatHeader, 'type'>, f: unknown): number;
}
interface BundleLib {
  readIndexBundle(b: Uint8Array): { bundlesInfo: Uint8Array; filesInfo: Uint8Array };
  getFileInfo(path: string, bundlesInfo: Uint8Array, filesInfo: Uint8Array): { bundle: string; offset: number; size: number } | null;
  decompressSliceInBundle(bundle: Uint8Array, off: number, out: Uint8Array): void;
  decompressedBundleSize(bundle: Uint8Array): number;
}

/** Reads game files for one patch from the CDN, caching bundles on disk. */
export class CdnReader {
  private index: { bundlesInfo: Uint8Array; filesInfo: Uint8Array } | null = null;
  private bundles = new Map<string, Uint8Array>();
  private libs: { dat: DatLib; bundle: BundleLib } | null = null;
  private schema: Schema | null = null;
  downloaded = 0;

  constructor(private readonly ctx: SourceCtx, readonly patch: string, private readonly pinned?: PinnedCdnOptions) {
    if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(patch)) throw new Error('Invalid CDN patch ID');
  }

  private get dir(): string {
    return join(this.ctx.cacheDir, 'cdn', this.patch);
  }

  private async lib(): Promise<{ dat: DatLib; bundle: BundleLib }> {
    if (!this.libs) {
      // pathofexile-dat/dat.js also loads its column-analysis WASM with fetch(file:), which Node cannot do, so the
      // reader modules are imported directly from the package's dist folder.
      const bundlesUrl = this.pinned?.bundlesModuleUrl ?? import.meta.resolve('pathofexile-dat/bundles.js');
      const bundle = (await import(bundlesUrl)) as unknown as BundleLib;
      const datFile = (await import(new URL('./dat/dat-file.js', bundlesUrl).href)) as Pick<DatLib, 'readDatFile'>;
      const reader = (await import(new URL('./dat/reader.js', bundlesUrl).href)) as Pick<DatLib, 'readColumn'>;
      const header = (await import(new URL('./dat/header.js', bundlesUrl).href)) as Pick<DatLib, 'getHeaderLength'>;
      const dat: DatLib = { readDatFile: datFile.readDatFile, readColumn: reader.readColumn, getHeaderLength: header.getHeaderLength };
      this.libs = { dat, bundle };
    }
    return this.libs;
  }

  /** Drop bundle caches of other patches (they are tens of MB each). */
  async pruneOtherPatches(): Promise<void> {
    const root = join(this.ctx.cacheDir, 'cdn');
    try {
      for (const d of await readdir(root)) if (d !== this.patch) await rm(join(root, d), { recursive: true, force: true });
    } catch {
      /* no cache yet */
    }
  }

  private async fetchBundle(name: string): Promise<Uint8Array> {
    const mem = this.bundles.get(name);
    if (mem) return mem;
    const file = join(this.dir, name.replace(/\//g, '@'));
    let bin: Uint8Array;
    try {
      bin = new Uint8Array(await readFile(file));
    } catch {
      bin = await this.ctx.http.bytes(`${PATCH_CDN}/${this.patch}/Bundles2/${name}`);
      this.downloaded += bin.byteLength;
      await mkdir(this.dir, { recursive: true });
      await writeFile(file, bin);
    }
    this.bundles.set(name, bin);
    return bin;
  }

  async file(path: string): Promise<Uint8Array | null> {
    const { bundle } = await this.lib();
    if (!this.index) {
      const bin = await this.fetchBundle('_.index.bin');
      const out = new Uint8Array(bundle.decompressedBundleSize(bin));
      bundle.decompressSliceInBundle(bin, 0, out);
      this.index = bundle.readIndexBundle(out);
    }
    const loc = bundle.getFileInfo(path, this.index.bundlesInfo, this.index.filesInfo);
    if (!loc) return null;
    const bin = await this.fetchBundle(loc.bundle);
    const out = new Uint8Array(loc.size);
    bundle.decompressSliceInBundle(bin, loc.offset, out);
    return out;
  }

  async loadSchema(): Promise<Schema> {
    if (!this.schema) {
      let data: Schema;
      if (this.pinned) {
        const { bytes, sha256 } = this.pinned.schema;
        if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Pinned dat-schema digest mismatch');
        data = JSON.parse(new TextDecoder().decode(bytes)) as Schema;
      } else {
        ({ data } = await this.ctx.http.json<Schema>(SCHEMA_URL, { maxAgeMs: 3600_000 }));
      }
      if (data.version !== SCHEMA_VERSION) throw new Error(`dat-schema format ${data.version}, expected ${SCHEMA_VERSION}`);
      this.schema = data;
    }
    return this.schema;
  }

  get schemaCreatedAt(): number | null {
    return this.schema?.createdAt ?? null;
  }

  /** Atlas ingestion fails closed before reading a table when a required column has drifted. */
  async requiredTable(name: string, columns: string[]): Promise<{ rows: DatRow[]; fileHash: string }> {
    if (!this.pinned) throw new Error('Atlas extraction requires a pinned dat-schema');
    const schema = await this.loadSchema();
    const table = schema.tables.find(t => t.name === name && (t.validFor & 1));
    const missing = columns.filter(c => !table?.columns.some(column => column.name === c));
    if (missing.length) throw new Error(`Atlas quarantine: ${name} missing columns: ${missing.join(', ')}`);
    const rows = await this.table(name, columns);
    const bytes = await this.file(`Data/${name}.datc64`);
    if (!bytes) throw new Error(`Atlas quarantine: missing ${name} bytes`);
    return { rows, fileHash: createHash('sha256').update(bytes).digest('hex') };
  }

  /** Enum value to its name (dat-schema enumerations, PoE1). */
  enumName(enumName: string, v: unknown): string | null {
    if (typeof v !== 'number' || !this.schema) return null;
    const e = this.schema.enumerations.find((x) => x.name === enumName && x.validFor & 1);
    if (!e) return null;
    return e.enumerators[v - e.indexing] ?? null;
  }

  /** Read named columns of a table (English). Missing column names are skipped and reported. */
  async table(name: string, cols: string[]): Promise<DatRow[]> {
    const schema = await this.loadSchema();
    const { dat } = await this.lib();
    const bin = await this.file(`Data/${name}.datc64`);
    if (!bin) throw new Error(`no Data/${name}.datc64 at ${this.patch}`);
    const f = dat.readDatFile('.datc64', bin);
    const sch = schema.tables.filter((t) => t.name === name).find((t) => t.validFor & 1);
    if (!sch) throw new Error(`no schema for ${name}`);
    const headers: DatHeader[] = [];
    let offset = 0;
    for (const c of sch.columns) {
      const t = c.type;
      const h: DatHeader = {
        name: c.name ?? '',
        offset,
        type: {
          array: c.array,
          interval: c.interval,
          integer:
            t === 'u16' ? { unsigned: true, size: 2 } : t === 'u32' ? { unsigned: true, size: 4 } : t === 'i16' ? { unsigned: false, size: 2 } : t === 'i32' || t === 'enumrow' ? { unsigned: false, size: 4 } : undefined,
          decimal: t === 'f32' ? { size: 4 } : undefined,
          string: t === 'string' ? {} : undefined,
          boolean: t === 'bool' ? {} : undefined,
          key: t === 'row' || t === 'foreignrow' ? { foreign: t === 'foreignrow' } : undefined,
        },
      };
      headers.push(h);
      offset += dat.getHeaderLength(h, f);
    }
    const want = headers.filter((h) => h.name && cols.includes(h.name));
    const missing = cols.filter((c) => !want.some((h) => h.name === c));
    if (missing.length) this.ctx.log(`cdn: ${name} has no column ${missing.join(', ')} (schema drift)`);
    const data = want.map((h) => ({ name: h.name, values: dat.readColumn(h, f) }));
    const rows: DatRow[] = [];
    for (let i = 0; i < f.rowCount; i++) {
      const r: DatRow = { _index: i };
      for (const c of data) r[c.name] = c.values[i];
      rows.push(r);
    }
    return rows;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const at = <T>(rows: T[], k: unknown): T | undefined => (typeof k === 'number' ? rows[k] : undefined);

const GEM_COLOUR: Record<number, string> = { 1: 'R', 2: 'G', 3: 'B', 4: 'W' };

export async function readLatestPatch(ctx: Pick<SourceCtx, 'http'>): Promise<string> {
  const r = await ctx.http.text(LATEST_TXT);
  const v = r.body.trim();
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(v)) throw new Error(`latest.txt: unexpected "${v.slice(0, 40)}"`);
  return v;
}

export const cdnSource: KbSource = {
  id: 'cdn',
  type: 'datamined',
  async pull(ctx: SourceCtx): Promise<Pulled> {
    const patch = ctx.livePatch;
    const cdn = new CdnReader(ctx, patch);
    await cdn.pruneOtherPatches();
    await cdn.loadSchema();
    const url = `${PATCH_CDN}/${patch}/`;
    const log = ctx.log;
    const safe = async (name: string, cols: string[]): Promise<DatRow[]> => {
      try {
        return await cdn.table(name, cols);
      } catch (e) {
        log(`cdn: ${name} skipped: ${(e as Error).message}`);
        return [];
      }
    };

    const stats = await cdn.table('Stats', ['Id']);
    const statId = (k: unknown) => str(at(stats, k)?.Id);
    const tags = await cdn.table('Tags', ['Id']);
    const itemClasses = await cdn.table('ItemClasses', ['Id', 'Name']);
    const bases = await cdn.table('BaseItemTypes', ['Id', 'ItemClassesKey', 'Width', 'Height', 'Name', 'DropLevel', 'Implicit_ModsKeys', 'TagsKeys']);
    const mods = await cdn.table('Mods', [
      'Id', 'ModTypeKey', 'Level', 'Domain', 'Name', 'GenerationType', 'Families', 'SpawnWeight_TagsKeys', 'SpawnWeight_Values',
      'StatsKey1', 'StatsKey2', 'StatsKey3', 'StatsKey4', 'StatsKey5', 'StatsKey6',
      'Stat1Min', 'Stat1Max', 'Stat2Min', 'Stat2Max', 'Stat3Min', 'Stat3Max', 'Stat4Min', 'Stat4Max', 'Stat5Min', 'Stat5Max', 'Stat6Min', 'Stat6Max',
    ]);
    const families = await safe('ModFamily', ['Id']);
    const characters = await cdn.table('Characters', ['Id', 'Name']);
    const className = (k: unknown) => str(at(characters, k)?.Name);

    // ---- base items, currency, div cards
    const base_item: EntityRow[] = [];
    const div_card: EntityRow[] = [];
    const currency: EntityRow[] = [];
    const baseName = (k: unknown) => str(at(bases, k)?.Name);
    const baseId = (k: unknown) => str(at(bases, k)?.Id);
    for (const b of bases) {
      const name = str(b.Name).trim();
      if (!name || /\[DNT|UNUSED\]|^\[/.test(name)) continue;
      const cls = at(itemClasses, b.ItemClassesKey);
      base_item.push({
        id: str(b.Id),
        name,
        item_class: str(cls?.Name) || str(cls?.Id),
        drop_level: num(b.DropLevel),
        data: {
          classId: str(cls?.Id),
          size: [num(b.Width), num(b.Height)],
          implicits: arr(b.Implicit_ModsKeys).map((k) => str(at(mods, k)?.Id)).filter(Boolean),
          tags: arr(b.TagsKeys).map((k) => str(at(tags, k)?.Id)).filter(Boolean),
        },
      });
    }
    const currencyItems = await safe('CurrencyItems', ['BaseItemTypesKey', 'StackSize', 'Description', 'Directions']);
    for (const c of currencyItems) {
      const b = at(bases, c.BaseItemTypesKey);
      if (!b || !str(b.Name).trim()) continue;
      const clsId = str(at(itemClasses, b.ItemClassesKey)?.Id);
      if (clsId === 'DivinationCard') {
        div_card.push({ id: str(b.Name), name: str(b.Name), stack: num(c.StackSize), reward: null, data: { baseId: str(b.Id) } });
        continue;
      }
      currency.push({
        id: str(b.Id),
        name: str(b.Name),
        stack: num(c.StackSize),
        description: [str(c.Description), str(c.Directions)].filter(Boolean).join(' '),
        data: { itemClass: clsId },
      });
    }

    // ---- mods
    const mod: EntityRow[] = [];
    const modTiers: unknown[] = [];
    for (const m of mods) {
      const st: Array<{ id: string; min: number | null; max: number | null }> = [];
      for (let i = 1; i <= 6; i++) {
        const id = statId(m[`StatsKey${i}`]);
        if (id) st.push({ id, min: num(m[`Stat${i}Min`]), max: num(m[`Stat${i}Max`]) });
      }
      const domain = cdn.enumName('ModDomains', m.Domain);
      const gen = cdn.enumName('ModGenerationType', m.GenerationType);
      const fam = arr(m.Families).map((k) => str(at(families, k)?.Id)).filter(Boolean);
      const weights = arr(m.SpawnWeight_TagsKeys).map((k, i) => [str(at(tags, k)?.Id), num(arr(m.SpawnWeight_Values)[i])]);
      mod.push({
        id: str(m.Id),
        name: str(m.Name),
        domain,
        generation: gen,
        level: num(m.Level),
        family: fam.join(','),
        stats: st,
        data: { weights },
      });
      if (domain === 'ITEM' && (gen === 'PREFIX' || gen === 'SUFFIX') && weights.some((w) => (w[1] as number) > 0)) {
        modTiers.push({ id: str(m.Id), name: str(m.Name), gen, level: num(m.Level), family: fam, stats: st, weights: weights.filter((w) => (w[1] as number) > 0) });
      }
    }

    // ---- gems
    const gemTags = await cdn.table('GemTags', ['Id', 'Tag']);
    const activeSkills = await cdn.table('ActiveSkills', ['Id', 'DisplayedName', 'Description']);
    const costTypes = await safe('CostTypes', ['Id']);
    const grantedEffects = await cdn.table('GrantedEffects', ['Id', 'IsSupport', 'ActiveSkill', 'CastTime', 'StatSet1']);
    const gemEffects = await cdn.table('GemEffects', ['Id', 'Name', 'GrantedEffect', 'GrantedEffect2', 'SupportText', 'SupportName', 'GemTags', 'ItemColor']);
    const skillGems = await cdn.table('SkillGems', ['BaseItemTypesKey', 'IsSupport', 'GemColour', 'GemVariants', 'IsVaalVariant', 'StrengthRequirementPercent', 'DexterityRequirementPercent', 'IntelligenceRequirementPercent']);
    const gepl = await cdn.table('GrantedEffectsPerLevel', ['GrantedEffect', 'Level', 'PlayerLevelReq', 'CostAmounts', 'CostTypes', 'Cooldown', 'StoredUses', 'ManaReservationFlat', 'ManaReservationPercent', 'LifeReservationFlat', 'LifeReservationPercent', 'AttackSpeedMultiplier']);
    const statSets = await safe('GrantedEffectStatSets', ['Id', 'ImplicitStats', 'ConstantStats', 'ConstantStatsValues', 'BaseEffectiveness', 'IncrementalEffectiveness']);
    const statSetLevels = await safe('GrantedEffectStatSetsPerLevel', ['StatSet', 'GemLevel', 'PlayerLevelReq', 'SpellCritChance', 'AttackCritChance', 'BaseMultiplier', 'DamageEffectiveness', 'AdditionalStats', 'AdditionalStatsValues', 'FloatStats', 'FloatStatsValues', 'AdditionalFlags']);
    const levelsByGe = new Map<number, DatRow[]>();
    for (const r of gepl) if (typeof r.GrantedEffect === 'number') (levelsByGe.get(r.GrantedEffect) ?? levelsByGe.set(r.GrantedEffect, []).get(r.GrantedEffect)!).push(r);
    const setLevels = new Map<number, Map<number, DatRow>>();
    for (const r of statSetLevels) {
      if (typeof r.StatSet !== 'number' || typeof r.GemLevel !== 'number') continue;
      (setLevels.get(r.StatSet) ?? setLevels.set(r.StatSet, new Map()).get(r.StatSet)!).set(r.GemLevel, r);
    }
    const gem: EntityRow[] = [];
    const gem_level: EntityRow[] = [];
    const seenGem = new Set<string>();
    for (const sg of skillGems) {
      const b = at(bases, sg.BaseItemTypesKey);
      if (!b) continue;
      const bName = str(b.Name).trim();
      const bId = str(b.Id);
      if (!bName || /Royale|Test|DNT/i.test(bId) || /\[DNT/.test(bName)) continue;
      const variants = arr(sg.GemVariants);
      variants.forEach((vk, vi) => {
        const ge = at(gemEffects, vk);
        if (!ge) return;
        const name = str(ge.Name).trim() || bName;
        const id = vi === 0 ? bId : `${bId}/${str(ge.Id)}`;
        // unused variants are named "[DNT] ..."; Vaal transfigured slots repeat the Vaal gem's name
        if (seenGem.has(id) || /\[DNT/i.test(name) || (vi > 0 && seenGem.has(`name:${name}`))) return;
        seenGem.add(id);
        seenGem.add(`name:${name}`);
        const eff = at(grantedEffects, ge.GrantedEffect);
        const active = at(activeSkills, eff?.ActiveSkill);
        const levels = (typeof ge.GrantedEffect === 'number' ? levelsByGe.get(ge.GrantedEffect) : undefined) ?? [];
        levels.sort((x, y) => (num(x.Level) ?? 0) - (num(y.Level) ?? 0));
        const set = at(statSets, eff?.StatSet1);
        const setByLevel = typeof eff?.StatSet1 === 'number' ? setLevels.get(eff.StatSet1) : undefined;
        const tagList = arr(ge.GemTags).map((k) => str(at(gemTags, k)?.Id)).filter(Boolean);
        const isSupport = !!sg.IsSupport || !!eff?.IsSupport;
        const req1 = levels[0] ? Math.round(num(levels[0].PlayerLevelReq) ?? 0) : null;
        gem.push({
          id,
          name,
          is_support: isSupport ? 1 : 0,
          color: GEM_COLOUR[num(sg.GemColour) ?? 0] ?? null,
          tags: tagList.join(','),
          req_level: req1,
          max_level: levels.length ? num(levels[levels.length - 1]!.Level) : null,
          description: isSupport ? str(ge.SupportText) : str(active?.Description),
          data: {
            gemEffectId: str(ge.Id),
            grantedEffect: str(eff?.Id),
            activeSkill: str(active?.Id),
            displayedName: str(active?.DisplayedName),
            castTimeMs: num(eff?.CastTime),
            vaal: !!sg.IsVaalVariant,
            transfigured: vi > 0,
            style: cdn.enumName('GemStyles', ge.ItemColor),
            attrReqPercent: { str: num(sg.StrengthRequirementPercent), dex: num(sg.DexterityRequirementPercent), int: num(sg.IntelligenceRequirementPercent) },
            constantStats: set ? arr(set.ConstantStats).map((k, i) => ({ id: statId(k), value: num(arr(set.ConstantStatsValues)[i]) })) : [],
            implicitStats: set ? arr(set.ImplicitStats).map(statId).filter(Boolean) : [],
            baseEffectiveness: num(set?.BaseEffectiveness),
            incrementalEffectiveness: num(set?.IncrementalEffectiveness),
          },
        });
        for (const l of levels) {
          const lv = num(l.Level);
          if (lv == null) continue;
          const sl = setByLevel?.get(lv);
          const statsAt = sl
            ? [
                ...arr(sl.AdditionalStats).map((k, i) => ({ id: statId(k), value: num(arr(sl.AdditionalStatsValues)[i]) })),
                ...arr(sl.FloatStats).map((k, i) => ({ id: statId(k), value: num(arr(sl.FloatStatsValues)[i]) })),
                ...arr(sl.AdditionalFlags).map((k) => ({ id: statId(k), value: 1 })),
              ]
            : [];
          gem_level.push({
            gem_id: id,
            level: lv,
            req_level: Math.round(num(l.PlayerLevelReq) ?? 0),
            stats: statsAt,
            data: {
              cost: arr(l.CostAmounts).map((a, i) => ({ type: str(at(costTypes, arr(l.CostTypes)[i])?.Id), amount: num(a) })),
              cooldownMs: num(l.Cooldown) || null,
              storedUses: num(l.StoredUses) || null,
              reservation: { manaFlat: num(l.ManaReservationFlat) || null, manaPercent: num(l.ManaReservationPercent) || null, lifeFlat: num(l.LifeReservationFlat) || null, lifePercent: num(l.LifeReservationPercent) || null },
              attackSpeedMultiplier: num(l.AttackSpeedMultiplier) || null,
              damageEffectiveness: num(sl?.DamageEffectiveness) ?? null,
              baseMultiplier: num(sl?.BaseMultiplier) ?? null,
              critChance: num(sl?.SpellCritChance) || num(sl?.AttackCritChance) || null,
            },
          });
        }
      });
    }

    // ---- passives and ascendancies
    const ascRows = await cdn.table('Ascendancy', ['Id', 'Name', 'Character', 'ClassNo', 'FlavourText']);
    const ascendancy: EntityRow[] = ascRows
      .filter((a) => str(a.Name))
      .map((a) => ({ id: str(a.Id), name: str(a.Name), class: className(a.Character), data: { classNo: num(a.ClassNo), flavour: str(a.FlavourText) } }));
    const passives = await cdn.table('PassiveSkills', ['Id', 'Name', 'PassiveSkillGraphId', 'Stats', 'Stat1Value', 'Stat2Value', 'Stat3Value', 'Stat4Value', 'Stat5Value', 'IsKeystone', 'IsNotable', 'IsJewelSocket', 'AscendancyKey', 'IsAscendancyStartingNode', 'SkillPointsGranted', 'FlavourText', 'MasteryGroup', 'IsMultipleChoiceOption', 'SkillType']);
    const passive: EntityRow[] = [];
    const passiveIds: Record<string, { hash: number; name: string }> = {};
    for (const p of passives) {
      const id = str(p.Id);
      const hash = num(p.PassiveSkillGraphId);
      if (!id || hash == null) continue;
      const tree = cdn.enumName('PassiveSkillTypes', p.SkillType);
      if (tree && tree !== 'PASSIVE_TREE') continue;
      const kind = p.IsKeystone ? 'keystone' : p.IsNotable ? 'notable' : p.IsJewelSocket ? 'jewel' : p.MasteryGroup != null ? 'mastery' : p.IsAscendancyStartingNode ? 'ascendancy_start' : 'normal';
      const asc = at(ascRows, p.AscendancyKey);
      const st = arr(p.Stats).map((k, i) => ({ id: statId(k), value: num(p[`Stat${i + 1}Value`]) }));
      passive.push({
        id,
        hash,
        name: str(p.Name),
        node_kind: kind,
        ascendancy: str(asc?.Name) || null,
        stats: st,
        data: { flavour: str(p.FlavourText) || undefined, skillPoints: num(p.SkillPointsGranted) || undefined, multipleChoiceOption: !!p.IsMultipleChoiceOption || undefined },
      });
      passiveIds[id] = { hash, name: str(p.Name) };
    }

    // ---- quests, rewards, areas, bosses
    const quests = await cdn.table('Quest', ['Id', 'Act', 'Name', 'QuestId']);
    const quest: EntityRow[] = quests.filter((q) => str(q.Name)).map((q) => ({ id: str(q.Id), name: str(q.Name), act: num(q.Act), data: { questId: num(q.QuestId) } }));
    const offers = await safe('QuestRewardOffers', ['Id', 'QuestKey']);
    const qRewards = await safe('QuestRewards', ['RewardOffer', 'Characters', 'Reward', 'RewardLevel', 'RewardStack']);
    const clientStrings = await safe('ClientStrings', ['Id', 'Text']);
    const qStatic = await safe('QuestStaticRewards', ['QuestKey', 'StatsKeys', 'StatValues', 'ClientStringsKey']);
    const quest_reward: EntityRow[] = [];
    qRewards.forEach((r, i) => {
      const off = at(offers, r.RewardOffer);
      const q = at(quests, off?.QuestKey);
      if (!q) return;
      const b = at(bases, r.Reward);
      const clsId = str(at(itemClasses, b?.ItemClassesKey)?.Id);
      quest_reward.push({
        id: `cdn:qr:${i}`,
        quest_id: str(q.Id),
        reward_type: /Gem/.test(clsId) ? 'gem_quest' : 'item',
        reward: str(b?.Name),
        classes: arr(r.Characters).map(className).filter(Boolean).join(', ') || 'all',
        data: { offer: str(off?.Id), baseId: str(b?.Id), itemLevel: num(r.RewardLevel), stack: num(r.RewardStack), act: num(q.Act), quest: str(q.Name) },
      });
    });
    qStatic.forEach((r, i) => {
      const q = at(quests, r.QuestKey);
      if (!q) return;
      const st = arr(r.StatsKeys).map((k, j) => ({ id: statId(k), value: num(arr(r.StatValues)[j]) }));
      quest_reward.push({
        id: `cdn:qs:${i}`,
        quest_id: str(q.Id),
        reward_type: 'static',
        reward: str(at(clientStrings, r.ClientStringsKey)?.Text) || st.map((s) => `${s.id} ${s.value}`).join(', '),
        classes: 'all',
        data: { stats: st, act: num(q.Act), quest: str(q.Name) },
      });
    });
    const monsters = await safe('MonsterVarieties', ['Id', 'Name']);
    const areas = await cdn.table('WorldAreas', ['Id', 'Name', 'Act', 'IsTown', 'HasWaypoint', 'AreaLevel', 'IsMapArea', 'IsHideout', 'IsLabyrinthArea', 'Bosses_MonsterVarietiesKeys', 'Connections_WorldAreasKeys', 'IsVaalArea']);
    const area: EntityRow[] = [];
    const boss: EntityRow[] = [];
    const seenBoss = new Set<string>();
    for (const a of areas) {
      const name = str(a.Name).trim();
      if (!name) continue;
      const bossList = arr(a.Bosses_MonsterVarietiesKeys).map((k) => at(monsters, k)).filter((m): m is DatRow => !!m && !!str(m.Name));
      area.push({
        id: str(a.Id),
        name,
        act: num(a.Act),
        area_level: num(a.AreaLevel),
        is_town: a.IsTown ? 1 : 0,
        has_waypoint: a.HasWaypoint ? 1 : 0,
        data: {
          map: !!a.IsMapArea || undefined,
          hideout: !!a.IsHideout || undefined,
          labyrinth: !!a.IsLabyrinthArea || undefined,
          vaal: !!a.IsVaalArea || undefined,
          bosses: bossList.map((m) => str(m.Name)),
          connections: arr(a.Connections_WorldAreasKeys).map((k) => str(at(areas, k)?.Id)).filter(Boolean),
        },
      });
      for (const m of bossList) {
        const key = `${str(m.Id)}@${str(a.Id)}`;
        if (seenBoss.has(key)) continue;
        seenBoss.add(key);
        boss.push({
          id: `area:${key}`,
          name: str(m.Name),
          summary: `Boss in ${name} (${a.IsMapArea ? 'map' : `act ${num(a.Act)}`}, area level ${num(a.AreaLevel)}).`,
          data: { monster: str(m.Id), area: str(a.Id) },
        });
      }
    }
    const trials = await safe('LabyrinthTrials', ['WorldAreas']);
    const labTrials = trials
      .map((t) => at(areas, t.WorldAreas))
      .filter((a): a is DatRow => !!a)
      .map((a) => ({ id: str(a.Id), name: str(a.Name), act: num(a.Act), areaLevel: num(a.AreaLevel) }));

    // ---- league mechanic tables (Allflame is "Deepwater" in the game files)
    const league_mechanic: EntityRow[] = [];
    const charts = await safe('DeepwaterCharts', ['BaseItemType', 'Biome']);
    const biomes = await safe('DeepwaterBiomes', ['Id', 'WorldArea']);
    const ducats = await safe('DeepwaterCursedDucats', ['BaseItemType', 'Id']);
    const ducatStats = await safe('DeepwaterStatsPerCursedDucat', ['Count', 'Stats', 'StatValues']);
    if (charts.length) {
      league_mechanic.push({
        id: 'allflame:charts',
        league: 'Allflame',
        name: 'Allflame Charts (datamined list)',
        summary: `Chart items in the game files: ${charts.map((c) => baseName(c.BaseItemType)).filter(Boolean).join(', ')}.`,
        data: { charts: charts.map((c) => ({ item: baseName(c.BaseItemType), baseId: baseId(c.BaseItemType), biome: str(at(biomes, c.Biome)?.Id), area: str(at(areas, at(biomes, c.Biome)?.WorldArea)?.Name) })) },
      });
    }
    if (ducats.length) {
      league_mechanic.push({
        id: 'allflame:cursed-ducats',
        league: 'Allflame',
        name: 'Allflame Cursed Ducats (datamined list)',
        summary: `Cursed Ducat items in the game files: ${ducats.map((d) => baseName(d.BaseItemType)).filter(Boolean).join(', ')}.`,
        data: {
          ducats: ducats.map((d) => ({ item: baseName(d.BaseItemType), baseId: baseId(d.BaseItemType) })),
          statsPerCount: ducatStats.map((d) => ({ count: num(d.Count), stats: arr(d.Stats).map((k, i) => ({ id: statId(k), value: num(arr(d.StatValues)[i]) })) })),
        },
      });
    }

    log(`cdn: ${patch}: ${gem.length} gems, ${gem_level.length} gem levels, ${base_item.length} bases, ${mod.length} mods, ${passive.length} passives, ${area.length} areas; downloaded ${(cdn.downloaded / 1e6).toFixed(1)} MB`);
    return {
      url,
      patch,
      fetchedAt: new Date().toISOString(),
      entities: { gem, gem_level, base_item, mod, passive, ascendancy, quest, quest_reward, area, boss, div_card, currency, league_mechanic },
      tables: {
        'passive-ids': { data: passiveIds },
        'lab-trials': { data: labTrials },
        'mod-tiers': { data: modTiers },
        'gem-requirements': { data: gem.filter((g) => typeof g.req_level === 'number').map((g) => ({ gemId: g.id, level: g.req_level })) },
      },
      note: `dat-schema createdAt ${cdn.schemaCreatedAt ? new Date(cdn.schemaCreatedAt * 1000).toISOString() : '?'}`,
    };
  },
};
