import type { BuildInfo } from './library.js';

/**
 * Just enough of an upstream build file to show it in the library and edit its notes. The file is never
 * re-serialised: the only edit we make is splicing the text of the <Notes> element, so everything
 * else stays byte for byte what upstream (or whoever) wrote.
 */

export const CLASSES: { name: string; classId: number; ascendancies: string[] }[] = [
  { name: 'Scion', classId: 0, ascendancies: ['Ascendant'] },
  { name: 'Marauder', classId: 1, ascendancies: ['Juggernaut', 'Berserker', 'Chieftain'] },
  { name: 'Ranger', classId: 2, ascendancies: ['Raider', 'Deadeye', 'Pathfinder'] },
  { name: 'Witch', classId: 3, ascendancies: ['Occultist', 'Elementalist', 'Necromancer'] },
  { name: 'Duelist', classId: 4, ascendancies: ['Slayer', 'Gladiator', 'Champion'] },
  { name: 'Templar', classId: 5, ascendancies: ['Inquisitor', 'Hierophant', 'Guardian'] },
  { name: 'Shadow', classId: 6, ascendancies: ['Assassin', 'Saboteur', 'Trickster'] },
];

export const CURRENT_TREE_VERSION = '3_29';

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    switch (e) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escapes element text. Upstream writes quotes and apostrophes as-is inside element text. */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src))) out[m[1]!] = unescapeXml(m[2] ?? m[3] ?? '');
  return out;
}

/** A small forgiving XML reader: elements, attributes and text. Throws when nothing parses. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m.index > last) top.text += unescapeXml(xml.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined && m[0].startsWith('<![CDATA[')) {
      top.text += m[1];
      continue;
    }
    const tag = m[3];
    if (!tag) continue;
    if (m[2] === '/') {
      if (stack.length > 1) stack.pop();
    } else {
      const node: XmlNode = { tag, attrs: parseAttrs(m[4] ?? ''), children: [], text: '' };
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
    }
  }
  const first = root.children[0];
  if (!first) throw new Error('not XML');
  return first;
}

function child(n: XmlNode | undefined, tag: string): XmlNode | undefined {
  return n?.children.find((c) => c.tag === tag);
}

/** The main skill's name: the first enabled, non-support gem of the main socket group. */
function mainSkillOf(root: XmlNode, mainGroup: number): string {
  const skills = child(root, 'Skills');
  if (!skills) return '';
  let groups: XmlNode[];
  const sets = skills.children.filter((c) => c.tag === 'SkillSet');
  if (sets.length) {
    const activeId = skills.attrs.activeSkillSet;
    const active = sets.find((s) => s.attrs.id === activeId) ?? sets[0]!;
    groups = active.children.filter((c) => c.tag === 'Skill');
  } else {
    groups = skills.children.filter((c) => c.tag === 'Skill');
  }
  const group = groups[Math.max(0, mainGroup - 1)] ?? groups[0];
  if (!group) return '';
  const gems = group.children.filter((c) => c.tag === 'Gem' && c.attrs.enabled !== 'false');
  const active = gems.find((g) => !/^Support/.test(g.attrs.skillId ?? '') && !/ Support$/.test(g.attrs.nameSpec ?? '') && (g.attrs.nameSpec || g.attrs.skillId));
  const pick = active ?? gems[0];
  return pick?.attrs.nameSpec || pick?.attrs.skillId || group.attrs.label || '';
}

export function readBuildInfo(xml: string): BuildInfo {
  const bad: BuildInfo = { className: '', ascendClassName: '', level: 1, mainSkill: '', treeVersion: '', valid: false };
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    return bad;
  }
  if (root.tag !== 'PathOfBuilding') return bad;
  const build = child(root, 'Build');
  if (!build) return bad;
  const level = parseInt(build.attrs.level ?? '', 10);
  const asc = build.attrs.ascendClassName ?? '';
  const tree = child(root, 'Tree');
  const specs = tree?.children.filter((c) => c.tag === 'Spec') ?? [];
  const specIdx = Math.max(0, (parseInt(tree?.attrs.activeSpec ?? '1', 10) || 1) - 1);
  const spec = specs[specIdx] ?? specs[0];
  // The headline numbers upstream writes into <Build> as <PlayerStat stat=".." value=".."/> on every save.
  const stat = (name: string): number | undefined => {
    const n = build.children.find((c) => c.tag === 'PlayerStat' && c.attrs.stat === name);
    const v = n ? Number(n.attrs.value) : NaN;
    return Number.isFinite(v) ? v : undefined;
  };
  const figures = figuresOf({ FullDPS: stat('FullDPS'), CombinedDPS: stat('CombinedDPS'), MinionCombinedDPS: stat('MinionCombinedDPS'), Life: stat('Life') });
  const stamp = STAMP_RE.exec(getNotes(xml).split('\n', 1)[0] ?? '');
  return {
    className: build.attrs.className ?? '',
    ascendClassName: asc === 'None' || asc === 'nil' ? '' : asc,
    level: Number.isFinite(level) && level > 0 ? level : 1,
    mainSkill: mainSkillOf(root, parseInt(build.attrs.mainSocketGroup ?? '1', 10) || 1),
    treeVersion: spec?.attrs.treeVersion ?? '',
    valid: true,
    ...figures,
    ...(stamp ? { stamp: { league: stamp[1]!, patch: stamp[2]! } } : {}),
  };
}

/** The line a followed league starter carries at the top of its notes (tools/mastery-starters/chooser.ts writes it). */
const STAMP_RE = /^League start: (.+), patch (\S+)$/;

export type PlayerStats = Partial<Record<'FullDPS' | 'CombinedDPS' | 'MinionCombinedDPS' | 'Life', number>>;
const FIGURE_STATS = ['FullDPS', 'CombinedDPS', 'MinionCombinedDPS', 'Life'] as const;

/** The three <PlayerStat> numbers a library card reads, out of the engine's stat list. */
export function playerStatsOf(stats: ReadonlyArray<{ id: string; value: unknown }>): PlayerStats {
  const out: PlayerStats = {};
  for (const n of FIGURE_STATS) {
    const v = stats.find((s) => s.id === n)?.value;
    if (typeof v === 'number' && Number.isFinite(v)) out[n] = v;
  }
  return out;
}

/** The card's DPS (Full DPS when it is above zero, else Combined DPS, as the sidebar's first tile) and Life. */
export function figuresOf(ps: PlayerStats): { dps?: number; life?: number } {
  // a minion build has no player hit: its card shows the minion's damage rather than 0
  const dps = ps.FullDPS !== undefined && ps.FullDPS > 0 ? ps.FullDPS : ps.CombinedDPS ? ps.CombinedDPS : ps.MinionCombinedDPS ?? ps.CombinedDPS;
  return { ...(dps !== undefined ? { dps } : {}), ...(ps.Life !== undefined ? { life: ps.Life } : {}) };
}

/** The build text with its FullDPS, CombinedDPS and Life <PlayerStat> lines replaced by `ps`; everything else is left as it is. */
export function withPlayerStats(xml: string, ps: PlayerStats): string {
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const lines = FIGURE_STATS.flatMap((n) => (ps[n] === undefined ? [] : [`<PlayerStat stat="${n}" value="${ps[n]}"/>`]));
  if (!lines.length || xml.indexOf('</Build>') < 0) return xml; // shortcut: a self-closing <Build/> is left alone, the engine always writes a closing tag
  const stripped = xml.replace(/[ \t]*<PlayerStat\b([^>]*?)(?:\/>|>\s*<\/PlayerStat>)[ \t]*\r?\n?/g, (whole, attrs: string) => {
    const name = /\bstat\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs); // attribute order and quote style are free in XML
    return name && (FIGURE_STATS as readonly string[]).includes(name[1] ?? name[2] ?? '') ? '' : whole;
  });
  const close = stripped.indexOf('</Build>');
  const lineStart = stripped.lastIndexOf('\n', close) + 1;
  const ownLine = /^[ \t]*$/.test(stripped.slice(lineStart, close));
  const block = lines.map((l) => `\t\t${l}${eol}`).join('');
  const at = ownLine ? lineStart : close;
  return stripped.slice(0, at) + (ownLine ? '' : eol) + block + stripped.slice(at);
}

const NOTES_RE = /<Notes>([\s\S]*?)<\/Notes>/;

/** The notes text as the player typed it. Upstream wraps it in a line break and two tabs; those aren't notes. Line breaks read as \n. */
export function getNotes(xml: string): string {
  const m = NOTES_RE.exec(xml);
  if (!m) return '';
  const raw = m[1]!.replace(/^\r?\n\t\t/, '').replace(/\r?\n\t$/, '');
  if (/^\s*$/.test(raw)) return '';
  return unescapeXml(raw).replace(/\r\n/g, '\n');
}

/** Returns the XML with the notes replaced, keeping the file's own line endings. Nothing else in the file changes. */
export function setNotes(xml: string, text: string): string {
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  const body = text === '' ? `${eol}\t\t${eol}\t` : `${eol}\t\t${escapeText(text).replace(/\n/g, eol)}${eol}\t`;
  const block = '<Notes>' + body + '</Notes>';
  if (NOTES_RE.test(xml)) return xml.replace(NOTES_RE, () => block);
  if (/<Notes\s*\/>/.test(xml)) return xml.replace(/<Notes\s*\/>/, () => block);
  const treeView = /\r?\n?[\t ]*<TreeView\b/.exec(xml);
  if (treeView) return xml.slice(0, treeView.index) + eol + '\t' + block + xml.slice(treeView.index);
  const end = xml.lastIndexOf('</PathOfBuilding>');
  if (end < 0) return xml;
  return xml.slice(0, end) + '\t' + block + eol + xml.slice(end);
}

const TIMELESS_RE = /[ \t]*<TimelessData\b[^>]*?\/>[ \t]*\r?\n?/;

/** The attributes of the build's `<TimelessData>` (the Find Timeless Jewel dialog's choices, as upstream saves them). */
export function readTimelessData(xml: string): Record<string, string> | null {
  const m = /<TimelessData\b([^>]*?)\/>/.exec(xml);
  if (!m) return null;
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9]+)="([^"]*)"/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(m[1]!))) out[a[1]!] = unescapeXml(a[2]!);
  return out;
}

/** The raw `<TimelessData .../>` element, for carrying it from one text of the build to another. */
export function timelessElement(xml: string): string | null {
  const m = /<TimelessData\b[^>]*?\/>/.exec(xml);
  return m ? m[0] : null;
}

/** Writes the `<TimelessData>` element the way upstream does (only `<>&'"` escaped, so line breaks stay as they are). */
export function setTimelessData(xml: string, attrs: Record<string, string | undefined>): string {
  const esc = (v: string) => v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
  const body = Object.entries(attrs)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  return putTimelessElement(xml, `<TimelessData${body}/>`);
}

export function putTimelessElement(xml: string, element: string): string {
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  if (TIMELESS_RE.test(xml)) return xml.replace(TIMELESS_RE, () => '\t' + element + eol);
  const end = xml.lastIndexOf('</PathOfBuilding>');
  if (end < 0) return xml;
  return xml.slice(0, end) + '\t' + element + eol + xml.slice(end);
}

/** The notes and Find Timeless Jewel choices of a build text, as one comparable string. */
export function annotationsOf(xml: string): string {
  return JSON.stringify([getNotes(xml), readTimelessData(xml)]);
}

/**
 * The engine's text of the build with the window's notes and Find Timeless Jewel choices: those are edited only in the
 * window's copy, so a text read back from the engine must not undo them. `engineBase` is `annotationsOf` the engine's
 * text the last time the window took it: when the engine's own annotations have changed since (a whole-build import,
 * or undoing one), the engine's text is taken as it is.
 */
export function withWindowAnnotations(engineXml: string, windowXml: string, engineBase?: string): string {
  if (engineBase !== undefined && annotationsOf(engineXml) !== engineBase) return engineXml;
  const notes = getNotes(windowXml);
  let xml = getNotes(engineXml) === notes ? engineXml : setNotes(engineXml, notes);
  const td = timelessElement(windowXml);
  if (td && timelessElement(xml) !== td) xml = putTimelessElement(xml, td);
  return xml;
}

export function classColourKey(className: string): string {
  const c = className.toLowerCase();
  return CLASSES.some((k) => k.name.toLowerCase() === c) ? c : 'scion';
}

/** The class a build belongs to, resolving an ascendancy-only record to its base class. */
export function baseClassOf(info: Pick<BuildInfo, 'className' | 'ascendClassName'>): string {
  if (CLASSES.some((c) => c.name === info.className)) return info.className;
  const byAsc = CLASSES.find((c) => c.ascendancies.includes(info.ascendClassName));
  return byAsc?.name ?? info.className;
}

/** A new, empty build for a class, in the layout upstream itself writes. */
export function blankBuildXml(className: string, level = 1): string {
  const cls = CLASSES.find((c) => c.name === className) ?? CLASSES[0]!;
  const lvl = Math.max(1, Math.min(100, Math.floor(level)));
  return `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding>
	<Build level="${lvl}" targetVersion="3_0" bandit="None" className="${cls.name}" ascendClassName="None" mainSocketGroup="1" viewMode="TREE" pantheonMajorGod="None" pantheonMinorGod="None">
	</Build>
	<Import />
	<Calcs />
	<Skills sortGemsByDPSField="CombinedDPS" activeSkillSet="1" sortGemsByDPS="true" defaultGemQuality="nil" defaultGemLevel="nil">
		<SkillSet id="1" />
	</Skills>
	<Tree activeSpec="1">
		<Spec treeVersion="${CURRENT_TREE_VERSION}" classId="${cls.classId}" ascendClassId="0" masteryEffects="" nodes="">
		</Spec>
	</Tree>
	<Notes>

	</Notes>
	<TreeView searchStr="" zoomY="0" showHeatMap="nil" zoomLevel="3" showStatDifferences="true" zoomX="0" />
	<Items activeItemSet="1" useSecondWeaponSet="nil">
		<ItemSet useSecondWeaponSet="nil" id="1" />
	</Items>
	<Config />
</PathOfBuilding>
`;
}

export type BuildXmlProblem = 'truncated' | 'malformed' | 'incomplete';

const TAG_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/**
 * Whether the text is a whole upstream build file: every element closed in order, a Build element in it.
 * 'truncated' means the text stops partway (a cut-off file or paste); 'malformed' means tags that do not pair up;
 * 'incomplete' means well-formed but missing the Build element every saved build has.
 */
export function checkBuildXml(xml: string): { ok: true } | { ok: false; problem: BuildXmlProblem } {
  const stack: string[] = [];
  let rootTag = '';
  let rootClosed = false;
  let sawBuild = false;
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(xml))) {
    last = TAG_RE.lastIndex;
    const tag = m[2];
    if (!tag) continue;
    if (rootClosed) return { ok: false, problem: 'malformed' };
    if (m[1] === '/') {
      if (stack.pop() !== tag) return { ok: false, problem: 'malformed' };
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    if (stack.length === 0) {
      if (rootTag) return { ok: false, problem: 'malformed' };
      rootTag = tag;
    } else if (stack.length === 1) {
      if (tag === 'Build') sawBuild = true;
    }
    if (m[4] !== '/') stack.push(tag);
    else if (stack.length === 0) rootClosed = true;
  }
  if (rootTag !== 'PathOfBuilding') return { ok: false, problem: 'malformed' };
  if (/<[A-Za-z_!?/]/.test(xml.slice(last))) return { ok: false, problem: 'truncated' };
  if (stack.length > 0) return { ok: false, problem: 'truncated' };
  if (!sawBuild) return { ok: false, problem: 'incomplete' };
  return { ok: true };
}

/** The sentence shown when `checkBuildXml` fails, for a build that was pasted, fetched or opened. */
export function damagedBuildMessage(problem: BuildXmlProblem, what = 'build'): string {
  switch (problem) {
    case 'truncated':
      return `This ${what} is damaged: it stops partway through, so part of it is missing.`;
    case 'malformed':
      return `This ${what} is damaged: its text is not a complete Path of Building file.`;
    case 'incomplete':
      return `This ${what} is incomplete: it has no build details to load.`;
  }
}
