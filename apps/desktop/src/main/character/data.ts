import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_TREE_VERSION } from '../../shared/buildXml.js';
import type { ConvertData, TreeInfo } from './convert.js';
import type { ItemData } from './items.js';
import { runDataJob } from '../dataWorker.js';

/** The game data a character import reads: item bases, gems and the passive tree, from the engine's own data files. */

const dir = () => process.env.POM_ENGINE_DATA ?? '';

let itemData: Promise<ItemData> | undefined;

/** Item bases and gems, parsed on a worker thread (data_gems.json alone is 6 MB). */
export function loadItemData(): Promise<ItemData> {
  itemData ??= runDataJob('itemData');
  itemData.catch(() => {
    itemData = undefined;
  });
  return itemData;
}

const trees = new Map<string, TreeInfo>();
const treeLoads = new Map<string, Promise<TreeInfo>>();

/** One passive tree's classes, nodes and tattoos, parsed on a worker thread; imports at the same moment share one read. */
export function loadTree(version: string): Promise<TreeInfo> {
  const have = trees.get(version);
  if (have) return Promise.resolve(have);
  let p = treeLoads.get(version);
  if (!p) {
    p = runDataJob('treeInfo', version).then(
      (info) => {
        trees.set(version, info);
        treeLoads.delete(version);
        return info;
      },
      (e: unknown) => {
        treeLoads.delete(version);
        throw e;
      },
    );
    treeLoads.set(version, p);
  }
  return p;
}

/** The data `applyCharacter` needs, with the trees it may ask for loaded ahead. */
export async function loadConvertData(): Promise<ConvertData> {
  const items = await loadItemData();
  const latest = CURRENT_TREE_VERSION;
  const versions = [latest, `${latest}_ruthless`, `${latest}_alternate`, `${latest}_ruthless_alternate`].filter((v) => existsSync(join(dir(), `tree_${v}.json`)));
  await Promise.all(versions.map(loadTree));
  return {
    items,
    latestTree: latest,
    hasTree: (v) => versions.includes(v),
    tree: (v) => {
      const t = trees.get(v);
      if (!t) throw new Error(`The passive tree ${v} is not loaded.`);
      return t;
    },
  };
}
