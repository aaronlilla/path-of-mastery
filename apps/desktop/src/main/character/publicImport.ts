import { blankBuildXml } from '../../shared/buildXml.js';
import type { CharacterRow, ImportParts } from '../../shared/characterImport.js';
import type { CharacterService } from './service.js';

let service: CharacterService | null = null;

/** The character service is made after the library; this lets the library's import reach it once it exists. */
export function setCharacterService(s: CharacterService): void {
  service = s;
}

const ALL: ImportParts = { tree: true, jewels: true, items: true, skills: true, deleteJewels: true, deleteItems: true, deleteSkills: true, ignoreWeaponSwap: false };

/** A public character as the XML of a new build: read-only GETs of the character window, then the normal character import. */
export async function importPublicCharacter(account: string, character: string, svc: CharacterService | null = service): Promise<string> {
  if (!svc) throw new Error('Character import is not ready yet.');
  const list = await svc.list('name', 'pc', account);
  const row: CharacterRow | undefined = list.characters.find((r) => r.name.toLowerCase() === character.toLowerCase());
  if (!row) throw new Error(`${list.account} has no character called ${character}.`);
  const bundle = await svc.fetch({ source: 'name', realm: row.realm, account: list.account, character: row, parts: ALL });
  const result = await svc.apply(blankBuildXml(row.class, row.level), bundle, ALL);
  return result.xml;
}
