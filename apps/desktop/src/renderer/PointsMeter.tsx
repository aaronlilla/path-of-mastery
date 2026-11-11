import { useLayoutEffect, useRef } from 'react';
import { reducedMotion, springEase } from './tree/treeFx';
import { pointsReadout, type PointsCount } from '../shared/pointsReadout.js';
import { PointsTip } from './HeaderClassMenu';
import type { TreeInfo } from './TreeTab';
import { fromMain, tr } from './i18n';

const counts = (i: TreeInfo | null): PointsCount | null => (i ? { used: i.used, usedMax: i.usedMax, asc: i.asc, ascMax: i.ascMax } : null);

/** A number whose changed digits roll in (smooth 260, glass spring, 24 ms apart from the right); reduced motion: a 120 ms fade. */
function Roll({ text }: { text: string }) {
  const el = useRef<HTMLElement | null>(null);
  const prev = useRef(text);
  useLayoutEffect(() => {
    const old = prev.current;
    prev.current = text;
    const root = el.current;
    if (!root || old === text) return;
    const up = Number(text) > Number(old);
    const red = reducedMotion();
    const spans = [...root.children] as HTMLElement[];
    const n = spans.length;
    spans.forEach((c, i) => {
      const oc = old[old.length - (n - i)];
      if (oc === c.textContent) return;
      const k = n - 1 - i; // digits from the right
      if (red) c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease' });
      else c.animate([{ transform: `translateY(${up ? 55 : -55}%)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 260, delay: Math.min(k, 8) * 24, easing: springEase('glass'), fill: 'backwards' });
    });
  }, [text]);
  return (
    <b ref={el} aria-label={text}>
      {[...text].map((ch, i) => <span key={text.length - i} aria-hidden="true" style={{ display: 'inline-block' }}>{ch}</span>)}
    </b>
  );
}

/** The header's points tile, as the design draws it: "used / max" for Passives and Ascendancy, each with a thin fill bar and no labels (what is left is in the hover tip and the title; red when over). */
export function HeaderPoints({ info }: { info: TreeInfo | null }) {
  const r = pointsReadout(counts(info));
  const split = (label: string) => {
    const [used, max] = label.split(' / ');
    return (<><Roll text={used ?? ''} /><span className="bw-pm-max">/ {max}</span></>);
  };
  return (
    <div className="bw-pm-tile" data-lg="tile" role="group" aria-label={tr('PointsMeter.skill_points')}>
      <PointsTip info={info}>
        <span className={'bw-pm-blk' + (r.passiveOver ? ' over' : '')} tabIndex={0} aria-label={tr('PointsMeter.passives_passivelabel_passiveleft', { passiveLabel: r.passiveLabel, passiveLeft: fromMain('pointsReadout', r.passiveLeft) })}>
          <span className="bw-pm-row">{split(r.passiveLabel)}<span className="bw-pm-lbl" aria-hidden="true">{tr('PointsMeter.passives')}</span></span>
          <i className="bw-pm-bar"><u style={{ transform: `scaleX(${r.passiveFill})` }} /></i>
        </span>
      </PointsTip>
      <span className={'bw-pm-blk asc' + (r.ascOver ? ' over' : '')} title={tr('PointsMeter.ascendancy_points_asclabel_ascleft', { ascLabel: r.ascLabel, ascLeft: fromMain('pointsReadout', r.ascLeft) })}>
        <span className="bw-pm-row">{split(r.ascLabel)}<span className="bw-pm-lbl" aria-hidden="true">{tr('PointsMeter.asc')}</span></span>
        <i className="bw-pm-bar"><u style={{ transform: `scaleX(${r.ascFill})` }} /></i>
      </span>
    </div>
  );
}
