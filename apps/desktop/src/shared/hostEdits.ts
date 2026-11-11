// The build edits the tabs make by rewriting the build text (item sets, weapon swap, flask switches, jewel sockets, tree
// sets, level, notes, loadouts), as typed edits. The engine host turns each into one `setXml`, so the assistant and any
// other caller can make them without writing build text.
import type { HostBuildEdit } from '@pom/protocol';
import { addItem, deleteItems, deleteItemSet, newItemSet, renameItemSet, setActiveSet, setFlaskActive, setItemText, setJewel, setSecondWeaponSet } from './itemsXml.js';
import { readSpectres, setSpectres } from './calcsLogic.js';
import { loadoutRows, openLoadoutNamed } from './loadouts.js';
import { setNotes } from './buildXml.js';
import { addSpec, copySpec, decodeTreeLink, deleteSpec, emptySpecXml, importedSpecXml, joinSpecs, LATEST_TREE_VERSION, moveSpec, readSpecSummaries, renameSpec, splitSpecs, versionFromLink } from './treeSets.js';

const HOST_KINDS = new Set<string>(['itemSet', 'setWeaponSwap', 'setFlaskActive', 'setJewel', 'deleteItems', 'setItemText', 'treeSet', 'setLevel', 'setNotes', 'openLoadout', 'setSpectres']);

export function isHostEdit(edit: { kind: string }): edit is HostBuildEdit {
  return HOST_KINDS.has(edit.kind);
}

function setBuildAttr(xml: string, name: string, value: string): string {
  return xml.replace(/<Build\b([^>]*)>/, (_m, attrs: string) => {
    const re = new RegExp(`(\\s${name}=)(["'])[^"']*\\2`);
    return re.test(attrs) ? `<Build${attrs.replace(re, `$1"${value}"`)}>` : `<Build${attrs} ${name}="${value}">`;
  });
}

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`${what} is missing`);
  return v;
};

/** The build text after the edit. Throws a plain message when the edit names something the build does not have. */
export function applyHostEdit(xml: string, e: HostBuildEdit, knownTreeVersions: string[] = [LATEST_TREE_VERSION]): string {
  switch (e.kind) {
    case 'itemSet':
      switch (e.op) {
        case 'activate':
          return setActiveSet(xml, need(e.id, 'id'));
        case 'new':
          return newItemSet(xml, e.title ?? '').xml;
        case 'copy':
          return newItemSet(xml, e.title ?? '', need(e.id, 'id')).xml;
        case 'delete':
          return deleteItemSet(xml, need(e.id, 'id'));
        case 'rename':
          return renameItemSet(xml, need(e.id, 'id'), e.title ?? '');
      }
      break;
    case 'setWeaponSwap':
      return setSecondWeaponSet(xml, e.on);
    case 'setFlaskActive':
      if (!/^Flask [1-5]$/.test(e.slot)) throw new Error(`${e.slot} is not a flask slot`);
      return setFlaskActive(xml, e.slot, e.active);
    case 'setJewel': {
      if (typeof e.itemText === 'string') {
        const added = addItem(xml, e.itemText);
        return setJewel(added.xml, e.nodeId, added.id);
      }
      return setJewel(xml, e.nodeId, need(e.itemId, 'itemId or itemText'));
    }
    case 'deleteItems':
      return deleteItems(xml, e.itemIds);
    case 'setItemText':
      return setItemText(xml, e.itemId, e.itemText);
    case 'treeSet': {
      const { active, specs } = readSpecSummaries(xml);
      const idx = () => {
        const i = need(e.index, 'index');
        if (!specs[i - 1]) throw new Error(`there is no tree set ${i}`);
        return i;
      };
      switch (e.op) {
        case 'activate': {
          const p = splitSpecs(xml);
          return p ? joinSpecs(p, p.specs, idx()) : xml;
        }
        case 'new': {
          const base = specs[active - 1] ?? specs[0];
          return addSpec(xml, emptySpecXml(e.title ?? '', { classId: base?.classId ?? 0, ascendClassId: base?.ascendClassId ?? 0, secondaryAscendClassId: base?.secondaryAscendClassId ?? 0 }), true);
        }
        case 'copy':
          return copySpec(xml, idx(), e.title ?? '');
        case 'delete':
          return deleteSpec(xml, idx());
        case 'rename':
          return renameSpec(xml, idx(), e.title ?? '');
        case 'move':
          return moveSpec(xml, idx(), need(e.to, 'to'));
        case 'importLink': {
          const link = need(e.link, 'link');
          const d = decodeTreeLink(link);
          if (!d.ok) throw new Error(d.error);
          return addSpec(xml, importedSpecXml(e.title ?? '', versionFromLink(link, knownTreeVersions), d), true);
        }
      }
      break;
    }
    case 'setLevel': {
      let out = xml;
      if (e.auto !== undefined) out = setBuildAttr(out, 'characterLevelAutoMode', e.auto ? 'true' : 'false');
      if (e.level !== undefined) {
        out = setBuildAttr(out, 'characterLevelAutoMode', 'false');
        out = setBuildAttr(out, 'level', String(Math.max(1, Math.min(100, Math.floor(e.level)))));
      }
      return out;
    }
    case 'setNotes':
      return setNotes(xml, e.text);
    case 'openLoadout': {
      if (!loadoutRows(xml).some((r) => r.name === e.name)) throw new Error(`there is no loadout named "${e.name}"`);
      return openLoadoutNamed(xml, e.name);
    }
    case 'setSpectres': {
      const drop = new Set(e.remove ?? []);
      const ids = (e.ids ?? readSpectres(xml)).filter((id) => !drop.has(id));
      for (const id of e.add ?? []) if (!ids.includes(id)) ids.push(id);
      return setSpectres(xml, ids);
    }
  }
  return xml;
}
