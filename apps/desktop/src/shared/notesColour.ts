/**
 * Colour codes in build notes. Upstream writes them into the notes text: ^x followed by six hex digits,
 * or ^ and a digit. The editor shows them as coloured text; these helpers go between the two.
 */

export interface Segment {
  text: string;
  /** The code in force for this text, like "^xFFFF77" or "^3". null means the default colour (^7). */
  code: string | null;
}

/** Colour names the Notes tab offers, with upstream's own code for each. */
export const NAMED_COLOURS: { label: string; code: string; token: string }[] = [
  { label: 'NORMAL', code: '^xC8C8C8', token: '--rarity-normal' },
  { label: 'MAGIC', code: '^x8888FF', token: '--rarity-magic' },
  { label: 'RARE', code: '^xFFFF77', token: '--rarity-rare' },
  { label: 'UNIQUE', code: '^xAF6025', token: '--rarity-unique' },
  { label: 'FIRE', code: '^xB97123', token: '--dmg-fire' },
  { label: 'COLD', code: '^x3F6DB3', token: '--dmg-cold' },
  { label: 'LIGHTNING', code: '^xADAA47', token: '--dmg-lightning' },
  { label: 'CHAOS', code: '^xD02090', token: '--dmg-chaos' },
  { label: 'STRENGTH', code: '^xE05030', token: '--attr-str' },
  { label: 'DEXTERITY', code: '^x70FF70', token: '--attr-dex' },
  { label: 'INTELLIGENCE', code: '^x7070FF', token: '--attr-int' },
  { label: 'DEFAULT', code: '^7', token: '--text' },
];

/** ^0 to ^9 follow the legacy palette, mapped onto theme tokens so they stay legible in every theme. */
const DIGIT_TOKENS = ['--text-faint', '--negative-text', '--positive', '--rarity-magic', '--rarity-rare', '--dmg-chaos', '--pool-es', '--text', '--text-muted', '--text-faint'];

const CODE_RE = /\^(x[0-9a-fA-F]{6}|[0-9])/g;

function norm(code: string): string {
  return code.length === 8 ? '^x' + code.slice(2).toUpperCase() : code;
}

/** The CSS colour for a code, or null for the default colour. */
export function codeColour(code: string | null): string | null {
  if (!code || code === '^7') return null;
  const c = norm(code);
  const named = NAMED_COLOURS.find((n) => n.code === c);
  if (named) return named.token === '--text' ? null : `var(${named.token})`;
  if (c[1] === 'x') return '#' + c.slice(2);
  return `var(${DIGIT_TOKENS[Number(c[1])]})`;
}

export function parseNotes(text: string): Segment[] {
  const out: Segment[] = [];
  let code: string | null = null;
  let last = 0;
  CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const push = (t: string) => {
    if (t) out.push({ text: t, code });
  };
  while ((m = CODE_RE.exec(text))) {
    push(text.slice(last, m.index));
    code = m[1] === '7' ? null : norm('^' + m[1]!);
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

/** `closeLast` ends a colour that runs to the end of the text with ^7, as upstream's own colour buttons do; off, text read from a file round-trips as it was. */
export function serializeNotes(segments: Segment[], closeLast = false): string {
  let cur: string | null = null;
  let out = '';
  for (const s of segments) {
    if (!s.text.replace(/[​\n]/g, '')) {
      out += s.text.replace(/​/g, '');
      continue;
    }
    const c = s.code && s.code !== '^7' ? norm(s.code) : null;
    if (c !== cur) {
      out += c ?? '^7';
      cur = c;
    }
    out += s.text.replace(/​/g, '');
  }
  if (closeLast && cur) out += '^7';
  return out;
}

/** A literal caret in the text would read as a code; upstream has no escape for it, so leave it be. */
export function hasCodes(text: string): boolean {
  return /\^(x[0-9a-fA-F]{6}|[0-9])/.test(text);
}
