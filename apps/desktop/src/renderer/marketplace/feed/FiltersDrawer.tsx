import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Segmented, Select } from '../../ui.js';
import { BUDGET_LABELS, CLASSES, LIMIT_NOTE, MECHANICS, SELECTION_LIMIT, buildQuery, canSelect, current, emptyFilters, filterCount, filterFieldsFor, mechanicName, setFilters, type FeedState, type Filters } from '../presenter.js';
import { FEED_FILTER_LIMITS, type BudgetBand } from '@pom/mastery-contracts';
import type { MarketplaceProps } from '../services.js';
import type { LeagueStamp } from '@pom/mastery-contracts';

const lanes = [{ id: 'build', label: 'Build' }, { id: 'atlas', label: 'Atlas' }, { id: 'filter', label: 'Loot Filter' }];
export function FiltersDrawer({ props, state, setState, stamp, skills, tags = [], onClose, onLeague, leagueValue }: {
  props: MarketplaceProps; state: FeedState; setState: (s: FeedState) => void; stamp: LeagueStamp; skills: ReadonlyMap<string, string>; tags?: string[]; onClose: () => void; onLeague: (name: string | null) => void; leagueValue: string;
}) {
  const f = current(state).filters, fields = filterFieldsFor(state.type), [skillQuery, setSkillQuery] = useState('');
  const [classQuery, setClassQuery] = useState(''), [tagQuery, setTagQuery] = useState(''), [mechanicQuery, setMechanicQuery] = useState('');
  const [count, setCount] = useState<{ status: 'counting' | 'ok' | 'error'; total?: number }>({ status: 'counting' });
  const search = useRef<HTMLInputElement>(null), done = useRef<HTMLButtonElement>(null);
  const update = (patch: Partial<Filters>) => setState(setFilters(state, { ...f, ...patch }));
  useEffect(() => done.current?.focus(), []);
  const key = JSON.stringify(buildQuery(state, stamp, null));
  useEffect(() => {
    let live = true; setCount({ status: 'counting' });
    const timer = setTimeout(() => { props.services.count(buildQuery(state, stamp, null)).then(r => { if (live) setCount(r.result.ok ? { status: 'ok', total: r.result.value.total } : { status: 'error' }); }, () => { if (live) setCount({ status: 'error' }); }); }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [key]);
  // Names are shown; the filter holds skill ids (what the site matches).
  const shown = useMemo(() => [...new Set([...f.skills, ...skills.keys()])].map(id => ({ id, name: skills.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name))
    .filter(s => s.name.toLocaleLowerCase().includes(skillQuery.toLocaleLowerCase())), [skills, f.skills, skillQuery]);
  const toggle = (list: string[], v: string) => list.includes(v) ? list.filter(x => x !== v) : [...list, v];
  const match = (q: string) => (label: string) => label.toLocaleLowerCase().includes(q.trim().toLocaleLowerCase());
  const classes = useMemo(() => [...new Set([...f.classes, ...CLASSES])].filter(match(classQuery)), [f.classes, classQuery]);
  const mechanics = useMemo(() => [...new Set([...f.mechanics, ...MECHANICS])].filter(m => match(mechanicQuery)(mechanicName(m))), [f.mechanics, mechanicQuery]);
  const tagList = useMemo(() => [...new Set([...f.tags, ...tags])].sort((a, b) => a.localeCompare(b)).filter(match(tagQuery)), [f.tags, tags, tagQuery]);
  const typedTag = tagQuery.trim(), canAddTag = typedTag.length > 0 && [...typedTag].length <= FEED_FILTER_LIMITS.tagLength && f.tags.length < SELECTION_LIMIT && !f.tags.some(t => t.toLocaleLowerCase() === typedTag.toLocaleLowerCase());
  /** "1 selected", and the limit once it is reached (further choices are then disabled). */
  const chosen = (list: readonly string[]) => `${list.length} selected${list.length >= SELECTION_LIMIT ? `. ${LIMIT_NOTE}.` : ''}`;
  const leagues = [{ value: '', label: `${props.leagues[0]?.name ?? 'Current league'} (current)` }, ...props.leagues.slice(1).map(l => ({ value: l.name, label: l.name }))];
  return <aside className="mp-drawer" aria-label="Filters" onKeyDown={e => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); }
  }}>
    <header><h2>Filters</h2><button type="button" className="icon-btn" aria-label="Close filters" onClick={onClose}><Icon name="x" /></button></header>
    <div className="mp-drawer-body">
      <label className="mp-field">League<Select ariaLabel="League" width="100%" value={leagueValue} options={leagues} onChange={v => onLeague(v || null)} /></label>
      {fields.includes('mode') && <fieldset className="mp-field"><legend>Mode</legend>
        <Segmented ariaLabel="Mode" value={f.economy ?? 'any'} onChange={v => update({ economy: v === 'any' ? null : v as 'trade' | 'ssf' })} options={[{ value: 'any', label: 'Any' }, { value: 'trade', label: 'Trade' }, { value: 'ssf', label: 'SSF' }]} />
        <label className="mp-check"><input type="checkbox" checked={f.hardcore} onChange={e => update({ hardcore: e.target.checked })} /> Hardcore</label>
        <label className="mp-check"><input type="checkbox" checked={f.ruthless} onChange={e => update({ ruthless: e.target.checked })} /> Ruthless</label></fieldset>}
      {fields.includes('skills') && <fieldset className="mp-field"><legend>Skill</legend>
        <input ref={search} className="mp-input" aria-label="Search skills" placeholder="Search skills..." value={skillQuery} onChange={e => setSkillQuery(e.target.value)} />
        <small role="status">{chosen(f.skills)}</small>
        <div className="mp-checklist">{shown.length ? shown.map(s => <label className="mp-check" key={s.id}><input type="checkbox" checked={f.skills.includes(s.id)} disabled={!canSelect(f.skills, s.id)} onChange={() => update({ skills: toggle(f.skills, s.id) })} /> {s.name}</label>) : <small>No skills match.</small>}</div></fieldset>}
      {fields.includes('classes') && <fieldset className="mp-field"><legend>Class</legend>
        <input className="mp-input" aria-label="Search classes" placeholder="Search classes..." value={classQuery} onChange={e => setClassQuery(e.target.value)} />
        <small role="status">{chosen(f.classes)} Matches the class or the ascendancy.</small>
        <div className="mp-checklist">{classes.length ? classes.map(c => <label className="mp-check" key={c}><input type="checkbox" checked={f.classes.includes(c)} disabled={!canSelect(f.classes, c)} onChange={() => update({ classes: toggle(f.classes, c) })} /> {c}</label>) : <small>No classes match.</small>}</div></fieldset>}
      {fields.includes('mechanics') && <fieldset className="mp-field"><legend>Mechanics</legend>
        <input className="mp-input" aria-label="Search mechanics" placeholder="Search mechanics..." value={mechanicQuery} onChange={e => setMechanicQuery(e.target.value)} />
        <small role="status">{chosen(f.mechanics)}</small>
        <div className="mp-checklist">{mechanics.length ? mechanics.map(m => <label className="mp-check" key={m}><input type="checkbox" checked={f.mechanics.includes(m)} disabled={!canSelect(f.mechanics, m)} onChange={() => update({ mechanics: toggle(f.mechanics, m) })} /> {mechanicName(m)}</label>) : <small>No mechanics match.</small>}</div></fieldset>}
      {fields.includes('lanes') && <fieldset className="mp-field"><legend>Included lanes</legend>
        {lanes.map(l => <label className="mp-check" key={l.id}><input type="checkbox" checked={f.lanes.includes(l.id)} onChange={() => update({ lanes: toggle(f.lanes, l.id) })} /> {l.label}</label>)}</fieldset>}
      {fields.includes('budget') && <label className="mp-field" title="Budget bands are what the creator declared. There is no standard currency amount behind them.">Budget<Select ariaLabel="Budget" width="100%" value={f.budget ?? ''}
        options={[{ value: '', label: 'Any budget' }, ...(Object.keys(BUDGET_LABELS) as BudgetBand[]).map(b => ({ value: b, label: BUDGET_LABELS[b] }))]} onChange={v => update({ budget: (v || null) as BudgetBand | null })} /></label>}
      {fields.includes('tags') && <fieldset className="mp-field"><legend>Tags</legend>
        <input className="mp-input" aria-label="Search tags" placeholder="Search tags..." maxLength={FEED_FILTER_LIMITS.tagLength} value={tagQuery} onChange={e => setTagQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && canAddTag) { e.preventDefault(); update({ tags: [...f.tags, typedTag] }); setTagQuery(''); } }} />
        <small role="status">{f.tags.length} of {SELECTION_LIMIT} selected{f.tags.length >= SELECTION_LIMIT ? `. ${LIMIT_NOTE}.` : ''}</small>
        <div className="mp-checklist">{tagList.map(t => <label className="mp-check" key={t}><input type="checkbox" checked={f.tags.includes(t)} disabled={!canSelect(f.tags, t)} onChange={() => update({ tags: toggle(f.tags, t) })} /> {t}</label>)}
          {canAddTag && !tagList.some(t => t.toLocaleLowerCase() === typedTag.toLocaleLowerCase()) && <button type="button" className="btn" onClick={() => { update({ tags: [...f.tags, typedTag] }); setTagQuery(''); }}>Filter by tag "{typedTag}"</button>}
          {!tagList.length && !canAddTag && <small>No tags match.</small>}</div></fieldset>}
      {fields.includes('video') && <label className="mp-check"><input type="checkbox" checked={f.hasVideo} onChange={e => update({ hasVideo: e.target.checked })} /> Has video</label>}
      {fields.includes('verified') && <fieldset className="mp-field"><legend>Creator</legend>
        <label className="mp-check"><input type="checkbox" checked={f.verifiedOnly} onChange={e => update({ verifiedOnly: e.target.checked })} /> Verified only</label>
        <small>Verified means identity only. It does not verify the plan.</small></fieldset>}
      <p className="mp-note">Creator claims are shown as submitted.</p>
    </div>
    <footer>
      <span role="status">{count.status === 'counting' ? 'Counting...' : count.status === 'error' ? 'Count unavailable' : `${count.total} matching posts`}</span>
      <button type="button" className="btn" disabled={!filterCount(f, state.type) && !state.archiveLeague} onClick={() => { setState(setFilters(state, emptyFilters())); }}>Clear filters</button>
      <button type="button" ref={done} className="btn primary" onClick={onClose}>Done</button>
    </footer>
  </aside>;
}
