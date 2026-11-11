import { parseXml } from './buildXml.js';

/** The game version the app calculates for (GameVersions.lua `liveTargetVersion`); a build without one is a 2.6 build. */
export const LIVE_TARGET_VERSION = '3_0';
const LEGACY_TARGET_VERSION = '2_6';

export type Gate = null | 'unknown-tree' | 'game-version';

/** Which question, if any, this build text raises when it is opened. `known` is the list of tree versions the app has data for. */
export function gateFor(xml: string, known: string[]): Gate {
  let root;
  try {
    root = parseXml(xml);
  } catch {
    return null;
  }
  const tree = root.children.find((c) => c.tag === 'Tree');
  for (const s of tree?.children ?? []) {
    if (s.tag === 'Spec' && s.attrs.treeVersion && !known.includes(s.attrs.treeVersion)) return 'unknown-tree';
  }
  const build = root.children.find((c) => c.tag === 'Build');
  const target = build?.attrs.targetVersion || LEGACY_TARGET_VERSION;
  return build && target !== LIVE_TARGET_VERSION ? 'game-version' : null;
}
