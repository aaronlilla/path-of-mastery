import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { RunLogCall, RunLogState } from '../../shared/run/log.js';
import type { Monitor, WindowPreferences } from '../../shared/run/window.js';
import type { RunCtx } from './RunApp';
import { LANE_LABEL, WIDTH_BY_SIZE, actionsOf, clampOpacity, jumpToMyLevel, horizontalHeight, jumpTarget, laneType, levelRange, logStatus, newId, skippedIfJump, triggerLabel, validLevel } from './presenter';

export function Frame({ title, onClose, children, footer, wide }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return <div className="run-frame" data-wide={wide ? '1' : '0'}>
    <header><h2>{title}</h2><button className="run-btn run-x" aria-label="Close" onClick={onClose}>X</button></header>
    <div className="run-body">{children}</div>
    {footer && <footer>{footer}</footer>}
  </div>;
}
export function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string }) {
  return <div className="run-seg" role="radiogroup" aria-label={label}>{options.map(o =>
    <button key={String(o.value)} role="radio" aria-checked={o.value === value} className="run-btn" data-on={o.value === value ? '1' : '0'} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return <label className="run-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /> {label}</label>;
}

// ---- Chrome menu with the quick Position grid ----
export function MenuPanel({ ctx, onClose }: { ctx: RunCtx; onClose(): void }) {
  const { view } = ctx;
  const [reason, setReason] = useState<string | null>(null);
  const [log, setLog] = useState<RunLogState | null>(null);
  useEffect(() => { void ctx.bridge.logState().then(r => { if (r.ok) setLog(r.value); }); }, [ctx.bridge]);
  const levels = Array.from({ length: 100 }, (_, i) => i + 1);
  const owned = ctx.meta.ownership !== 'public';
  const go = async (level: number) => { const t = jumpTarget(view, level); if (t) { await ctx.send({ kind: 'jump', bundleId: t.bundleId }); onClose(); } };
  return <Frame title="Menu" onClose={onClose}>
    <section aria-label="Position">
      <h3>Position</h3>
      <div className="run-grid" role="grid" aria-label="Position 1 to 100">{levels.map(n => {
        const skipped = skippedIfJump(view, n);
        return <button key={n} className="run-cell" title={`${skipped} earlier actions will be skipped, not completed.`} onClick={() => void go(n)}
          data-current={view.state.guideCursor.level === n ? '1' : '0'}>{n}</button>;
      })}</div>
      <div className="run-row">
        <button className="run-btn" onClick={() => { const j = jumpToMyLevel(view); if (!j.ok) { setReason(j.reason); return; } void ctx.bridge.command(j.command).then(onClose); }}
          aria-describedby="run-jump-reason">Jump to my level</button>
        <button className="run-btn" onClick={() => ctx.open('position')}>More position options</button>
      </div>
      {reason && <p id="run-jump-reason" className="run-note">{reason}</p>}
    </section>
    <div className="run-list">
      <button className="run-btn" onClick={() => { void ctx.send({ kind: 'openDetails' }); ctx.open('details'); }}>Details</button>
      <button className="run-btn" onClick={() => ctx.open('log')}>Log: {logStatus(log)}</button>
      <button className="run-btn" onClick={() => ctx.open('settings')}>Settings</button>
      <button className="run-btn" onClick={() => void ctx.bridge.openTimeline()}>{owned ? 'Open timeline' : 'View timeline'}</button>
      {view.state.mode === 'manual' && <button className="run-btn" onClick={() => void ctx.send({ kind: 'follow' }).then(onClose)}>Follow game</button>}
      <button className="run-btn" onClick={() => { void ctx.send({ kind: 'finish' }); onClose(); }}>Finish run</button>
      {ctx.view.snapshot.settings.globalNextBackEnabled && <button className="run-btn" onClick={() => void ctx.bridge.disableHotkeys()}>Disable global hotkeys</button>}
    </div>
  </Frame>;
}

// ---- Details ----
export function DetailsPanel({ ctx, onClose, initialTab }: { ctx: RunCtx; onClose(): void; initialTab?: 'current' | 'missed' | 'source' }) {
  const { view } = ctx;
  const [tab, setTab] = useState<'current' | 'missed' | 'source'>(initialTab ?? 'current');
  const [copyText, setCopyText] = useState<string | null>(null);
  useEffect(() => { void ctx.send({ kind: 'openDetails' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = actionsOf(view, view.displayed.actionIds);
  const missedIds = [...new Set([...(view.catchUp?.missedActionIds ?? []), ...view.pendingCriticalActionIds])].filter(id => !view.displayed.actionIds.includes(id));
  const missed = actionsOf(view, missedIds);
  const reviewed = (id: string) => view.state.reviewed.some(r => r.actionId === id);
  const text = shown.map(a => `${LANE_LABEL[laneType(view, a)]}: ${a.instruction.firstAction}\n${a.instruction.details}`).join('\n\n');
  const copy = async () => { try { await navigator.clipboard.writeText(text); } catch { setCopyText(text); } };
  const done = async () => {
    const closed = await ctx.send({ kind: 'closeDetails' });
    const v = closed ?? view;
    await ctx.send({ kind: 'next', bundleId: v.displayed.bundleId, presentationVersion: v.presentationVersion });
    ctx.open(null);
  };
  const first = shown[0];
  const filterDep = (id: string) => { const a = view.snapshot.actions.find(x => x.actionId === id); const d = a && view.snapshot.dependencies.find(x => x.ref.revisionId === a.sourceRevision.revisionId); return d?.snapshot.kind === 'filter' ? d.snapshot.payload.capabilities : null; };
  const sourceTitles = [...new Set(shown.map(a => { const d = view.snapshot.dependencies.find(x => x.ref.revisionId === a.sourceRevision.revisionId); return d && 'title' in d.snapshot.payload ? String(d.snapshot.payload.title) : ''; }).filter(Boolean))];
  const heading = shown.length ? [[...new Set(shown.map(a => LANE_LABEL[laneType(view, a)]))].join(' + '), levelRange(view) ?? triggerLabel(view.displayed.trigger), ...sourceTitles].join(' / ') : 'Details';
  return <Frame wide title={heading} onClose={onClose}
    footer={<>
      <button className="run-btn" onClick={() => void copy()}>Copy instructions</button>
      <button className="run-btn" onClick={() => first && void ctx.bridge.openSource(first.actionId)} disabled={!first}>Open source</button>
      <button className="run-btn" onClick={() => ctx.open('feedback', { actionId: first?.actionId })} disabled={!first}>This step didn't work</button>
      <span className="run-grow" />
      <button className="run-btn" onClick={onClose}>Close</button>
      <button className="run-btn run-primary" onClick={() => void done()} disabled={!shown.length}>Done, next</button>
    </>}>
    <div className="run-tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'current'} onClick={() => setTab('current')}>Current instructions</button>
      <button role="tab" aria-selected={tab === 'missed'} onClick={() => setTab('missed')}>Missed actions {missed.length}</button>
      <button role="tab" aria-selected={tab === 'source'} onClick={() => setTab('source')}>Source</button>
    </div>
    {tab === 'current' && (shown.length === 0 ? <p>No instruction in this range.</p> : shown.map(a => {
      const type = laneType(view, a), caps = type === 'filter' ? filterDep(a.actionId) : null;
      return <article key={a.actionId} className="run-action" data-critical={a.critical ? '1' : '0'}>
        <h3>{LANE_LABEL[type]}{a.critical ? ' - required' : ''}</h3>
        <p className="run-first">{a.instruction.firstAction}</p>
        {a.instruction.details && <p className="run-support">{a.instruction.details}</p>}
        {a.instruction.whenReady && <p className="run-support">When ready: {a.instruction.whenReady}</p>}
        {a.requirements.map((r, i) => <p key={i} className="run-note">{r.kind === 'quest' ? `Quest ${r.questId} (${r.evidenceRequired})` : `Requires ${r.kind} ${r.minimum}`}{'provenance' in r ? ` - ${r.provenance}` : ''}</p>)}
        {caps && <div className="run-handoff">
          <p className="run-note">Export the filter, copy the file, then select it in game. Run does not switch filters for you.</p>
          <button className="run-btn" onClick={() => ctx.services.openLootFilter?.()} disabled={!ctx.services.openLootFilter}>Open Loot Filter</button>
          <span className="run-note"> Export {caps.exportFile ? 'available' : 'not available'}. Install {caps.installFile ? 'available' : 'not available'}.</span>
        </div>}
      </article>;
    }))}
    {tab === 'missed' && (missed.length === 0 ? <p>No missed actions.</p> : <ul className="run-missed">{missed.map(a => <li key={a.actionId}>
      <label><input type="checkbox" checked={reviewed(a.actionId)} onChange={() => { if (!reviewed(a.actionId)) void ctx.send({ kind: 'review', actionIds: [a.actionId] }); }} />
        {' '}<strong>{LANE_LABEL[laneType(view, a)]}</strong> {triggerLabel(a.trigger)}: <span className="run-first">{a.instruction.firstAction}</span> {a.critical && <em>(required)</em>}</label>
    </li>)}</ul>)}
    {tab === 'source' && <div>{[...new Set(shown.map(a => a.sourceRevision.revisionId))].map(id => {
      const dep = view.snapshot.dependencies.find(d => d.ref.revisionId === id);
      return <p key={id}>{dep ? `${LANE_LABEL[dep.snapshot.kind]}: ${'title' in dep.snapshot.payload ? dep.snapshot.payload.title : 'Untitled'}` : 'Source'} - pinned copy from this Run.</p>;
    })}<p className="run-note">{view.snapshot.publishedOrigin ? 'Published revision is pinned. Editing needs a local copy.' : 'Your own timeline, pinned at the time you started.'}</p></div>}
    {copyText !== null && <textarea className="run-copy" readOnly value={copyText} onFocus={e => e.currentTarget.select()} aria-label="Select and copy" />}
  </Frame>;
}

// ---- expanded position ----
export function PositionPanel({ ctx, onClose }: { ctx: RunCtx; onClose(): void }) {
  const { view } = ctx;
  const g = view.state.observedProgress.characterLevel;
  const [level, setLevel] = useState<number>(view.state.guideCursor.level);
  const [stage, setStage] = useState<'campaign' | 'maps'>('campaign');
  const [atlas, setAtlas] = useState('');
  const [follow, setFollow] = useState(false);
  const a = view.state.observedProgress.atlas.allocatedCount;
  const skipped = skippedIfJump(view, level);
  const atlasBad = stage === 'maps' && atlas !== '' && !(Number.isInteger(Number(atlas)) && Number(atlas) >= 0);
  const go = async () => {
    if (follow) await ctx.send({ kind: 'follow' });
    else { const t = jumpTarget(view, level); if (t) await ctx.send({ kind: 'jump', bundleId: t.bundleId }); }
    if (stage === 'maps') { await ctx.bridge.logControl({ kind: 'declareAtMaps' }); if (atlas !== '') await ctx.bridge.logControl({ kind: 'setBaseline', count: Number(atlas) }); }
    onClose();
  };
  return <Frame title="Run position" onClose={onClose} footer={<><span className="run-grow" /><button className="run-btn" onClick={onClose}>Cancel</button>
    <button className="run-btn run-primary" disabled={!validLevel(level) || atlasBad} onClick={() => void go()}>Go to this position</button></>}>
    <label className="run-field">Character level
      <span className="run-step"><button className="run-btn" aria-label="Lower" onClick={() => setLevel(l => Math.max(1, l - 1))}>-</button>
        <input type="number" min={1} max={100} value={level} onChange={e => setLevel(Number(e.target.value))} aria-invalid={!validLevel(level)} />
        <button className="run-btn" aria-label="Raise" onClick={() => setLevel(l => Math.min(100, l + 1))}>+</button></span></label>
    {!validLevel(level) && <p className="run-error">Level must be a whole number from 1 to 100.</p>}
    <div className="run-field">Progress <Seg<'campaign' | 'maps'> label="Progress" value={stage} onChange={setStage} options={[{ value: 'campaign', label: 'Campaign' }, { value: 'maps', label: 'At maps' }]} /></div>
    {stage === 'maps' && <label className="run-field">Atlas points <input type="number" min={0} value={atlas} placeholder="Unknown" onChange={e => setAtlas(e.target.value)} aria-invalid={atlasBad} />
      <button className="run-btn" onClick={() => setAtlas('')}>Unknown</button></label>}
    <p className="run-note">Position means where the guide is shown.</p>
    <details className="run-chunks"><summary>Chunks ({view.chunks.length})</summary>
      <ol className="run-chunklist">{view.chunks.map((c, i) => <li key={c.bundleId} data-current={c.bundleId === view.displayed.bundleId ? '1' : '0'}>
        <button className="run-btn" onClick={() => void ctx.send({ kind: 'jump', bundleId: c.bundleId as never }).then(() => onClose())}>{i + 1}. {c.label || 'Chunk'}</button></li>)}</ol></details>
    <p>Observed game: Level {g.status === 'known' ? g.value : 'Unknown'}, Atlas {a.status === 'known' ? a.value : 'Unknown'}</p>
    <div className="run-field"><label><input type="radio" name="follow" checked={!follow} onChange={() => setFollow(false)} /> Keep manual position</label>
      <label><input type="radio" name="follow" checked={follow} onChange={() => setFollow(true)} /> Follow game</label></div>
    {!follow && <p className="run-note">{skipped} earlier actions will be skipped, not completed.</p>}
  </Frame>;
}

// ---- Client.txt ----
const COVERAGE: Record<string, string> = { unknown: 'Atlas points unknown. Set a baseline or advance manually.', manual_baseline_and_deltas: 'From manual baseline and observed changes.',
  complete_snapshot: 'From a complete snapshot and observed changes.', gap: 'Atlas baseline needs checking.' };
export function LogPanel({ ctx, onClose }: { ctx: RunCtx; onClose(): void }) {
  const [log, setLog] = useState<RunLogState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [count, setCount] = useState('');
  const [hideCard, setHideCard] = useState(false);
  const load = () => { void ctx.bridge.logState().then(r => { if (r.ok) setLog(r.value); }); };
  useEffect(load, [ctx.bridge]); // eslint-disable-line react-hooks/exhaustive-deps
  const call = async (c: RunLogCall) => {
    const r = await ctx.bridge.logControl(c);
    if (r.ok) { setErr(null); setLog(r.value); } else setErr('Could not read this file. Choose Client.txt or continue manually.');
  };
  const t = log?.telemetry, confirmed = t?.context.state === 'confirmed';
  const lvl = t?.observed.characterLevel, zone = t?.observed.zoneId;
  const cov = t?.baseline.coverage ?? 'unknown';
  return <Frame title="Auto-follow" onClose={onClose} footer={<>
    <button className="run-btn" onClick={() => void call({ kind: 'stopReading' })}>Stop reading</button>
    <button className="run-btn" onClick={() => void call({ kind: 'continueManually' })}>Continue manually</button>
    <span className="run-grow" /><button className="run-btn run-primary" onClick={onClose}>Done</button></>}>
    <p>Read level, zone and atlas allocation events from Client.txt. The log stays on this PC.</p>
    <p className="run-note">Use a borderless windowed game mode. Exclusive fullscreen may hide this strip.</p>
    {!log?.filename && ctx.services.detectedLog && !hideCard && <p className="run-card">Found Client.txt: {ctx.services.detectedLog.filename}{' '}
      <button className="run-btn" onClick={() => void call({ kind: 'useDetected' })}>Use it</button> <button className="run-btn" onClick={() => setHideCard(true)}>Not now</button></p>}
    <div className="run-field">Log file <span className="run-file" title="Path stays on this PC">{log?.filename ?? 'No log file selected. Run works manually.'}</span>
      <button className="run-btn" onClick={() => void call({ kind: 'chooseFile' })}>Choose file</button></div>
    <p>Status: {logStatus(log)}{t?.observed.observedAt ? ` / Last event ${t.observed.observedAt}` : ''}</p>
    {err && <p className="run-error" role="alert">{err}</p>}
    <div className="run-field">Character {t?.context.selected ?? 'Character not confirmed'}
      {t?.context.detected && t.context.detected !== t.context.selected && <button className="run-btn" onClick={() => void call({ kind: 'selectCharacter', name: t.context.detected! })}>Use {t.context.detected}</button>}
      <button className="run-btn" onClick={() => void call({ kind: 'useNextCharacter' })}>Use next detected character</button></div>
    {t?.context.state === 'changed' && <p className="run-card">Another character was detected. Keep {t.context.selected ?? 'current'} or switch?{' '}
      <button className="run-btn" onClick={() => void call({ kind: 'resolveCharacter', choice: 'keep' })}>Keep</button>
      <button className="run-btn" onClick={() => void call({ kind: 'resolveCharacter', choice: 'switch' })}>Switch</button></p>}
    <p>Last observed: Level {lvl?.status === 'known' ? lvl.value : 'Unknown'} / {zone?.status === 'known' ? zone.value : 'Unknown zone'}</p>
    <Toggle label="Auto-follow" checked={ctx.view.state.mode === 'auto'} disabled={!log?.reading || !confirmed} onChange={on => void call({ kind: 'autoFollow', enabled: on })} />
    {!(log?.reading && confirmed) && <p className="run-note">Auto-follow turns on after a file is read and a character is confirmed.</p>}
    <p>Atlas baseline: {cov === 'unknown' ? 'Unknown' : cov === 'manual_baseline_and_deltas' ? 'Manually set' : cov === 'complete_snapshot' ? 'Complete snapshot' : 'Needs checking'}</p>
    <div className="run-field"><label>Current allocated atlas points <input type="number" min={0} value={count} onChange={e => setCount(e.target.value)} /></label>
      <button className="run-btn" disabled={count === '' || !(Number.isInteger(Number(count)) && Number(count) >= 0)} onClick={() => void call({ kind: 'setBaseline', count: Number(count) })}>Set baseline</button></div>
    <p className="run-note">{COVERAGE[cov]}</p>
  </Frame>;
}

// ---- Settings ----
export function SettingsPanel({ ctx, onClose, setPrefs }: { ctx: RunCtx; onClose(): void; setPrefs: Dispatch<SetStateAction<WindowPreferences>> }) {
  const p = ctx.prefs, chunks = ctx.view.snapshot.settings.characterChunks;
  const [drag, setDrag] = useState<number | null>(null);
  const [hk, setHk] = useState({ next: '', back: '' });
  const [hkErr, setHkErr] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  useEffect(() => { void ctx.bridge.monitors().then(r => { if (r.ok) setMonitors(r.value); }, () => undefined); }, [ctx.bridge]);
  const save = (patch: Partial<WindowPreferences>) => {
    const next = { ...p, ...patch };
    setPrefs(next); // live, reversible preview
    void ctx.bridge.saveWindowSettings(next).then(r => { if (!r.ok) setPrefs(p); else if (r.value) setPrefs(r.value); });
  };
  const moveTo = (monitorId: string) => { // the window host keeps the strip inside the chosen screen's work area
    const m = monitors.find(x => x.id === monitorId); if (!m) return;
    save({ monitorId, bounds: { ...p.bounds, x: m.workArea.x, y: m.workArea.y } });
  };
  const opacity = drag ?? p.opacity;
  useEffect(() => { // Escape during a drag restores the prior value and does not close the popover
    if (drag === null) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setDrag(null); } };
    addEventListener('keydown', h, true); return () => removeEventListener('keydown', h, true);
  }, [drag]);
  return <Frame title="Run settings" onClose={onClose} footer={<><span className="run-note">Changes save immediately.</span><span className="run-grow" /><button className="run-btn run-primary" onClick={onClose}>Done</button></>}>
    <div className="run-field">Size <Seg label="Size" value={p.size} onChange={size => save({ size, bounds: p.orientation === 'vertical' ? p.bounds : { ...p.bounds, width: WIDTH_BY_SIZE[size] } })}
      options={[{ value: 'compact', label: 'Compact' }, { value: 'standard', label: 'Standard' }, { value: 'large', label: 'Large' }]} /></div>
    <div className="run-field">Text size <Seg<26 | 32> label="Text size" value={p.textSize} onChange={textSize => save({ textSize })} options={[{ value: 26, label: '26 px' }, { value: 32, label: '32 px' }]} />
      <span className="run-note">Support text stays at 20 px or larger.</span></div>
    <label className="run-field">Opacity
      <input type="range" min={60} max={100} value={Math.round(opacity * 100)} onChange={e => setDrag(clampOpacity(Number(e.target.value) / 100))}
        onPointerUp={() => { if (drag !== null) { save({ opacity: drag }); setDrag(null); } }} onKeyUp={() => { if (drag !== null) { save({ opacity: drag }); setDrag(null); } }} />
      {Math.round(opacity * 100)}%</label>
    <Toggle label="Always on top" checked={p.alwaysOnTop} onChange={alwaysOnTop => save({ alwaysOnTop })} />
    <div className="run-field">Monitor {monitors.length > 1
      ? <select aria-label="Monitor" value={p.monitorId} onChange={e => moveTo(e.target.value)}>
        {monitors.map((m, i) => <option key={m.id} value={m.id}>{`Screen ${i + 1}${m.primary ? ' (main)' : ''}: ${m.workArea.width}x${m.workArea.height}`}</option>)}</select>
      : <span>{monitors.length === 1 ? 'Screen 1 (only screen)' : p.monitorId || 'Current'}</span>}
      {monitors.length > 1 && <button className="run-btn" onClick={() => moveTo(p.monitorId)}>Move here</button>}
      <span className="run-note">Drag the strip to place it on a screen.</span></div>
    <div className="run-field">Build chunks <Seg<'auto' | 4 | 6 | 8 | 10> label="Build chunks" value={chunks.kind === 'auto' ? 'auto' : chunks.size}
      onChange={v => void ctx.bridge.setChunks(v === 'auto' ? { kind: 'auto' } : { kind: 'fixed', size: v })}
      options={[{ value: 'auto', label: 'Auto' }, ...[4, 6, 8, 10].map(n => ({ value: n as 4 | 6 | 8 | 10, label: `Fixed ${n}` }))]} />
      <span className="run-note">Applies to future chunks only.</span></div>
    <div className="run-field">Atlas chunks <span>Per step, split every 10 allocated points</span></div>
    <Toggle label="Sound on next step" checked={p.sound} onChange={sound => save({ sound })} />
    <div className="run-field">Background <span>Still</span></div>
    <div className="run-field">Orientation <Seg label="Orientation" value={p.orientation} onChange={orientation => save({ orientation, bounds: orientation === 'vertical' ? { ...p.bounds, width: 360, height: 600 } : p.orientation === 'vertical' ? { ...p.bounds, width: WIDTH_BY_SIZE[p.size], height: horizontalHeight(ctx.view) } : p.bounds })}
      options={[{ value: 'auto', label: 'Auto' }, { value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }]} /></div>
    <Toggle label="Don't count my runs" checked={!ctx.view.countRuns} onChange={off => void ctx.bridge.setCounting(!off)} />
    <div className="run-field">Global Next/Back hotkeys {ctx.view.snapshot.settings.globalNextBackEnabled ? 'on' : 'off'}
      <input aria-label="Next hotkey" placeholder="Next, e.g. Ctrl+Alt+Right" value={hk.next} onChange={e => setHk({ ...hk, next: e.target.value })} />
      <input aria-label="Back hotkey" placeholder="Back, e.g. Ctrl+Alt+Left" value={hk.back} onChange={e => setHk({ ...hk, back: e.target.value })} />
      <button className="run-btn" disabled={!hk.next || !hk.back} onClick={() => void ctx.bridge.configureHotkeys(hk.next, hk.back).then(r => setHkErr(r.ok ? null : 'Those keys are taken or not valid.'))}>Configure</button>
      <button className="run-btn" onClick={() => void ctx.bridge.disableHotkeys()}>Disable</button></div>
    {hkErr && <p className="run-error" role="alert">{hkErr}</p>}
  </Frame>;
}
void newId;
