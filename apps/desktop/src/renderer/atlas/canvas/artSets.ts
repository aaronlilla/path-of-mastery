import type { AssetRef } from '@pom/mastery-contracts';
import { spriteArt, type NodeArt } from './art.js';

/** One tree-data variant's icon names and sprite tables, exactly as its own data.json lists them. */
export type ArtIndex = { icons: Record<string, string>; sprites: Record<string, Record<string, unknown>> };

const basename = (filename: unknown): string | null => { try { return new URL(String(filename)).pathname.split('/').at(-1) ?? null; } catch { return null; } };

/**
 * Art per tree-data variant, keyed by the dataset's content hash. Variants are never merged: the league sheets are laid out
 * differently from the base ones (same file names, other coordinates), so a node's rectangle must come from its own variant's
 * table and the sheet that table names (identified by its full CDN filename, version query included).
 */
export class ArtSets {
  private sets = new Map<string, ArtIndex>();
  private first: string | null = null;
  add(datasetHash: string, index: ArtIndex): void { this.sets.set(datasetHash, index); this.first ??= datasetHash; }
  resolve(datasetHash?: string): string { return datasetHash ?? this.first ?? ''; }
  /** The variant's tables; no hash means the first one added (the default tree data). A hash that was never added gives nothing. */
  get(datasetHash?: string): ArtIndex | undefined { return this.sets.get(this.resolve(datasetHash)); }
  /** The full CDN filename this variant uses for the sheet `assetId` (e.g. assets/atlas-skills-4.jpg), or null. */
  filename(datasetHash: string | undefined, assetId: string): string | null {
    for (const zooms of Object.values(this.get(datasetHash)?.sprites ?? {}))
      for (const raw of Object.values(zooms)) { const f = (raw as { filename?: unknown }).filename; if (assetId === `assets/${basename(f)}`) return String(f); }
    return null;
  }
  nodeArt(datasetHash: string | undefined, asset: AssetRef, nodeId: string, urlOf: (filename: string) => string | null): NodeArt | null {
    const set = this.get(datasetHash), filename = this.filename(datasetHash, asset.assetId);
    return set && filename ? spriteArt(asset, set.icons[nodeId], set.sprites, urlOf(filename)) : null;
  }
}
