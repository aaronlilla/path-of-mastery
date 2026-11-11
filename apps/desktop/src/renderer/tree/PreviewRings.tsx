// Next-league preview on the tree: a dashed blue ring on every node the patch notes change, a legend card, and the note
// block the node tooltip shows (the note line and what the change does to this build).
import { useEffect, useRef, useState } from 'react';
import { engineSend, type EngineBuild } from '../engineBuild';
import { noteText, notesFor, pctChange, previewCall, usePreview } from '../preview/preview';
import type { PassiveTree } from './PassiveTree';
import { tr } from '../i18n';

export function PreviewRings({ tree }: { tree: PassiveTree | null }) {
  const pv = usePreview();
  const ids = tree && pv.on && pv.info ? Object.keys(pv.info.index.nodes).map(Number).filter((id) => !!tree.nodeById(id)) : [];
  const layer = useRef<HTMLDivElement>(null);
  const key = ids.join();

  useEffect(() => {
    if (!tree || !key) return;
    let raf = 0;
    const draw = () => {
      raf = 0;
      for (const el of layer.current?.children ?? []) {
        const n = tree.nodeById(Number((el as HTMLElement).dataset.pvNode));
        if (!n) continue;
        const [x, y] = tree.toScreen(n.x, n.y);
        const r = Math.max(9, Math.sqrt(n.rsq) * tree.view.s) + 5;
        const s = (el as HTMLElement).style;
        s.width = s.height = `${Math.round(r * 2)}px`;
        s.transform = `translate(${Math.round(x - r)}px, ${Math.round(y - r)}px)`;
      }
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(draw); };
    queue();
    tree.host.addEventListener('treepaint', queue);
    return () => {
      tree.host.removeEventListener('treepaint', queue);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [tree, key]);

  if (!tree || !ids.length) return null;
  const allocated = ids.filter((id) => tree.alloc.has(id)).length;
  const ins = tree.opts.insets ?? { left: 0, top: 0, right: 0, bottom: 0 };
  return (
    <>
      <div ref={layer} className="pv-rings" aria-hidden>
        {ids.map((id) => <i key={id} className="pv-ring" data-pv-node={id} />)}
      </div>
      <div className="pv-legend" role="note" style={{ left: ins.left + 12, top: ins.top + 10 }}>
        <span className="k"><i />{tr('tree_PreviewRings.changed_by_the_next_notes_2', { count: ids.length, next: pv.next })}{tr('tree_PreviewRings.allocated_allocated', { allocated })}</span>
        <span className="hint">{tr('tree_PreviewRings.hover_a_ringed_node_for')}</span>
      </div>
    </>
  );
}

const dpsStat = (s: Record<string, unknown>) => (Number(s.FullDPS) > 0 ? 'FullDPS' : Number(s.CombinedDPS) > 0 ? 'CombinedDPS' : 'TotalDPS');
const dpsName: Record<string, string> = { FullDPS: tr('tree_PreviewRings_2.full_dps'), CombinedDPS: tr('tree_PreviewRings_2.combined_dps'), TotalDPS: tr('tree_PreviewRings_2.hit_dps') };

/**
 * The note block for node `id`: each note line, and for an allocated node what the change does to this build's DPS
 * (the node's own share with the preview data minus its share with the live data, from both engines' remove-node diff).
 */
export function PvNodeNote({ id, alloc, eng, xml }: { id: number; alloc: boolean; eng: EngineBuild; xml: string }) {
  const pv = usePreview();
  const notes = pv.on ? notesFor(pv.info, 'node', id) : null;
  const [eff, setEff] = useState<{ text: string; good: boolean; stat: string } | null>(null);
  useEffect(() => {
    setEff(null);
    if (!notes || !alloc || !eng.buildId) return;
    let alive = true;
    const stat = dpsStat(eng.stats);
    const delta = (changed: Array<{ statId: string; before: unknown; after: unknown }>) => {
      const d = changed.find((c) => c.statId === stat);
      return d && typeof d.before === 'number' && typeof d.after === 'number' ? { before: d.before, gain: d.before - d.after } : { before: Number(eng.stats[stat]) || 0, gain: 0 };
    };
    void Promise.all([engineSend('previewNode', { buildId: eng.buildId, nodeId: id }), previewCall('previewNode', xml, { nodeId: id })])
      .then(([l, p]) => {
        if (!alive) return;
        const live = delta(l.statDiff.changed);
        const prev = delta(p.result.statDiff.changed);
        // The build's DPS with the node's preview share instead of its live share, against the live DPS.
        const c = pctChange(live.before - live.gain + prev.gain, live.before);
        setEff({ text: c?.text ?? tr('tree_PreviewRings.no_change'), good: c?.good ?? true, stat: dpsName[stat] ?? stat });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, alloc, eng.buildId, xml, !!notes]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!notes || !pv.info) return null;
  const info = pv.info;
  return (
    <div className="pv-note">
      <span className="tag">{tr('tree_PreviewRings.next_note', { next: pv.next })}</span>
      {notes.map((n, i) => <span key={i} className="ln">{noteText(info, n)}</span>)}
      <span className="eff">
        <span>{tr('tree_PreviewRings.in_this_build')}</span>
        {alloc ? eff ? <b className={eff.text === 'no change' ? '' : eff.good ? 'up' : 'down'}>{eff.text} <span style={{ fontWeight: 400, color: 'var(--text)' }}>{eff.stat}</span></b> : <b>…</b> : <b>{tr('tree_PreviewRings.not_allocated')}</b>}
      </span>
    </div>
  );
}
