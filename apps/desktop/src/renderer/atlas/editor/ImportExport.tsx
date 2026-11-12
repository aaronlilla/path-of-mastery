import { useEffect, useMemo, useRef, useState } from 'react';
import { dataLabel } from '../canvas/model.js';
import type { AtlasPlan, AtlasStep, LeagueStamp, StepId } from '@pom/mastery-contracts';
import type { ImportResult } from '../../../main/atlas/formats.js';
import type { ExportOptions, SnapshotInput } from '../../../shared/atlas/codecs/pom.js';
import { encodeOfficialAtlasLink, UNAVAILABLE_OFFICIAL_EXPORT, UNSUPPORTED_ATLAS_LINK } from '../../../shared/atlas/codecs/external.js';
import { Dialog, Segmented, Select } from '../../ui.js';
import { knownLabel, stampLines } from '../../documents/model.js';
import { importLabel, stepIds, type ImportTarget } from './presenter.js';
import type { AtlasEditorPort, AvailableData } from './session.js';
import type { ValidationLimits } from '@pom/mastery-contracts';
import { allocationImport, codecInput } from './externalImport.js';
import { inspectAllocation, type AtlasGraph } from '../../../shared/atlas/graph.js';
import { fromMain, tr, inLanguage } from '../../i18n';

export function ImportAtlas({ port, plan, selected, close, commit, copy, openBuilds, leagues = [], data, limits, stepId, graphForData, initialInput = '' }: {
  port: AtlasEditorPort; plan: AtlasPlan | null; selected: StepId | null; close: () => void;
  commit: (result: Extract<ImportResult, { kind: 'snapshot' }>, target: ImportTarget, step: AtlasStep, sourceStamp: LeagueStamp | null) => Promise<void>;
  copy: (text: string) => Promise<boolean>; openBuilds?: (input: string) => void; leagues?: LeagueStamp[];
  data: AvailableData[]; limits: ValidationLimits; stepId: StepId;
  graphForData?: (data: AvailableData) => Promise<AtlasGraph>;
  /** A link pasted on the library (Ctrl+V) opens this dialog with it already filled in. */
  initialInput?: string;
}) {
  const [tab, setTab] = useState('Link or code'), [input, setInput] = useState(initialInput), [result, setResult] = useState<ImportResult | null>(null);
  const [parsing, setParsing] = useState(false), [busy, setBusy] = useState(false), [target, setTarget] = useState<ImportTarget>('new'), [advanced, setAdvanced] = useState(false);
  const [sourceStamp, setSourceStamp] = useState<LeagueStamp | null>(null), [unknownAccepted, setUnknownAccepted] = useState(false), [error, setError] = useState(''), [copyFallback, setCopyFallback] = useState(false);
  const file = useRef<HTMLInputElement>(null), generation = useRef(0), fileGeneration = useRef(0);
  const [dataIndex, setDataIndex] = useState('');
  const [checking, setChecking] = useState(false), dataGeneration = useRef(0);
  useEffect(() => () => { dataGeneration.current++; }, []);
  useEffect(() => {
    const current = ++generation.current, cancel = new AbortController();
    setResult(null); setUnknownAccepted(false); setSourceStamp(null); setDataIndex(''); setError(''); dataGeneration.current++; setChecking(false);
    if (!input.trim()) { setParsing(false); return; }
    setParsing(true);
    const timer = setTimeout(async () => {
      try { const next = await port.parse(codecInput(input), cancel.signal); if (current === generation.current && !cancel.signal.aborted) setResult(next.kind === 'snapshot' ? { ...next, sourceInput: input } : { ...next, input }); }
      catch { if (!cancel.signal.aborted && current === generation.current) setError(tr('atlas_editor_ImportExport.could_not_read_this_code')); }
      finally { if (current === generation.current && !cancel.signal.aborted) setParsing(false); }
    }, 250);
    return () => { clearTimeout(timer); cancel.abort(); generation.current++; };
  }, [input, port]);
  const pickData = async (value: string, from: Extract<ImportResult, { kind: 'allocation' }>) => {
    setDataIndex(value); setSourceStamp(null); setUnknownAccepted(false); const request = ++dataGeneration.current; setChecking(false);
    if (value === '' || !graphForData) return; setChecking(true);
    try { const graph = await graphForData(data[Number(value)]!); if (request === dataGeneration.current) setResult({ ...from, repair: inspectAllocation(graph, from.nodeIds) }); }
    catch { if (request === dataGeneration.current) { setDataIndex(''); setError(tr('atlas_editor_ImportExport.could_not_load_tree_data')); } }
    finally { if (request === dataGeneration.current) setChecking(false); }
  };
  // A tree link carries no tree data: pick it for the player (Ruthless links get Ruthless data, others the current
  // data), once per pasted link. They can still change it.
  const autoPicked = useRef('');
  useEffect(() => {
    if (result?.kind !== 'allocation' || dataIndex !== '' || !data.length || autoPicked.current === input) return;
    autoPicked.current = input;
    const ruthless = result.ruthless === true, fits = (d: AvailableData) => d.dataset.variant.includes('ruthless') === ruthless;
    const index = Math.max(0, data.findIndex(d => d.active && fits(d)) >= 0 ? data.findIndex(d => d.active && fits(d)) : data.findIndex(fits));
    void pickData(String(index), result);
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => result?.kind === 'allocation' && dataIndex !== '' && data[Number(dataIndex)] ? allocationImport(result, data[Number(dataIndex)]!, stepId, input, new Date().toISOString(), limits) : result?.kind === 'snapshot' ? result : null, [result, dataIndex, data, stepId, input, limits]);
  const imported = preview?.snapshot.document.kind === 'atlas' ? preview.snapshot.document.payload : null;
  const first = imported ? imported.stepsById[stepIds(imported)[0]!] : null;
  const requiresChoice = imported?.stamp.leagueId.status === 'unknown';
  // An unknown source league defaults to the current league (or Keep unknown when that is unknown too).
  useEffect(() => {
    if (!requiresChoice) return;
    const now = leagues[0];
    if (now && now.leagueId.status === 'known') setSourceStamp(now); else setUnknownAccepted(true);
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps
  const canCommit = !!first && !!preview && preview.sourceInput === input && !parsing && !checking && (!requiresChoice || unknownAccepted || !!sourceStamp) && !busy && (target === 'new' || !!plan && !!selected);
  return <Dialog title={tr('atlas_editor_ImportExport.import_atlas_plan')} size={imported || result?.kind === 'allocation' ? 'large' : 'medium'} onCancel={() => { generation.current++; fileGeneration.current++; close(); }} confirmLabel={importLabel(target)} confirmDisabled={!canCommit} confirmBusy={busy} onConfirm={async () => {
    if (!canCommit || !preview || !first) return;
    setBusy(true); setError('');
    try { await commit(preview, target, first, sourceStamp); close(); } catch { setError(tr('atlas_editor_ImportExport.could_not_import_atlas_plan')); } finally { setBusy(false); }
  }}>
    <div onKeyDown={e => { if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) e.stopPropagation(); }}>
    <Segmented ariaLabel={tr('atlas_editor_ImportExport.import_source')} value={tab} onChange={setTab} options={['Link or code', 'File'].map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} />
    {tab === 'Link or code' ? <label className="atlas-field">{tr('atlas_editor_ImportExport.paste_a_pom_poeplanner_or')}<textarea className="field atlas-code" value={input} onChange={e => setInput(e.target.value)} /></label>
      : <><button type="button" className="btn" onClick={() => file.current?.click()}>{tr('atlas_editor_ImportExport.choose_file')}</button><input ref={file} type="file" accept=".pom-atlas,.json" hidden onChange={async e => {
        const selectedFile = e.target.files?.[0], current = ++fileGeneration.current; if (!selectedFile) return;
        try { const text = await selectedFile.text(); if (current === fileGeneration.current) setInput(text); } catch { setError(tr('atlas_editor_ImportExport.could_not_read_this_file')); }
      }} /></>}
    {parsing && <p role="status">{tr('atlas_editor_ImportExport.parsing')}</p>}
    {result?.kind === 'unsupported' && <><p role="alert">{fromMain('ml_atlas_import', UNSUPPORTED_ATLAS_LINK)}</p><button type="button" className="btn" onClick={async () => setCopyFallback(!await copy(input))}>{tr('atlas_editor_ImportExport.copy_input')}</button><p>{tr('atlas_editor_ImportExport.use_a_pom_file_poeplanner')}</p></>}
    {result?.kind === 'allocation' && <section aria-label={tr('atlas_editor_ImportExport.tree_link_preview')}><p>{result.format === 'official' ? tr('atlas_editor_ImportExport.official_atlas_link') : tr('atlas_editor_ImportExport.poeplanner_atlas_link')}</p><p>{tr('atlas_editor_ImportExport.only_the_tree_is_included')}</p><p>{tr('atlas_editor_ImportExport.length_nodes_source_league_unknown', { count: result.nodeIds.length })}</p>{result.treeVersion !== undefined && <p>{tr('atlas_editor_ImportExport.tree_version_treeversion', { treeVersion: result.treeVersion })}{result.patch ? ` / ${result.patch}` : ''}{result.ruthless ? tr('atlas_editor_ImportExport.ruthless') : ''}</p>}<details><summary>{tr('atlas_editor_ImportExport.node_ids')}</summary>{result.nodeIds.join(', ')}</details><Select ariaLabel={tr('atlas_editor_ImportExport.tree_data')} value={dataIndex} options={[{ value: '', label: tr('atlas_editor_ImportExport.choose_tree_data') }, ...data.map((d, index) => ({ value: String(index), label: dataLabel(d.dataset.datasetId, d.dataset.variant) }))]} onChange={value => void pickData(value, result)} />{checking && <p role="status">{tr('atlas_editor_ImportExport.updating')}</p>}{!data.length && <p>{tr('atlas_editor_ImportExport.download_tree_data_to_create')}</p>}<p>{tr('atlas_editor_ImportExport.choose_data_to_interpret_these')}</p></section>}
    {result?.kind === 'invalid' && <p role="alert">{fromMain('ml_atlas_import', result.message)}</p>}
    {result?.kind === 'build' && <><p>{fromMain('ml_atlas_import', result.message)}</p><button type="button" className="btn" disabled={!openBuilds} onClick={() => openBuilds?.(input)}>{tr('atlas_editor_ImportExport.open_in_builds')}</button></>}
    {result?.kind === 'hosted_link' && <p>{tr('atlas_editor_ImportExport.connect_to_load_this_plan')}</p>}
    {result?.kind === 'snapshot' && !imported && <p>{tr('atlas_editor_ImportExport.this_is_a_timeline_snapshot')}</p>}
    {imported && first && <section className="atlas-import-preview" aria-label={tr('atlas_editor_ImportExport.import_preview')}><h3>{imported.title}</h3><p>{tr('atlas_editor_ImportExport.source_league_leagueid_variant', { leagueId: knownLabel(imported.stamp.leagueId), variant: dataLabel(imported.dataset.datasetId, imported.dataset.variant) })}</p><p>{tr('atlas_editor_ImportExport.count_steps', { count: stepIds(imported).length })} {tr('atlas_editor_ImportExport.length_nodes', { count: first.allocatedIds.length })}</p>
      {preview?.warnings.map((warning, index) => <details key={index}><summary>{fromMain('ml_atlas_import', warning.message)}</summary>{warning.kind === 'repair' && <p>{[...warning.missingIds, ...warning.disconnectedIds].join(', ')}</p>}</details>)}
      <fieldset><legend>{tr('atlas_editor_ImportExport.target')}</legend>{(['new', 'add'] as const).map(v => <label key={v}><input type="radio" name="import-target" checked={target === v} disabled={v === 'add' && (!plan || !selected)} onChange={() => setTarget(v)} />{v === 'new' ? tr('atlas_editor_ImportExport.new_plan') : tr('atlas_editor_ImportExport.add_as_a_step')}</label>)}</fieldset>
      <button type="button" className="btn" onClick={() => setAdvanced(v => !v)}>{tr('atlas_editor_ImportExport.advanced')}</button>{advanced && <label><input type="radio" name="import-target" checked={target === 'replace'} disabled={!plan || !selected} onChange={() => setTarget('replace')} />{tr('atlas_editor_ImportExport.replace_selected_step')}</label>}
      {target !== 'new' && plan && <p>{target === 'replace' ? tr('atlas_editor_ImportExport.replace') : tr('atlas_editor_ImportExport.add_to')} {plan.title}. {target === 'replace' ? tr('atlas_editor_ImportExport.the_change_is_one_undoable') : tr('atlas_editor_ImportExport.existing_steps_are_preserved')}</p>}
      {target === 'replace' && plan && selected && <div aria-label={tr('atlas_editor_ImportExport.replacement_preview')}><p>{tr('atlas_editor_ImportExport.remove')} {plan.stepsById[selected]!.allocatedIds.filter(id => !first.allocatedIds.includes(id)).length} {tr('atlas_editor_ImportExport.add')} {first.allocatedIds.filter(id => !plan.stepsById[selected]!.allocatedIds.includes(id)).length}</p><pre>{JSON.stringify({ before: plan.stepsById[selected], after: first }, null, 2)}</pre></div>}
      {target !== 'new' && plan?.dataset.contentHash !== imported.dataset.contentHash && <p>{tr('atlas_editor_ImportExport.different_tree_data_imported_ids')}</p>}
      {requiresChoice && <><Select ariaLabel={tr('atlas_editor_ImportExport.choose_source_league_if_unknown')} value={sourceStamp ? String(leagues.indexOf(sourceStamp)) : ''} options={[{ value: '', label: tr('atlas_editor_ImportExport.choose_source_league_if_unknown') }, ...leagues.map((stamp, index) => ({ value: String(index), label: knownLabel(stamp.leagueId) }))]} onChange={v => { setSourceStamp(v === '' ? null : leagues[Number(v)] ?? null); setUnknownAccepted(false); }} />
        <label><input type="checkbox" checked={unknownAccepted} onChange={e => { setUnknownAccepted(e.target.checked); setSourceStamp(null); }} />{tr('atlas_editor_ImportExport.keep_unknown')}</label><p>{tr('atlas_editor_ImportExport.choosing_a_league_is_not')}</p></>}
    </section>}
    {copyFallback && <textarea className="field atlas-code" readOnly aria-label={tr('atlas_editor_ImportExport.copy_input')} value={input} onFocus={e => e.currentTarget.select()} />}
    {error && <p role="alert">{error}<button type="button" className="btn" onClick={() => { const text = input; setInput(''); queueMicrotask(() => setInput(text)); }}>{tr('atlas_editor_ImportExport.retry')}</button></p>}
    </div>
  </Dialog>;
}
export function ExportAtlas({ input, selected, port, close, online, signedIn, signIn, publish, copy }: {
  input: SnapshotInput & { document: { kind: 'atlas'; payload: AtlasPlan } }; selected: StepId; port: AtlasEditorPort; close: () => void;
  online: boolean; signedIn: boolean; signIn?: () => void; publish?: () => void; copy: (text: string) => Promise<boolean>;
}) {
  const [tab, setTab] = useState('PoM link'), [step, setStep] = useState(selected);
  const [include, setInclude] = useState({ allSteps: true, includeMapsScarabs: true, includeNotes: true, includeHistory: false });
  const [link, setLink] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [fallback, setFallback] = useState(false);
  const cancel = useRef<AbortController | null>(null);
  useEffect(() => () => cancel.current?.abort(), []);
  const options: Omit<ExportOptions, 'destination'> = { ...include, includePrivateNotes: false, stepId: step };
  const treeLink = encodeOfficialAtlasLink(input.document.payload.stepsById[step]?.allocatedIds ?? []);
  const [treeFallback, setTreeFallback] = useState('');
  const run = async (kind: 'file' | 'link') => {
    setBusy(true); setError(''); const signal = new AbortController(); cancel.current?.abort(); cancel.current = signal;
    try { if (kind === 'file') await port.exportFile(input, options); else { const result = await port.share(input, options, signal.signal); if (!signal.signal.aborted) setLink(result); } }
    catch { if (!signal.signal.aborted) setError(kind === 'file' ? tr('h_atlasA_M.err_export') : tr('h_atlasA_M.err_share')); }
    finally { if (!signal.signal.aborted) setBusy(false); }
  };
  return <Dialog title={tr('atlas_editor_ImportExport.share_title', { title: input.document.payload.title })} size="large" onCancel={() => { cancel.current?.abort(); close(); }} cancelLabel={null} confirmLabel={tr('atlas_editor_ImportExport.done')} onConfirm={close}>
    <Segmented ariaLabel={tr('atlas_editor_ImportExport.share_format')} value={tab} onChange={setTab} options={['PoM link', 'File', 'Tree link/code'].map(value => ({ value, label: inLanguage('h_atlasA_L', value) }))} />
    {tab !== 'Tree link/code' && <fieldset className="atlas-export-options"><legend>{tr('atlas_editor_ImportExport.include')}</legend>{(['allSteps', 'includeMapsScarabs', 'includeNotes', 'includeHistory'] as const).map(key => <label key={key}><input type="checkbox" checked={include[key]} onChange={e => { setInclude(old => ({ ...old, [key]: e.target.checked })); setLink(''); }} />{{ allSteps: tr('atlas_editor_ImportExport.all_steps'), includeMapsScarabs: tr('atlas_editor_ImportExport_2.maps_scarabs'), includeNotes: tr('atlas_editor_ImportExport_2.notes'), includeHistory: tr('atlas_editor_ImportExport.edit_history') }[key]}</label>)}
      <label><input type="checkbox" checked={false} disabled />{tr('atlas_editor_ImportExport.private_notes')}</label></fieldset>}
    <p>{stampLines(input.document.payload.stamp).join(' / ')}</p>
    {input.document.payload.credits.map((credit, index) => <p key={index}>{credit.status === 'original_removed' ? tr('atlas_editor_ImportExport.original_removed') : tr('atlas_editor_ImportExport.copied_from_title_by_creatorname', { title: credit.title, creatorName: credit.creatorName })}</p>)}
    {!include.allSteps || tab === 'Tree link/code' ? <Select ariaLabel={tr('atlas_editor_ImportExport.step')} value={step} options={stepIds(input.document.payload).map(value => ({ value, label: input.document.payload.stepsById[value]!.title }))} onChange={v => { setStep(v); setLink(''); }} /> : null}
    {tab === 'PoM link' && <>{!online && <p>{tr('atlas_editor_ImportExport.offline_create_share_link_is')}</p>}{!signedIn && <button type="button" className="btn" disabled={!signIn || !online} onClick={signIn}>{tr('atlas_editor_ImportExport.sign_in')}</button>}
      <button type="button" className="btn" disabled={!online || !signedIn || busy} onClick={() => void run('link')}>{tr('atlas_editor_ImportExport.create_share_link')}</button>{busy && <button type="button" className="btn" onClick={() => { cancel.current?.abort(); setBusy(false); }}>{tr('atlas_editor_ImportExport.cancel')}</button>}
      {link && <><label className="atlas-field">{tr('atlas_editor_ImportExport.pom_link')}<input className="field atlas-code" readOnly value={link} onFocus={e => e.currentTarget.select()} /></label><button type="button" className="btn" onClick={async () => setFallback(!await copy(link))}>{tr('atlas_editor_ImportExport.copy_link')}</button></>}
      <p>{tr('atlas_editor_ImportExport.hosted_shares_exclude_private_notes')}</p></>}
    {tab === 'File' && <button type="button" className="btn" disabled={busy} onClick={() => void run('file')}>{tr('atlas_editor_ImportExport.export_pom_atlas_file')}</button>}
    {tab === 'Tree link/code' && <><p>{tr('atlas_editor_ImportExport.tree_links_contain_nodes_only')}</p>{!treeLink && <p>{UNAVAILABLE_OFFICIAL_EXPORT}</p>}<div className="atlas-row-actions">{['Copy official tree link', 'Copy tree code'].map(label => <button key={label} type="button" className="btn" disabled={!treeLink} onClick={async () => { const text = label === 'Copy tree code' ? treeLink!.split('/').at(-1)! : treeLink!; if (!await copy(text)) setTreeFallback(text); }}>{label === 'Copy official tree link' ? tr('atlas_editor_ImportExport.copy_official_tree_link') : inLanguage('h_atlasA_L', label)}</button>)}</div>{treeFallback && <textarea aria-label={tr('atlas_editor_ImportExport.tree_link_or_code')} className="field atlas-code" readOnly value={treeFallback} onFocus={e => e.currentTarget.select()} />}</>}
    <button type="button" className="btn" disabled={!publish} onClick={publish}>{tr('atlas_editor_ImportExport.publish_to_marketplace')}</button>
    {error && <p role="alert">{error}<button type="button" className="btn" onClick={() => void run(tab === 'File' ? 'file' : 'link')}>{tr('atlas_editor_ImportExport.retry')}</button></p>}
    {fallback && <p>{tr('atlas_editor_ImportExport.copy_failed_select_and_copy')}</p>}
  </Dialog>;
}
