// The source credit of a Build copied from a Marketplace post (copies retain "Copied from {post} by {creator}").
// It lives in the build itself, as the first line of its notes, so it survives saving, restarts, sync and export, and changes no stat.

const escapeXml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const unescapeXml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const CREDIT = /^Copied from .+ by .+$/;

/** `credit` ("Copied from {post} by {creator}") as the first line of the build's notes; the rest of the notes stays below it. */
export function withCopyCredit(xml: string, credit: string): string {
  const line = escapeXml(credit.replace(/[\r\n]+/g, ' ').trim());
  // Function replacers only: a string replacement would read $', $&, $1 ... in a post title as patterns.
  if (/<Notes\b[^>]*\/>/.test(xml)) return xml.replace(/<Notes\b[^>]*\/>/, () => `<Notes>${line}</Notes>`);
  const open = /<Notes\b[^>]*>([\s\S]*?)<\/Notes>/.exec(xml);
  if (open) {
    const rest = open[1]!.replace(/^\s+/, '');
    return xml.slice(0, open.index) + `<Notes>${line}${rest ? `\n${rest}` : ''}</Notes>` + xml.slice(open.index + open[0].length);
  }
  return xml.replace(/<\/PathOfBuilding>\s*$/, () => `<Notes>${line}</Notes>\n</PathOfBuilding>`);
}

/** The copy credit of a build, or null when its notes do not start with one. */
export function copyCredit(xml: string): string | null {
  const notes = /<Notes\b[^>]*>([\s\S]*?)<\/Notes>/.exec(xml)?.[1];
  if (!notes) return null;
  const first = unescapeXml(notes.replace(/^<!\[CDATA\[/, '')).split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
  return CREDIT.test(first) ? first : null;
}
