import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { RunReply } from '../../shared/run/bridge.js';
import type { RunView } from '../../shared/run/types.js';
import type { RunCtx } from './RunApp';
import { buttonOf, keyCommand, pointerDown, pointerUp, stripModel, surfaceOf } from './presenter';

export function Strip({ ctx, panelOpen, onClose, rehomed, onReply }: { ctx: RunCtx; panelOpen: boolean; onClose(): void; rehomed: boolean; onReply(reply: RunReply<RunView | null>): void }) {
  const v = ctx.view, m = stripModel(v, ctx.meta);
  const down = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState(false);
  const onDown = (e: ReactPointerEvent) => {
    if (panelOpen) return;
    const p = pointerDown(e.button, e.clientX, e.clientY, surfaceOf(e.target as Element));
    if (!p) return;
    down.current = { id: p.gestureId, x: e.clientX, y: e.clientY, moved: false };
    void ctx.bridge.command(p.command).then(r => onReply(r));
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = down.current; if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) d.moved = true;
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = down.current; if (!d) return; down.current = null;
    void ctx.bridge.command(pointerUp(d.id, e.clientX, e.clientY, d.moved)).then(r => onReply(r));
  };
  const onCancel = () => { if (down.current) { down.current = null; void ctx.send({ kind: 'cancelPointer' }); } };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const k = keyCommand(v, { key: e.key, repeat: e.repeat, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey }, /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (!k || panelOpen) return;
    e.preventDefault();
    if (typeof k === 'object') void ctx.send(k as never);
    else if (k === 'position') ctx.open('menu'); else if (k === 'log') ctx.open('log'); else if (k === 'settings') ctx.open('settings');
    else if (k === 'close') void ctx.bridge.close(); else if (k === 'escape') void ctx.send({ kind: 'pause' });
  };
  // Escape closes the top panel first.
  useEffect(() => {
    if (!panelOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    addEventListener('keydown', h); return () => removeEventListener('keydown', h);
  }, [panelOpen, onClose]);
  const paused = m.modeKey === 'paused';
  return <div className="run-strip" data-multi={m.lanes.length > 1 ? '1' : '0'}>
    <div className="run-chrome" data-run-chrome>
      <span className="run-drag" title="Drag to move" aria-hidden>::</span>
      <span className="run-title" title={m.title}>{m.title}</span>
      <span className="run-meta">{m.league}</span>
      <span className="run-meta run-progress">{m.game} / {m.guide}{m.atlas ? ` / ${m.atlas}` : ''}</span>
      <span className="run-mode" data-mode={m.modeKey}>{m.mode}</span>
      <span className="run-grow" />
{m.pending > 0 && <button className="run-chip run-more" onClick={() => ctx.open('details', { tab: 'missed' })}>More actions ({m.pending})</button>}
      <button className="run-btn" onClick={() => ctx.open('menu')} aria-haspopup="dialog">Menu</button>
      <button className="run-btn" onClick={() => void ctx.send({ kind: paused ? 'resumePresentation' : 'pause' })}>{paused ? 'Resume' : 'Pause'}</button>
      <button className="run-btn run-x" aria-label="Close Run" title="Close Run" onClick={() => void ctx.bridge.close()}>X</button>
    </div>
    {(m.catchUp || rehomed || ctx.error) && <div className="run-notes" data-run-chrome>
      {rehomed && <span className="run-chip">Monitor unavailable. Run moved to this screen.</span>}
      {ctx.error && <span className="run-chip run-error" role="alert">{ctx.error} <button className="run-link" onClick={() => void ctx.bridge.retry().then(r => onReply(r))}>Retry</button></span>}
      {m.catchUp && <span className="run-chip">{m.catchUp.passed} <button className="run-link" onClick={() => void ctx.send({ kind: 'catchUp', choice: 'review' })}>Review</button>
        <button className="run-link" onClick={() => void ctx.send({ kind: 'catchUp', choice: 'keep' })}>Keep position</button>
        <button className="run-link" onClick={() => void ctx.send({ kind: 'catchUp', choice: 'catch_up' })}>Catch up</button></span>}
    </div>}
    <div className="run-surface" role="button" tabIndex={0} data-hover={hover ? '1' : '0'} aria-label={`Next. ${m.acknowledges}`}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}
      onContextMenu={e => e.preventDefault()} onAuxClick={e => { if (buttonOf(e.button)) e.preventDefault(); }} onKeyDown={onKey}>
        <div className="run-ack"><span>{m.acknowledges}{m.reviewing ? ' - Reviewing previous step' : ''}</span><span className="run-hint">{m.hint}</span></div>
      {m.empty ? <div className="run-lane"><span className="run-lane-label">{m.empty}</span></div> : m.lanes.map(l => <div className="run-lane" key={l.type} data-critical={l.critical ? '1' : '0'}>
        <span className="run-lane-label">{l.label}{l.range ? ` / ${l.range}` : ''}</span>
        <span className="run-lane-text"><span className="run-first">{l.firstAction}</span>{l.support && <span className="run-support">{l.support}</span>}
          {l.moreInLane > 0 && <span className="run-support">+{l.moreInLane} more in {l.label}</span>}</span>
      </div>)}
      {m.queued && <div className="run-support run-queued">{m.queued}</div>}
    </div>
  </div>;
}
