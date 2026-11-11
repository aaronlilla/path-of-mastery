// Private parts of an upstream build XML, found by an XML parser (sax, strict), never by matching strings: a <Notes> element in
// any spelling (case, whitespace, attributes, CDATA, character references, self-closing, several, nested, namespace prefix) and the
// <Import> element that holds account and character data. Kept out of the package index: only main processes and the site load it.
import sax from 'sax';

export type BuildXmlPart = 'notes' | 'account';
type Kind = BuildXmlPart;
type Span = { kind: Kind; start: number; end: number };
export type BuildXmlInspection = { ok: true; root: string; parts: BuildXmlPart[]; spans: Span[] } | { ok: false; reason: string };

const kindOf = (local: string): Kind | null => {
  const name = local.toLowerCase();
  return name === 'notes' || name === 'noteshtml' ? 'notes' : name === 'import' ? 'account' : null;
};

/** Parses the whole document. `parts` lists the private parts that hold anything; `spans` are the outermost private elements. */
export function inspectBuildXml(xml: string): BuildXmlInspection {
  const parser = sax.parser(true, { xmlns: true, position: true });
  let root: string | null = null, failure: string | null = null;
  const stack: { kind: Kind | null; start: number }[] = [];
  const spans: Span[] = [], found = new Set<Kind>();
  const inside = (): Kind | null => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.kind) return stack[i]!.kind; return null; };
  const content = (text: string) => { const k = inside(); if (k && text.trim()) found.add(k); };
  parser.onerror = (e: Error) => { failure = failure ?? e.message.split('\n')[0]!; parser.error = null; };
  parser.onopentag = (node: { local?: string; name: string; attributes: Record<string, unknown> }) => {
    const local = node.local || node.name.split(':').pop()!;
    if (root === null) root = local;
    const outer = inside(), kind = kindOf(local);
    if (outer) found.add(outer); // an element inside Notes or Import is content of it
    if (kind === 'account' && Object.keys(node.attributes).some(a => !/^xmlns(:|$)/.test(a))) found.add('account');
    stack.push({ kind, start: parser.startTagPosition - 1 });
  };
  parser.onclosetag = () => {
    const open = stack.pop();
    if (open?.kind && !inside()) spans.push({ kind: open.kind, start: open.start, end: parser.position });
  };
  parser.ontext = content;
  parser.oncdata = content;
  parser.oncomment = content;
  parser.onprocessinginstruction = (pi: { body: string }) => content(pi.body);
  try { parser.write(xml).close(); } catch (e) { failure = failure ?? (e instanceof Error ? e.message : String(e)); }
  if (failure || root === null || stack.length) return { ok: false, reason: failure ?? 'The XML is not complete.' };
  return { ok: true, root, parts: (['notes', 'account'] as const).filter(k => found.has(k)), spans };
}

/** The private parts a build XML still carries; `unreadable` when it is not well-formed XML (then nothing in it is trusted). */
export function privateBuildParts(xml: string): (BuildXmlPart | 'unreadable')[] {
  const r = inspectBuildXml(xml);
  return r.ok ? r.parts : ['unreadable'];
}

/**
 * The build XML for a public build code: every Notes element becomes an empty <Notes></Notes> and every Import element an empty
 * <Import/>. Everything else stays byte for byte; neither changes a calculation. Throws when the XML does not parse.
 */
export function publicBuildXml(xml: string): string {
  const r = inspectBuildXml(xml);
  if (!r.ok) throw new Error(`This build file is not valid XML: ${r.reason}`);
  let out = '', at = 0;
  for (const span of [...r.spans].sort((a, b) => a.start - b.start)) {
    out += xml.slice(at, span.start) + (span.kind === 'notes' ? '<Notes></Notes>' : '<Import/>');
    at = span.end;
  }
  return out + xml.slice(at);
}
