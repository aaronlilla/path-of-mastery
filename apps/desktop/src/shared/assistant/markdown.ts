/**
 * The small slice of Markdown the assistant's replies use, parsed into plain data (never HTML): paragraphs, headings,
 * bullet and numbered lists, fenced code, pipe tables, and inline bold, italic, code and links. Links keep only
 * http and https targets. The renderer turns this into elements; this file has no UI so it can be tested.
 */

export type Inline = { t: 'text'; text: string } | { t: 'b'; text: string } | { t: 'i'; text: string } | { t: 'code'; text: string } | { t: 'link'; text: string; href: string };

export type MdBlock =
  | { k: 'p'; lines: string[] }
  | { k: 'h'; level: 1 | 2 | 3; text: string }
  | { k: 'ul'; items: string[] }
  | { k: 'ol'; items: string[] }
  | { k: 'code'; lang: string; text: string; open: boolean }
  | { k: 'table'; head: string[]; rows: string[][] };

const splitRow = (l: string): string[] => {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
};
const isSep = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ k: 'p', lines: [...para] });
    para.length = 0;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(l);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (/^\s*```\s*$/.test(lines[i]!)) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      out.push({ k: 'code', lang: fence[1] ?? '', text: body.join('\n'), open: !closed });
      continue;
    }
    if (!l.trim()) {
      flush();
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      flush();
      out.push({ k: 'h', level: Math.min(3, h[1]!.length) as 1 | 2 | 3, text: h[2]! });
      i++;
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && isSep(lines[i + 1]!)) {
      flush();
      const head = splitRow(l);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      out.push({ k: 'table', head, rows });
      continue;
    }
    if (/^\s*[-*•]\s+/.test(l)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*•]\s+/, ''));
      out.push({ k: 'ul', items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(l)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ''));
      out.push({ k: 'ol', items });
      continue;
    }
    para.push(l);
    i++;
  }
  flush();
  return out;
}

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g;

/** True for the only link targets the panel will open. */
export function safeHref(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href);
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push({ t: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'b', text: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'code', text: m[2] });
    else if (m[3] !== undefined) out.push(safeHref(m[4]!) ? { t: 'link', text: m[3], href: m[4]! } : { t: 'text', text: m[3] });
    else out.push({ t: 'i', text: m[5]! });
    last = INLINE.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', text: text.slice(last) });
  return out;
}
