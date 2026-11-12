/**
 * GitHub release notes are Markdown with badges, links and HTML. The Update screen shows plain sentences, so this
 * drops the badge and image lines, turns links into their text, and removes the Markdown marks.
 */
export function plainNotes(md: string, maxLines = 24): string {
  const out: string[] = [];
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    let l = raw;
    l = l.replace(/<!--[\s\S]*?-->/g, '');
    l = l.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ''); // badge inside a link
    l = l.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // image
    l = l.replace(/<[^>]+>/g, '');
    l = l.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    l = l.replace(/https?:\/\/\S+/g, '');
    l = l.replace(/^\s{0,3}#{1,6}\s*/, '');
    l = l.replace(/^\s*[-*+]\s+/, '• ');
    l = l.replace(/^\s*>\s?/, '');
    l = l.replace(/(\*\*|__|`)/g, '');
    l = l.replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2');
    l = l.replace(/^[-=*_]{3,}\s*$/, '');
    l = l.replace(/(\S)\s{2,}/g, '$1 ').replace(/\s+$/g, '');
    if (!l.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(l.trimStart() === l ? l : l.trim());
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.slice(0, maxLines).join('\n');
}

/** "Checked just now." or "Checked 5 min ago." */
export function checkedText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'Checked just now.';
  const m = Math.round(s / 60);
  if (m < 60) return `Checked ${m} min ago.`;
  const h = Math.round(m / 60);
  if (h < 48) return `Checked ${h} h ago.`;
  return `Checked ${Math.round(h / 24)} days ago.`;
}
