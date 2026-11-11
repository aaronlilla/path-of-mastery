import { classifyImportText, SHARE_SITES, shareLinkFrom, type ShareSiteId } from '../../shared/buildSites.js';
import type { DecodedImport, ImportSource } from '../../shared/library.js';
import { BuildCodeError, decodeBuildCode, encodeBuildCode } from './buildCode.js';
import { fetchMobalyticsCode } from './mobalytics.js';
import { checkBuildXml, damagedBuildMessage, readBuildInfo } from '../../shared/buildXml.js';

export type FetchText = (url: string) => Promise<string>;

const MAX_BYTES = 8 * 1024 * 1024;

export const fetchTextFromNet: FetchText = async (url) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Path of Mastery', Accept: 'text/plain, */*' },
    });
    if (!res.ok) throw new Error(`The site answered ${res.status}.`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) throw new Error('That file is too large to be a build.');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('That file is too large to be a build.');
    return text;
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw new Error('The site took too long to answer.');
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
};

function finish(xml: string, source: ImportSource, nameHint = ''): DecodedImport {
  const info = readBuildInfo(xml);
  if (!info.valid) throw new BuildCodeError('That is not a Path of Building build.');
  const whole = checkBuildXml(xml);
  if (!whole.ok) throw new BuildCodeError(damagedBuildMessage(whole.problem));
  return { xml, source, name: nameHint, info };
}

/** Reads a build from a pasted code, a pasted XML build, or a link to a supported site. */
/** Reads a public character (account name, character name) into the XML of a new build; the character import of the Import tab does the work. */
export type ImportCharacter = (account: string, character: string) => Promise<string>;

export async function importFromText(text: string, fetchText: FetchText = fetchTextFromNet, importCharacter?: ImportCharacter): Promise<DecodedImport> {
  const c = classifyImportText(text);
  switch (c.kind) {
    case 'empty':
      throw new BuildCodeError('Paste a build code or a link first.');
    case 'xml':
      return finish(text.replace(/^[\s\ufeff]+/, ''), 'code');
    case 'code':
      return finish(decodeBuildCode(text), 'code');
    case 'link': {
      let lastErr = 'The site did not answer.';
      if (c.match.site.source === 'mobalytics') {
        try {
          const code = await fetchMobalyticsCode(c.match.id);
          // The author may have attached a pobb.in link instead of a code.
          return /^https?:\/\//i.test(code) ? await importFromText(code, fetchText) : finish(decodeBuildCode(code), 'mobalytics');
        } catch (e) {
          throw new BuildCodeError(`Could not get that build from Mobalytics. ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      for (const url of c.match.urls) {
        try {
          const body = (await fetchText(url)).trim();
          const xml = body.startsWith('<') ? body : decodeBuildCode(body);
          return finish(xml, c.match.site.source);
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
        }
      }
      throw new BuildCodeError(`Could not get that build from ${c.match.site.label}. ${lastErr}`);
    }
    case 'character-link': {
      if (!importCharacter) throw new BuildCodeError('Character links are not available here. Paste the build code instead.');
      try {
        return finish(await importCharacter(c.account, c.character), 'poe.ninja');
      } catch (e) {
        throw new BuildCodeError(`Could not read that character from poe.ninja. ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    case 'unsupported-link':
      throw new BuildCodeError(`Links from ${c.host} are not supported yet. Paste the build code instead.`);
    case 'unknown':
      throw new BuildCodeError('That does not look like a build code or a link.');
  }
}

/** Uploads a build code to pobb.in and returns the share link. */
export async function shareToBin(xml: string, post: (url: string, body: string) => Promise<string> = postText): Promise<string> {
  const reply = (await post('https://pobb.in/pob/', encodeBuildCode(xml))).trim();
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(reply)) throw new Error('pobb.in did not return a link.');
  return `https://pobb.in/${reply}`;
}

/** Uploads a build code to one of upstream's sharing sites and returns the link. */
export async function shareToSite(siteId: ShareSiteId, xml: string, post: (url: string, body: string) => Promise<string> = postText): Promise<string> {
  const site = SHARE_SITES.find((s) => s.id === siteId);
  if (!site) throw new Error('That site is not one the app can share to.');
  if (site.id === 'pobb.in') return shareToBin(xml, post);
  const answer = await post(site.postUrl, site.postFields + encodeBuildCode(xml));
  const link = shareLinkFrom(site, answer);
  if (!link) throw new Error(`${site.label} did not return a link.`);
  return link;
}

async function postText(url: string, body: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, { method: 'POST', body, signal: ctl.signal, headers: { 'User-Agent': 'Path of Mastery', 'Content-Type': 'application/x-www-form-urlencoded' } });
    const text = await res.text();
    if (!res.ok) throw new Error(/Just a moment/i.test(text) ? `The site answered ${res.status} with a bot check, so the app cannot upload there.` : `The site answered ${res.status}.`);
    return text;
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw new Error('The site took too long to answer.');
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}
