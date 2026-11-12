/**
 * The sidebar's skill controls (skill part, stages, mines, minion, minion skill) belong to the MAIN skill, but the
 * engine only describes the Calcs tab's skill (`calcsView`). This builds the build text in which the Calcs tab's
 * skill choices are the main skill's own, so `calcsView` of that text describes the main skill. The text is only
 * ever loaded into a throwaway engine session; the open build is never touched.
 */
import { setCalcsInput } from './calcsLogic.js';

/** The main skill's gem and group attributes and the Calcs copy the engine reads for the Calcs tab's skill. */
const GEM_COPIES: Array<[string, string]> = [
  ['skillPart', 'skillPartCalcs'],
  ['skillStageCount', 'skillStageCountCalcs'],
  ['skillMineCount', 'skillMineCountCalcs'],
  ['skillMinion', 'skillMinionCalcs'],
  ['skillMinionItemSet', 'skillMinionItemSetCalcs'],
  ['skillMinionSkill', 'skillMinionSkillCalcs'],
];

const attrRe = (name: string) => new RegExp(`(\\s)${name}\\s*=\\s*("[^"]*"|'[^']*')`);

/** The element's opening tag with attribute `to` set to the value of attribute `from` (removed when `from` is absent). */
function copyAttr(tag: string, from: string, to: string): string {
  const src = attrRe(from).exec(tag);
  const without = tag.replace(attrRe(to), '');
  if (!src) return without;
  const at = without.search(/\s*\/?>$/);
  return without.slice(0, at) + ` ${to}=${src[2]}` + without.slice(at);
}

/** `xml` with the Calcs tab pointed at socket group `mainGroup` and every Calcs copy of a skill choice equal to the main one. */
export function mainSkillProbeXml(xml: string, mainGroup: number): string {
  let out = xml.replace(/<Skill\b[^>]*>/g, (tag) => copyAttr(tag, 'mainActiveSkill', 'mainActiveSkillCalcs'));
  out = out.replace(/<Gem\b[^>]*>/g, (tag) => GEM_COPIES.reduce((t, [from, to]) => copyAttr(t, from, to), tag));
  return setCalcsInput(out, 'skill_number', { number: Math.max(1, mainGroup) });
}

/** What the probe depends on: the main group's skills and choices. Anything else changing never needs a new probe. */
export function mainSkillProbeKey(xml: string, mainGroup: number, mainActive: number, groupXml: string | undefined): string {
  return `${mainGroup}|${mainActive}|${groupXml ?? ''}|${(xml.match(/<Spectre\s+id="[^"]*"\s*\/>/g) ?? []).join('')}`;
}
