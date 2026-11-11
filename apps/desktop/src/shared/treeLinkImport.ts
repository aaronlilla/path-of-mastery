/**
 * Import Tree: a pasted link and a name become one new tree set (TreeTab.lua `OpenImportPopup`). The official site's links
 * and old poeskilltree links are read here; a PoEURL short link is first resolved by main; a link to a build on pobb.in,
 * poe.ninja and the like brings that build's open tree.
 */
import { classifyTreeLink, decodeTreeLink, importedSpecXml, setSpecAttr, splitSpecs, versionFromLink } from './treeSets.js';

export interface LinkDeps {
  /** The tree versions the app has data for. */
  known: string[];
  /** A poeurl.com short link to the long link behind it. */
  resolve(link: string): Promise<string>;
  /** The text of a build behind a build-site link. */
  fetchBuild(link: string): Promise<string>;
}

export type LinkResult = { ok: true; spec: string; version: string } | { ok: false; error: string };

const fail = (error: string): LinkResult => ({ ok: false, error });

function fromGgg(link: string, name: string, known: string[]): LinkResult {
  // An old-style link carries its version in the query: poeskilltree.com/?v=3.6.0#CODE becomes poeskilltree.com/CODE.
  const old = /poeskilltree\.com\/\?v=(\d+)\.(\d+)\.\d+(?:-(\w+))?(?:-(\w+))?#/.exec(link);
  const text = link.replace(/\/\?v=.+#/, '/');
  const d = decodeTreeLink(text);
  if (!d.ok) return fail(d.error);
  const version = old ? versionFromLink(`tree/${old[1]}.${old[2]}.0/`, known) : versionFromLink(text, known);
  return { ok: true, spec: importedSpecXml(name, version, d), version };
}

export async function specFromLink(rawLink: string, name: string, deps: LinkDeps): Promise<LinkResult> {
  const link = rawLink.trim();
  if (!link) return fail('Enter a passive tree link.');
  switch (classifyTreeLink(link)) {
    case 'poeurl': {
      let long: string;
      try {
        long = await deps.resolve(link);
      } catch (e) {
        return fail(e instanceof Error ? e.message : 'Failed to resolve PoEURL link');
      }
      return fromGgg(long, name, deps.known);
    }
    case 'poeplanner':
      return fail('poeplanner links are not supported yet. Open the tree on pathofexile.com and paste that link.');
    case 'build-site': {
      let xml: string;
      try {
        xml = await deps.fetchBuild(link);
      } catch (e) {
        return fail(e instanceof Error ? e.message : 'Could not get that build.');
      }
      const p = splitSpecs(xml);
      const chunk = p?.specs[p.active - 1] ?? p?.specs[0];
      if (!p || chunk === undefined) return fail('That build has no passive tree.');
      // The build's own jewels are not in this build: the sockets come over empty.
      const bare = chunk.replace(/<Sockets\b[\s\S]*?<\/Sockets>|<Sockets\b[^>]*\/>/, '<Sockets>\n\t\t\t</Sockets>');
      const version = /treeVersion="([^"]+)"/.exec(chunk)?.[1] ?? '3_29';
      if (!deps.known.includes(version)) return fail('The build you are trying to load uses an unrecognised version of the passive skill tree.');
      return { ok: true, spec: setSpecAttr(bare, 'title', name), version };
    }
    default:
      return fromGgg(link, name, deps.known);
  }
}
