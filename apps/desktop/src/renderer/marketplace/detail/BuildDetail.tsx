import { useState } from 'react';
import type { PublicItemPayload } from '@pom/mastery-contracts';
import { Segmented } from '../../ui.js';
import { ItemArt } from '../../documents/ItemCard.js';
import { buildTabs, missingSection } from '../presenter.js';
import type { MarketplaceProps } from '../services.js';
import type { DetailActions } from './DetailView.js';
import { Description, Finished, GameData, VersionsPanel } from './shared.js';

type Doc = Extract<PublicItemPayload['document'], { kind: 'build' }>;
const trigger = (t: Doc['payload']['guide'][number]['trigger']) => t.kind === 'level' ? `Level ${t.level}` : t.kind === 'areaLevel' ? `Area level ${t.level}` : t.kind === 'zone' ? `Zone ${t.zoneId}` : t.kind === 'quest' ? `Quest ${t.questId}` : t.kind === 'firstMap' ? 'First map' : t.kind === 'atlasAllocated' ? `${t.points} Atlas points` : `Step ${t.ordinal}`;
export function BuildDetail({ item, document, props, actions, onSelectRevision }: { item: PublicItemPayload; document: Doc; props: MarketplaceProps; actions: DetailActions; onSelectRevision: (r: number) => void }) {
  const [tab, setTab] = useState('overview'), [query, setQuery] = useState('');
  const b = document.payload, art = (a: Doc['payload']['skills'][number]['asset'], name: string) => ({ name, src: a ? props.services.assetUrl?.(a) : undefined });
  const requirements = b.guide.flatMap(g => g.requirements);
  const stats = b.calculatedStats;
  const nodes = b.treeNodes.filter(n => n.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="mp-detail-body">
    <Segmented ariaLabel="Build sections" value={tab} onChange={setTab} options={buildTabs.map(t => ({ value: t.id, label: t.label }))} />
    {tab === 'overview' && <div className="mp-grid2">
      <div className="mp-panel"><h3>Summary</h3>
        <p>{b.skills.length} skills / {b.gear.length} items / {b.treeNodes.length} passive points</p>
        {stats.status === 'known' ? <><p className="mp-note">Calculated with engine {stats.value.engineVersion}. Assumptions: {stats.value.assumptions.length ? stats.value.assumptions.join('; ') : 'none listed'}.</p>
          <dl className="mp-stats">{stats.value.values.map(v => <div key={v.statId}><dt>{v.statId}</dt><dd>{v.value} {v.unit}</dd></div>)}</dl></>
          : <p className="mp-note">Stats unavailable for this version. The source below is intact.</p>}
        <Finished item={item} /></div>
      <Description item={item} props={props} />
      <div className="mp-panel"><h3>Requirements</h3>{requirements.length ? <ul>{requirements.map((r, i) => <li key={i}>{r.kind === 'level' ? `Level ${r.minimum}` : r.kind === 'quest' ? `Quest ${r.questId}` : r.kind === 'areaLevel' ? `Area level ${r.minimum}` : `${r.minimum} Atlas points`}</li>)}</ul> : <p className="mp-note">{missingSection('requirements')}</p>}</div>
      <GameData item={item} />
      {b.notes && <div className="mp-panel"><h3>Build notes</h3><p className="mp-pre">{b.notes}</p></div>}
    </div>}
    {tab === 'tree' && <div className="mp-panel"><h3>Passive tree</h3>
      {props.buildTree ? props.buildTree(b) : null}
      <label className="mp-field">Search passives<input className="mp-input" placeholder="Search passives..." value={query} onChange={e => setQuery(e.target.value)} /></label>
      {b.treeNodes.length ? <ul className="mp-scroll-list" aria-label={`${b.treeNodes.length} allocated passives`}>{nodes.map(n => <li key={n}>{n}</li>)}</ul> : <p className="mp-note">{missingSection('a passive tree')}</p>}
      <p className="mp-note">Read only. Use Edit a copy to change it.</p></div>}
    {tab === 'skills' && <div className="mp-panel"><h3>Skills</h3>{b.skills.length ? <ul className="mp-gear">{b.skills.map(s => <li key={s.skillId}><ItemArt art={art(s.asset, s.name)} /><span>{s.name}</span><small>{s.level.status === 'known' ? `Level ${s.level.value}` : 'Level unknown'}</small></li>)}</ul> : <p className="mp-note">{missingSection('skills')}</p>}</div>}
    {tab === 'gear' && <div className="mp-panel"><h3>Gear</h3>{b.gear.length ? <ul className="mp-gear">{b.gear.map(g => <li key={g.slotId + g.itemId}><ItemArt art={art(g.asset, g.name)} /><div><strong>{g.name}</strong><small>{g.slotId}</small>{g.modifiers.map((m, i) => <p className="mp-mod" key={i}>{m}</p>)}</div></li>)}</ul> : <p className="mp-note">{missingSection('gear')}</p>}</div>}
    {tab === 'leveling' && <div className="mp-panel"><h3>Leveling</h3>{b.guide.length ? <ol className="mp-guide">{b.guide.map(g => <li key={g.actionId}><strong>{trigger(g.trigger)}</strong><p>{g.instruction.firstAction}</p>{g.instruction.details && <p className="mp-note">{g.instruction.details}</p>}</li>)}</ol> : <p className="mp-note">{missingSection('leveling')}</p>}</div>}
    {tab === 'versions' && <VersionsPanel item={item} onSelect={onSelectRevision} />}
    {actions.note && <p className="mp-note" role="status">{actions.note}</p>}
  </div>;
}
