import type { KbDb } from '../db.js';
import type { EntityRow, KbSource, Pulled, SourceCtx } from './types.js';

/**
 * GGG's patch-notes forum (official). The list is the earliest reliable "new patch" signal (thread ids only grow); each
 * thread's first staff post is the patch text. We keep the current league and the one before it, chunked by section so
 * search finds the paragraph, not the whole post.
 */

export const FORUM_BASE = 'https://www.pathofexile.com';
export const PATCH_LIST_URL = `${FORUM_BASE}/forum/view-forum/patch-notes`;
const MAX_PAGES = 12;
/** Threads older than this are reused from the previous KB instead of being fetched again. */
const REFETCH_DAYS = 14;

export interface ThreadRow {
  id: number;
  title: string;
  postedRaw: string;
  postedAt: string | null;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** "Sep 7, 2026, 7:07:13 PM" to an ISO date, yyyy-mm-dd (the forum does not print a zone; the date is what matters). */
export function forumDate(raw: string): string | null {
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(raw);
  if (!m) return null;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1]!);
  if (mon < 0) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

export function parseThreadList(html: string): ThreadRow[] {
  const out: ThreadRow[] = [];
  const re = /<div class="title">\s*<a href="\/forum\/view-thread\/(\d+)">([^<]+)<\/a>[\s\S]{0,1500}?post_date">,?\s*([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const title = decodeEntities(m[2]!.trim());
    if (/^code of conduct$/i.test(title)) continue;
    out.push({ id: Number(m[1]), title, postedRaw: m[3]!.trim(), postedAt: forumDate(m[3]!) });
  }
  return out;
}

/** "3.29.3b Patch Notes" -> 3.29.3b; "Content Update 3.29.0 — ..." -> 3.29.0; "Server Maintenance" -> null. */
export function versionOf(title: string): string | null {
  return /(\d+\.\d+\.\d+[a-z]?)/.exec(title)?.[1] ?? null;
}

export function threadKind(title: string): 'league' | 'patch_note' | 'hotfix' | 'maintenance' {
  if (/content update/i.test(title)) return 'league';
  if (/hotfix|restart fix/i.test(title)) return 'hotfix';
  if (/maintenance/i.test(title)) return 'maintenance';
  return 'patch_note';
}

/** The first staff post's HTML. */
export function staffPostHtml(html: string): string | null {
  // patch threads mark the first post `staff`; content-update announcements are news posts
  let t = html.indexOf('<tr class="staff">');
  if (t < 0) t = html.indexOf('<tr class="newsPost">');
  if (t < 0) return null;
  const c = html.indexOf('<div class="content">', t);
  if (c < 0) return null;
  const end = html.indexOf('</td>', c);
  let post = html.slice(c + '<div class="content">'.length, end < 0 ? undefined : end);
  // the poster's signature and the "Last bumped" line follow the post inside the same cell
  for (const tail of ['<div class="signature"', '<div class="last_bumped"', '<div class="last_edited']) {
    const i = post.indexOf(tail);
    if (i >= 0) post = post.slice(0, i);
  }
  return post;
}

/** Post HTML to readable text: headings as "## ", list items as "- " (indented by depth), paragraphs kept. */
export function postText(html: string): string {
  let depth = 0;
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // a table of contents is in-page anchor links only
    .replace(/<li>\s*<a href="#[^"]*">[\s\S]*?<\/a>\s*<\/li>/gi, '')
    .replace(/<h[1-6][^>]*>\s*Table of Contents\s*<\/h[1-6]>/gi, '')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? ` [image: ${alt}] ` : ' '))
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n## $1\n')
    .replace(/<strong>([\s\S]*?)<\/strong>\s*<br\s*\/?>/gi, '\n## $1\n');
  s = s.replace(/<(\/?)(ul|ol|li)\b[^>]*>/gi, (_m, close: string, tag: string) => {
    const t = tag.toLowerCase();
    if (t === 'li') return close ? '' : `\n${'  '.repeat(Math.max(0, depth - 1))}- `;
    depth += close ? -1 : 1;
    return '\n';
  });
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => {
      // keep list nesting (leading spaces before "- "), collapse every other run of blanks
      const body = l.trimStart().replace(/[ \t]+/g, ' ').trimEnd();
      const indent = body.startsWith('- ') ? (/^ */.exec(l)?.[0] ?? '') : '';
      return indent + body;
    })
    .filter((l) => !/^\s*Return to top\s*$/i.test(l))
    .filter((l, i, a) => l.trim() !== '' || (i > 0 && a[i - 1]!.trim() !== ''))
    .join('\n')
    .replace(/^## (.+)\n## /gm, '## $1 — ')
    .trim();
}

/** Split text into sections at "## " headings, then cap each at ~1800 chars on line boundaries. */
export function chunkText(text: string, max = 1800): Array<{ heading: string; body: string }> {
  const out: Array<{ heading: string; body: string }> = [];
  let heading = '';
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) out.push({ heading, body });
    buf = [];
  };
  for (const line of text.split('\n')) {
    const h = /^## (.+)$/.exec(line);
    if (h) {
      flush();
      heading = h[1]!.trim();
      continue;
    }
    if (buf.join('\n').length + line.length > max && /^\S/.test(line.replace(/^- /, 'x'))) flush();
    buf.push(line);
  }
  flush();
  return out;
}

const leagueOf = (v: string | null): string | null => (v ? v.split('.').slice(0, 2).join('.') : null);

function previousThreadRows(prev: KbDb | undefined, threadId: number): EntityRow[] | null {
  if (!prev) return null;
  try {
    const rows = prev.all<Record<string, unknown>>(`SELECT * FROM doc WHERE source = 'forum' AND id LIKE ?`, [`forum:${threadId}#%`]);
    if (!rows.length) return null;
    return rows.map((r) => ({ ...r, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }));
  } catch {
    return null;
  }
}

export async function listPatchThreads(ctx: Pick<SourceCtx, 'http' | 'log'>, livePatch: string, maxPages = MAX_PAGES): Promise<ThreadRow[]> {
  const cur = leagueOf(livePatch) ?? '3.29';
  const [maj, min] = cur.split('.').map(Number) as [number, number];
  const stopAt = `${maj}.${min - 1}.0`; // the previous league's content update
  const all: ThreadRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? PATCH_LIST_URL : `${PATCH_LIST_URL}/page/${page}`;
    const { body } = await ctx.http.text(url, { maxAgeMs: page === 1 ? 0 : 6 * 3600_000 });
    const rows = parseThreadList(body);
    if (!rows.length) break;
    all.push(...rows);
    if (rows.some((r) => threadKind(r.title) === 'league' && versionOf(r.title) === stopAt)) break;
    const oldest = rows.map((r) => leagueOf(versionOf(r.title))).filter((v): v is string => !!v).pop();
    if (oldest && Number(oldest.split('.')[1]) < min - 1) break;
  }
  // keep current and previous league threads (and unversioned ones between them)
  const keep: ThreadRow[] = [];
  for (const r of all) {
    const v = leagueOf(versionOf(r.title));
    if (v && Number(v.split('.')[0]) === maj && Number(v.split('.')[1]) < min - 1) break;
    keep.push(r);
  }
  return keep;
}

export const forumSource: KbSource = {
  id: 'forum',
  type: 'official',
  async pull(ctx): Promise<Pulled> {
    const threads = await listPatchThreads(ctx, ctx.livePatch);
    ctx.log(`forum: ${threads.length} threads (current and previous league)`);
    const docs: EntityRow[] = [];
    const cutoff = Date.now() - REFETCH_DAYS * 86400_000;
    let fetched = 0;
    let reused = 0;
    // a running version for unversioned posts ("Server Maintenance"): the next older versioned thread's version
    const versions = threads.map((t) => versionOf(t.title));
    for (let i = 0; i < threads.length; i++) {
      const t = threads[i]!;
      const url = `${FORUM_BASE}/forum/view-thread/${t.id}`;
      const old = t.postedAt && Date.parse(t.postedAt) < cutoff ? previousThreadRows(ctx.previous, t.id) : null;
      if (old) {
        docs.push(...old);
        reused++;
        continue;
      }
      let html: string;
      try {
        html = (await ctx.http.text(url)).body;
      } catch (e) {
        ctx.log(`forum: ${url} failed: ${(e as Error).message}`);
        const prev = previousThreadRows(ctx.previous, t.id);
        if (prev) docs.push(...prev);
        continue;
      }
      fetched++;
      const post = staffPostHtml(html);
      if (!post) continue;
      const text = postText(post);
      const version = versions[i] ?? versions.slice(i + 1).find((v) => v) ?? null;
      const kind = threadKind(t.title);
      const chunks = chunkText(text);
      chunks.forEach((c, n) => {
        docs.push({
          id: `forum:${t.id}#${n}`,
          doc_kind: kind,
          title: c.heading ? `${t.title} — ${c.heading}` : t.title,
          version,
          posted_at: t.postedAt,
          body: c.body,
          source_url: url,
          patch: version ?? undefined,
          data: { thread: t.id, threadTitle: t.title, chunk: n, chunks: chunks.length, heading: c.heading, postedRaw: t.postedRaw },
        });
      });
    }
    ctx.log(`forum: fetched ${fetched}, reused ${reused}, ${docs.length} chunks`);
    return {
      url: PATCH_LIST_URL,
      patch: versionOf(threads[0]?.title ?? '') ?? ctx.livePatch,
      fetchedAt: new Date().toISOString(),
      entities: { doc: docs },
      tables: { 'patch-threads': { data: threads, url: PATCH_LIST_URL } },
    };
  },
};
