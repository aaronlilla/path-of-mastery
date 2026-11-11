// PoEURL short links for passive tree links. Run by main (the page cannot read another site's answer).
export type Fetch = typeof fetch;

/** A poeurl.com short link answers with a redirect to the long tree link; that address is what upstream reads (TreeTab.lua). */
export async function resolvePoeUrl(link: string, doFetch: Fetch = fetch): Promise<string> {
  if (!/^https?:\/\/(?:www\.)?poeurl\.com\//i.test(link.trim())) throw new Error('Failed to resolve PoEURL link');
  const res = await doFetch(link.trim(), { redirect: 'manual', headers: { 'User-Agent': 'Path of Mastery' }, signal: AbortSignal.timeout(15_000) });
  const to = res.headers.get('location');
  if (!to || /poeurl\.com\//i.test(to)) throw new Error('Failed to resolve PoEURL link');
  return to;
}

/** The short link poeurl.com gives for a long one: the answer of its shrink page is the id (TreeTab.lua `OpenExportPopup`). */
export async function shrinkWithPoeUrl(link: string, doFetch: Fetch = fetch): Promise<string> {
  const res = await doFetch(`http://poeurl.com/shrink.php?url=${encodeURIComponent(link)}`, { headers: { 'User-Agent': 'Path of Mastery' }, signal: AbortSignal.timeout(15_000) });
  const body = (await res.text()).trim();
  if (!res.ok || !/^[A-Za-z0-9_-]{1,32}$/.test(body)) throw new Error('Failed to get PoEURL link. Try again later.');
  return `http://poeurl.com/${body}`;
}

