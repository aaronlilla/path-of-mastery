import type { AssetRef } from '@pom/mastery-contracts';

export type NodeArt = { url: string; width: number; height: number; x: number; y: number; w: number; h: number };
/** One rectangle of an official sprite sheet, at the sheet's zoom level (world size = w / zoom). */
export type Sprite = { image: CanvasImageSource; x: number; y: number; w: number; h: number; zoom: number };
/** The official atlas art by data.json sprite family and name, at the zoom level that fits `scale` (screen px per world unit). */
export type SpriteSource = (family: string, name: string, scale: number, datasetHash?: string) => Sprite | null;
export type ArtResolver = ((asset: AssetRef, nodeId: string, datasetHash?: string) => NodeArt | null) & { sprite?: SpriteSource };

// URLs come from the caller's verified local asset store, never the export's remote URL.
export function spriteArt(asset: AssetRef, icon: unknown, sprites: Record<string, unknown>, url: string | null): NodeArt | null {
  if (!url || typeof icon !== 'string') return null;
  for (const family of Object.values(sprites)) {
    if (!family || typeof family !== 'object') continue;
    for (const candidate of Object.values(family)) {
      if (!candidate || typeof candidate !== 'object') continue;
      const s = candidate as Record<string, unknown>;
      if (typeof s.filename !== 'string') continue;
      let basename: string | undefined;
      try { basename = new URL(s.filename).pathname.split('/').at(-1); } catch { continue; }
      if (asset.assetId !== `assets/${basename}` || !s.coords || typeof s.coords !== 'object') continue;
      const c = (s.coords as Record<string, unknown>)[icon] as Record<string, unknown> | undefined;
      if (!c) continue;
      const values = [s.w, s.h, c.x, c.y, c.w, c.h];
      if (!values.every(n => typeof n === 'number' && Number.isFinite(n))) continue;
      const [width, height, x, y, w, h] = values as number[];
      if (width! <= 0 || height! <= 0 || x! < 0 || y! < 0 || w! <= 0 || h! <= 0 || x! + w! > width! || y! + h! > height!) continue;
      return { url, width: width!, height: height!, x: x!, y: y!, w: w!, h: h! };
    }
  }
  return null;
}
