import type { BuildEdit } from '@pom/protocol';
import { setActiveSetXml, type BuildFacts, type SetKind } from '../../shared/buildFacts.js';
import { CapSelect } from '../tabKit';
import { SkillSelectors } from './SkillSelectors';
import type { SideData } from './useSide';
import { tr } from '../i18n';

export const setOptions = (f: BuildFacts, kind: SetKind): { value: string; label: string }[] => {
  const list = kind === 'spec' ? f.specs.map((s, i) => ({ id: i + 1, title: s.title })) : kind === 'itemSet' ? f.itemSets : kind === 'skillSet' ? f.skillSets : f.configSets;
  return list.map((s) => ({ value: String(s.id), label: s.title || tr('compare_SetBar.default') }));
};

export const activeSetId = (f: BuildFacts, kind: SetKind): number => (kind === 'spec' ? f.activeSpec : kind === 'itemSet' ? f.activeItemSet : kind === 'skillSet' ? f.activeSkillSet : f.activeConfigSet);

const KINDS: { kind: SetKind; caption: string }[] = [
  { kind: 'spec', caption: tr('compare_SetBar.tree_set') },
  { kind: 'skillSet', caption: tr('compare_SetBar.skill_set') },
  { kind: 'itemSet', caption: tr('compare_SetBar.item_set') },
  { kind: 'configSet', caption: tr('compare_SetBar.config_set') },
];

/** One set dropdown: the sets of a build of one kind. `caption` is prefixed with the build ("B ITEM SET"). */
export function SetSelect({ facts, kind, caption, onPick, width = 150 }: { facts: BuildFacts; kind: SetKind; caption: string; onPick: (id: number) => void; width?: number }) {
  const opts = setOptions(facts, kind);
  const cur = String(activeSetId(facts, kind));
  return <CapSelect caption={caption} ariaLabel={caption.toLowerCase()} valueLabel={opts.find((o) => o.value === cur)?.label ?? tr('compare_SetBar.default')} value={cur} width={width} size="short" disabled={opts.length < 2} options={opts} onChange={(v) => onPick(Number(v))} />;
}

interface Props {
  facts: BuildFacts;
  xml: string;
  side: SideData;
  apply: (e: BuildEdit) => Promise<unknown>;
  applyXml: (fn: (xml: string) => string) => Promise<unknown>;
}

/** The compared build's own sets and main skill, as upstream's two rows under "Compare with". */
export function SetBar({ facts, xml, side, apply, applyXml }: Props) {
  return (
    <div className="cmp-sets" data-r="cmp-sets" role="group" aria-label={tr('compare_SetBar.compared_build_setup')}>
      {KINDS.map((k) => (
        <SetSelect key={k.kind} facts={facts} kind={k.kind} caption={'B ' + k.caption} onPick={(id) => void applyXml((x) => setActiveSetXml(x, k.kind, id))} />
      ))}
      <span className="cmp-sets-sep" />
      <SkillSelectors tag="B" side={side} xml={xml} facts={facts} mode="main" apply={apply} applyXml={applyXml} />
    </div>
  );
}
