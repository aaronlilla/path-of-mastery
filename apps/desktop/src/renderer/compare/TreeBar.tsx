import { useEffect, useState } from 'react';
import { copySpecXml, setActiveSetXml, activeSpecOf, type BuildFacts } from '../../shared/buildFacts.js';
import { convertSpecVersion } from '../buildSkills';
import { CapSelect } from '../tabKit';
import { Icon, useToast } from '../ui';
import { SetSelect } from './SetBar';
import { tr } from '../i18n';

interface VersionEntry {
  value: string;
  display: string;
}
let versions: Promise<VersionEntry[]> | null = null;
const loadVersions = (): Promise<VersionEntry[]> => (versions ??= fetch('game/tree/versions.json').then((r) => (r.ok ? (r.json() as Promise<VersionEntry[]>) : [])).catch(() => []));

interface Props {
  aFacts: BuildFacts;
  bFacts: BuildFacts;
  aXml: string;
  bXml: string;
  bLabel: string;
  search: string;
  onSearch: (v: string) => void;
  editAXml: (fn: (xml: string) => string) => Promise<unknown>;
  editBXml: (fn: (xml: string) => string) => Promise<unknown>;
  onUndo: () => Promise<unknown>;
}

/** The Tree sub-view's controls: a tree set and version for each build, the search box, Copy tree and Copy and use. */
export function TreeBar(p: Props) {
  const toast = useToast();
  const [list, setList] = useState<VersionEntry[]>([]);
  useEffect(() => {
    let live = true;
    void loadVersions().then((v) => live && setList(v));
    return () => {
      live = false;
    };
  }, []);
  const verSelect = (caption: string, f: BuildFacts, apply: (fn: (xml: string) => string) => Promise<unknown>) => {
    const cur = activeSpecOf(f)?.treeVersion ?? '';
    const opts = list.length ? list.map((v) => ({ value: v.value, label: v.display })) : cur ? [{ value: cur, label: cur.replace('_', '.') }] : [];
    const label = opts.find((o) => o.value === cur)?.label ?? cur.replace('_', '.');
    return <CapSelect caption={caption} ariaLabel={caption.toLowerCase()} valueLabel={label || '—'} value={cur} width={120} minWidth={90} size="short" disabled={!opts.length} options={opts} onChange={(v) => void apply((x) => convertSpecVersion(x, f.activeSpec, v, false))} />;
  };
  const copy = async (use: boolean) => {
    const title = tr('compare_TreeBar.blabel_compared', { bLabel: p.bLabel });
    await p.editAXml((x) => copySpecXml(x, p.bXml, title, use));
    toast({ text: use ? tr('compare_TreeBar.copied_the_tree_of_blabel', { bLabel: p.bLabel }) : tr('compare_TreeBar.copied_the_tree_of_blabel_2', { bLabel: p.bLabel, title }), kind: 'ok', action: { label: tr('compare_TreeBar.undo'), run: () => void p.onUndo() } });
  };
  const valid = !!activeSpecOf(p.bFacts);
  return (
    <div className="cmp-tbar">
      <SetSelect facts={p.aFacts} kind="spec" caption={tr('compare_TreeBar.a_tree_set')} onPick={(id) => void p.editAXml((x) => setActiveSetXml(x, 'spec', id))} />
      {verSelect(tr('compare_TreeBar_2.a_version'), p.aFacts, p.editAXml)}
      <SetSelect facts={p.bFacts} kind="spec" caption={tr('compare_TreeBar.b_tree_set')} onPick={(id) => void p.editBXml((x) => setActiveSetXml(x, 'spec', id))} />
      {verSelect(tr('compare_TreeBar_2.b_version'), p.bFacts, p.editBXml)}
      <div className="lib-search" data-lg="tile" style={{ flex: '1 1 160px', minWidth: 120, height: 32, borderRadius: 9, padding: '0 10px' }}>
        <Icon name="search" size={14} style={{ color: 'var(--text-muted)' }} />
        <input value={p.search} onChange={(e) => p.onSearch(e.target.value)} placeholder={tr('compare_TreeBar.search')} aria-label={tr('compare_TreeBar.search_the_tree')} spellCheck={false} />
      </div>
      <button type="button" className="btn sm" data-lg="control" disabled={!valid} title={tr('compare_TreeBar.add_the_compared_build_s')} onClick={() => void copy(false)}>
        <Icon name="copy" size={14} />
        {tr('compare_TreeBar.copy_tree')}
      </button>
      <button type="button" className="btn sm" data-lg="control" disabled={!valid} title={tr('compare_TreeBar.copy_the_compared_build_s')} onClick={() => void copy(true)}>
        <Icon name="check" size={14} />
        {tr('compare_TreeBar.copy_and_use')}
      </button>
    </div>
  );
}
