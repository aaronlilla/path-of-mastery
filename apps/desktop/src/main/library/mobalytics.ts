import { BuildCodeError } from './buildCode.js';

/**
 * Mobalytics PoE 1 build pages hold the author's build code in their public GraphQL API (the same call the page makes),
 * as `pobCode`: a raw code or, sometimes, a pobb.in link. Endpoint and field as read from the page.
 */
const QUERY =
  'query PobReduxDocumentBySlug($input: PoeUserGeneratedDocumentInputBySlug!) { poe { documents { userGeneratedDocumentBySlug(input: $input) { error errorMessage data { id data { pobCode } } } } } }';

export type PostJson = (url: string, body: string, referer: string) => Promise<string>;

export const postJsonToNet: PostJson = async (url, body, referer) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      signal: ctl.signal,
      headers: { 'User-Agent': 'Path of Mastery', 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://mobalytics.gg', Referer: referer },
    });
    if (!res.ok) throw new Error(`The site answered ${res.status}.`);
    return await res.text();
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw new Error('The site took too long to answer.');
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
};

/** The build code (or link) in a Mobalytics API answer. */
export function buildCodeFromMobalytics(answer: string): string {
  let j: any;
  try {
    j = JSON.parse(answer);
  } catch {
    throw new BuildCodeError('Mobalytics answered with something other than JSON.');
  }
  const err = j?.errors?.[0]?.message;
  if (err) throw new BuildCodeError(`Mobalytics: ${err}`);
  const doc = j?.data?.poe?.documents?.userGeneratedDocumentBySlug;
  if (doc?.error) throw new BuildCodeError(/^NOT_FOUND/.test(doc.error) ? 'Mobalytics has no build at that link.' : `Mobalytics: ${doc.errorMessage || doc.error}`);
  const code = doc?.data?.data?.pobCode;
  if (typeof code !== 'string' || !code.trim()) throw new BuildCodeError('That Mobalytics build has no Path of Building code.');
  return code.trim();
}

export async function fetchMobalyticsCode(slug: string, post: PostJson = postJsonToNet): Promise<string> {
  const body = JSON.stringify({ operationName: 'PobReduxDocumentBySlug', variables: { input: { slug, type: 'builds' } }, query: QUERY });
  return buildCodeFromMobalytics(await post('https://mobalytics.gg/api/poe/v1/graphql/query', body, `https://mobalytics.gg/poe/builds/${slug}`));
}
