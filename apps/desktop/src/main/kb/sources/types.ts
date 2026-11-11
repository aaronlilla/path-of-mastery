import type { KbDb } from '../db.js';
import type { PoliteHttp } from '../http.js';
import type { EntityName, SourceType } from '../schema.js';

/** Paths of data the app already ships (the `app` source reads them). */
export interface AppDataPaths {
  /** resources/leveling (exile-leveling seed, one folder per league). */
  levelingDir: string;
  /** resources/lootfilter (cardRewards.json). */
  lootfilterDir: string;
  /** engine-data (data_*.json). */
  engineDataDir: string;
}

export interface SourceCtx {
  http: PoliteHttp;
  /** Per-source scratch/cache folder root (CDN bundles live in <cacheDir>/cdn/<patch>). */
  cacheDir: string;
  /** The live game patch from latest.txt (e.g. "3.29.3.3"). */
  livePatch: string;
  app: AppDataPaths;
  /** The previous KB, when there is one (sources may reuse unchanged work). */
  previous?: KbDb;
  log(msg: string): void;
}

export type EntityRow = Record<string, unknown> & {
  /** Overrides of the source's provenance for this row. */
  source_url?: string;
  source_type?: SourceType;
  patch?: string;
};

export interface Pulled {
  /** Main URL of the source (for the `source` table and rows without their own URL). */
  url: string;
  /** Game patch these rows describe. */
  patch: string;
  fetchedAt: string;
  entities: Partial<Record<EntityName, EntityRow[]>>;
  /** Named JSON tables (the Journey KnowledgeBase interface). */
  tables?: Record<string, { data: unknown; url?: string; type?: SourceType; patch?: string }>;
  note?: string;
}

export interface KbSource {
  id: string;
  type: SourceType;
  pull(ctx: SourceCtx): Promise<Pulled>;
}
