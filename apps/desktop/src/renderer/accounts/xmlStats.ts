import { parseXml, type XmlNode } from '../../shared/buildXml.js';

/** The numbers the conflict and history dialogs compare. They come from the engine; nothing is computed here. */
export interface CompareStats {
  fullDps: number | null;
  life: number | null;
  chaosRes: number | null;
  passives: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Combined DPS as the sidebar shows it: Full DPS when the build has Full DPS skills, otherwise Combined DPS (Full DPS reads 0 without them). */
function dpsOf(by: Map<string, unknown>): number | null {
  for (const id of ['FullDPS', 'CombinedDPS', 'TotalDPS']) {
    const v = num(by.get(id));
    if (v != null && v > 0) return v;
  }
  return num(by.get('FullDPS')) ?? num(by.get('CombinedDPS')) ?? num(by.get('TotalDPS'));
}

/** Loads the build text into the engine, reads the stats, and closes the session again so no open build is displaced for long. */
export async function engineStats(xml: string): Promise<CompareStats | null> {
  // A throw-away copy, not the player's open build (engine.open marks that one to be kept).
  const open = await window.pom.sendCommand('loadBuild', { buildXml: xml });
  if (!open.ok) return null;
  const buildId = open.result.buildId;
  try {
    const r = await window.pom.sendCommand('getStats', { buildId });
    if (!r.ok) return null;
    const by = new Map(r.result.stats.map((s) => [s.id, s.value]));
    return { fullDps: dpsOf(by), life: num(by.get('Life')), chaosRes: num(by.get('ChaosResist')), passives: allocatedPassives(xml) };
  } finally {
    void window.pom.sendCommand('closeBuild', { buildId });
  }
}

function child(n: XmlNode | undefined, tag: string): XmlNode | undefined {
  return n?.children.find((c) => c.tag === tag);
}

/** Allocated passives of the active tree, as the build file lists them. */
export function allocatedPassives(xml: string): number {
  try {
    const tree = child(parseXml(xml), 'Tree');
    const specs = tree?.children.filter((c) => c.tag === 'Spec') ?? [];
    const spec = specs[Math.max(1, parseInt(tree?.attrs.activeSpec ?? '1', 10) || 1) - 1] ?? specs[0];
    return (spec?.attrs.nodes ?? '').split(',').filter((x) => x !== '').length;
  } catch {
    return 0;
  }
}

/** The name of the item in a slot of the active item set, or ''. */
export function itemInSlot(xml: string, slot: string): string {
  try {
    const r = parseXml(xml);
    const items = child(r, 'Items');
    if (!items) return '';
    const sets = items.children.filter((c) => c.tag === 'ItemSet');
    const set = sets.find((s) => s.attrs.id === items.attrs.activeItemSet) ?? sets[0] ?? items;
    const s = set.children.find((c) => c.tag === 'Slot' && c.attrs.name === slot);
    const id = s?.attrs.itemId;
    if (!id || id === '0') return '';
    const it = items.children.find((c) => c.tag === 'Item' && c.attrs.id === id);
    const lines = (it?.text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Rarity:/.test(l));
    return lines[0] ?? '';
  } catch {
    return '';
  }
}
