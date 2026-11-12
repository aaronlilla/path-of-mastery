import { parseXml, type XmlNode } from './buildXml.js';

/**
 * Plain-text helpers on a build's XML for cloud sync: the one-line summary of what changed between two saves (shown
 * in Version history) and the copy of a build that a share link serves.
 */

function child(n: XmlNode | undefined, tag: string): XmlNode | undefined {
  return n?.children.find((c) => c.tag === tag);
}

function root(xml: string): XmlNode | null {
  try {
    const r = parseXml(xml);
    return r.tag === 'PathOfBuilding' ? r : null;
  } catch {
    return null;
  }
}

function activeSpec(r: XmlNode): XmlNode | undefined {
  const tree = child(r, 'Tree');
  const specs = tree?.children.filter((c) => c.tag === 'Spec') ?? [];
  const i = Math.max(1, parseInt(tree?.attrs.activeSpec ?? '1', 10) || 1);
  return specs[i - 1] ?? specs[0];
}

function activeSet(parent: XmlNode | undefined, setTag: string, activeAttr: string): XmlNode | undefined {
  const sets = parent?.children.filter((c) => c.tag === setTag) ?? [];
  const id = parent?.attrs[activeAttr];
  return sets.find((s) => s.attrs.id === id) ?? sets[0];
}

/** Slot name to the item's name for the active item set. */
function equipped(r: XmlNode): Map<string, string> {
  const items = child(r, 'Items');
  const out = new Map<string, string>();
  if (!items) return out;
  const byId = new Map<string, string>();
  for (const it of items.children.filter((c) => c.tag === 'Item')) {
    const lines = it.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    const nameLines = lines.filter((l) => !/^Rarity:/.test(l));
    byId.set(it.attrs.id ?? '', (nameLines[0] ?? '').replace(/^Item Class:.*/, '') || lines[1] || 'Item');
  }
  const set = activeSet(items, 'ItemSet', 'activeItemSet') ?? items;
  for (const s of set.children.filter((c) => c.tag === 'Slot')) {
    const id = s.attrs.itemId ?? '0';
    if (id !== '0' && s.attrs.name) out.set(s.attrs.name, byId.get(id) ?? `Item ${id}`);
  }
  return out;
}

function gemsSignature(r: XmlNode): string {
  const skills = child(r, 'Skills');
  const set = activeSet(skills, 'SkillSet', 'activeSkillSet') ?? skills;
  if (!set) return '';
  return set.children
    .filter((c) => c.tag === 'Skill')
    .map((g) => g.children.filter((x) => x.tag === 'Gem').map((x) => `${x.attrs.nameSpec ?? x.attrs.skillId ?? ''}:${x.attrs.level ?? ''}:${x.attrs.quality ?? ''}:${x.attrs.enabled ?? ''}`).join(','))
    .join('|');
}

function configSignature(r: XmlNode): string {
  const cfg = child(r, 'Config');
  const set = activeSet(cfg, 'ConfigSet', 'activeConfigSet') ?? cfg;
  if (!set) return '';
  return set.children
    .filter((c) => c.tag === 'Input' || c.tag === 'Placeholder')
    .map((i) => `${i.attrs.name}=${i.attrs.number ?? i.attrs.string ?? i.attrs.boolean ?? ''}`)
    .sort()
    .join(';');
}

function nodeSet(spec: XmlNode | undefined): Set<string> {
  return new Set((spec?.attrs.nodes ?? '').split(',').filter((x) => x !== ''));
}

/** One line on what a save changed, like "+3 passives · Swapped Gloves: Doom Knuckle". Empty when there is no earlier text. */
export function describeChange(prevXml: string | null, nextXml: string): string {
  if (!prevXml) return '';
  const a = root(prevXml);
  const b = root(nextXml);
  if (!a || !b) return '';
  const parts: string[] = [];
  const ba = child(a, 'Build')?.attrs ?? {};
  const bb = child(b, 'Build')?.attrs ?? {};
  if (ba.className !== bb.className || ba.ascendClassName !== bb.ascendClassName) parts.push(`Class: ${bb.ascendClassName && bb.ascendClassName !== 'None' ? bb.ascendClassName : bb.className}`);
  if (ba.level !== bb.level && bb.level) parts.push(`Level ${ba.level ?? '?'} to ${bb.level}`);

  const sa = nodeSet(activeSpec(a));
  const sb = nodeSet(activeSpec(b));
  let added = 0;
  let removed = 0;
  for (const n of sb) if (!sa.has(n)) added++;
  for (const n of sa) if (!sb.has(n)) removed++;
  if (added || removed) {
    if (added && removed && added !== removed) parts.push(`+${added} −${removed} passives`);
    else if (added && removed) parts.push(`${added} passives swapped`);
    else if (added) parts.push(`+${added} passive${added === 1 ? '' : 's'}`);
    else parts.push(`−${removed} passive${removed === 1 ? '' : 's'}`);
  } else if (activeSpec(a)?.attrs.masteryEffects !== activeSpec(b)?.attrs.masteryEffects) parts.push('Mastery changed');
  const ta = child(a, 'Tree')?.children.filter((c) => c.tag === 'Spec').length ?? 0;
  const tb = child(b, 'Tree')?.children.filter((c) => c.tag === 'Spec').length ?? 0;
  if (tb > ta) parts.push(`New loadout${activeSpec(b)?.attrs.title ? ` "${activeSpec(b)!.attrs.title}"` : ''}`);

  const ea = equipped(a);
  const eb = equipped(b);
  const changedSlots = [...new Set([...ea.keys(), ...eb.keys()])].filter((s) => ea.get(s) !== eb.get(s));
  if (changedSlots.length === 1) {
    const s = changedSlots[0]!;
    parts.push(eb.has(s) ? `${ea.has(s) ? 'Swapped' : 'Equipped'} ${s}: ${eb.get(s)}` : `Removed ${s}`);
  } else if (changedSlots.length > 1) parts.push(`${changedSlots.length} items changed`);

  if (gemsSignature(a) !== gemsSignature(b)) parts.push('Skills changed');
  if (configSignature(a) !== configSignature(b)) parts.push('Config changed');
  const na = /<Notes>([\s\S]*?)<\/Notes>/.exec(prevXml)?.[1] ?? '';
  const nb = /<Notes>([\s\S]*?)<\/Notes>/.exec(nextXml)?.[1] ?? '';
  if (na !== nb) parts.push('Notes edited');
  if (!parts.length) return 'Edited';
  return parts.slice(0, 3).join(' · ');
}

/** A short list of what changed for a build waiting to upload, like "Tree, items". */
export function describeChangeShort(prevXml: string | null, nextXml: string): string {
  if (!prevXml) return 'New build';
  const a = root(prevXml);
  const b = root(nextXml);
  if (!a || !b) return 'Edited';
  const what: string[] = [];
  if (activeSpec(a)?.attrs.nodes !== activeSpec(b)?.attrs.nodes || activeSpec(a)?.attrs.masteryEffects !== activeSpec(b)?.attrs.masteryEffects) what.push('Tree');
  const ea = equipped(a);
  const eb = equipped(b);
  if ([...new Set([...ea.keys(), ...eb.keys()])].some((s) => ea.get(s) !== eb.get(s))) what.push('items');
  if (gemsSignature(a) !== gemsSignature(b)) what.push('skills');
  if (configSignature(a) !== configSignature(b)) what.push('config');
  if ((/<Notes>([\s\S]*?)<\/Notes>/.exec(prevXml)?.[1] ?? '') !== (/<Notes>([\s\S]*?)<\/Notes>/.exec(nextXml)?.[1] ?? '')) what.push('notes');
  if (!what.length) return 'Edited';
  return what.join(', ').replace(/^./, (c) => c.toUpperCase());
}

export interface ShareOptions {
  includeNotes: boolean;
  includeLoadouts: boolean;
}

/** Keeps only the block `keep` of the sibling blocks `tag` inside the element opened by `openTag`. */
function keepOneSet(xml: string, container: string, setTag: string, activeAttr: string, byIndex: boolean): string {
  const cre = new RegExp(`(<${container}\\b[^>]*>)([\\s\\S]*?)(</${container}>)`);
  const cm = cre.exec(xml);
  if (!cm) return xml;
  const [, open, inner, close] = cm as unknown as [string, string, string, string];
  const sre = new RegExp(`[ \\t]*<${setTag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${setTag}>)[ \\t]*\\r?\\n?`, 'g');
  const blocks = [...inner.matchAll(sre)];
  if (blocks.length <= 1) return xml;
  const attrs = /\b([A-Za-z]+)="([^"]*)"/g;
  const activeVal = new RegExp(`\\b${activeAttr}="([^"]*)"`).exec(open)?.[1] ?? '1';
  let keepIdx = 0;
  if (byIndex) keepIdx = Math.min(blocks.length, Math.max(1, parseInt(activeVal, 10) || 1)) - 1;
  else {
    const found = blocks.findIndex((b) => new RegExp(`\\bid="${activeVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(b[0].slice(0, b[0].indexOf('>') + 1)));
    keepIdx = found >= 0 ? found : 0;
  }
  void attrs;
  const kept = blocks[keepIdx]![0];
  const first = blocks[0]!.index!;
  const lastB = blocks[blocks.length - 1]!;
  const after = lastB.index! + lastB[0].length;
  const newInner = inner.slice(0, first) + kept + inner.slice(after);
  const newOpen = byIndex ? open.replace(new RegExp(`\\b${activeAttr}="[^"]*"`), `${activeAttr}="1"`) : open;
  return xml.slice(0, cm.index) + newOpen + newInner + close + xml.slice(cm.index + cm[0].length);
}

/**
 * The copy of a build a share link serves. Notes can be left out, and the other loadouts (tree specs, skill sets,
 * item sets, config sets) can be dropped so the link opens on the active ones only.
 */
export function shareSnapshot(xml: string, o: ShareOptions): string {
  let out = xml;
  if (!o.includeNotes) out = out.replace(/<Notes>[\s\S]*?<\/Notes>/, '<Notes></Notes>').replace(/<Notes\s*\/>/, '<Notes></Notes>');
  if (!o.includeLoadouts) {
    out = keepOneSet(out, 'Tree', 'Spec', 'activeSpec', true);
    out = keepOneSet(out, 'Skills', 'SkillSet', 'activeSkillSet', false);
    out = keepOneSet(out, 'Items', 'ItemSet', 'activeItemSet', false);
    out = keepOneSet(out, 'Config', 'ConfigSet', 'activeConfigSet', false);
  }
  return out;
}
