import type { BuildEdit, GemTip, ItemInfo } from '@pom/protocol';
import { portal } from '../Freeze';
import { AltHint, useAltHeld } from '../tipFrame';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { readItems } from '../../shared/itemsXml';
import type { EngineHandle } from '../engineHandle';
import { GemTooltipView, ItemTooltip } from '../items/ItemTooltip';
import { compareLines, skillKindOf, type CompareLine } from '../items/statCompare';
import '../items/items.css';
import { PvNoteBox } from '../preview/PreviewControls';
import { previewCall, usePreview } from '../preview/preview';
import type { PreviewNote } from '../../shared/preview.js';
import { tr } from '../i18n';

/** A run of tooltip text; `c` is a CSS colour. */
export interface TipSeg {
  t: string;
  c?: string;
}

/** What a Skills tab tooltip shows, top to bottom. Every part is optional. */
export interface SkillTip {
  /** The skill's own tooltip from the engine (`gemTip`). */
  gem?: { skillId: string; level: number };
  /** Lines of the group tooltip, drawn above the skill. */
  group?: TipSeg[][];
  /** Plain lines in the muted colour. */
  notes?: string[];
  /** Stat changes an edit would make, under a heading ("Selecting this gem will give you:"). */
  compare?: { header: string; edit: BuildEdit };
  /** An item's tooltip, read when the tip opens (the "Socketed in" menu rows). */
  item?: () => Promise<ItemInfo | null>;
  /** F1 while the tip is open opens this page. */
  wiki?: string;
}

type TipSource = SkillTip | null | (() => SkillTip | null);

interface Loaded {
  gem: GemTip | null | 'none';
  item: ItemInfo | null | 'none';
  compare: CompareLine[] | null;
}

/** The pointer handlers that make an element show a tip. */
export type TipBind = Pick<HTMLAttributes<HTMLElement>, 'onMouseEnter' | 'onMouseLeave' | 'onMouseDown'>;

/**
 * One hover tooltip for the Skills tab: the engine's skill tooltip, the group notes and a "will give you" block of stat
 * changes, drawn beside the element after a short rest of the pointer.
 */
export function useSkillTips(engine: EngineHandle | null, xml?: string): { bind: (src: TipSource) => TipBind; node: ReactNode; hide: () => void } {
  const [tip, setTip] = useState<{ spec: SkillTip; rect: DOMRect; pv?: PreviewNote[] | null } | null>(null);
  // Preview on: a gem the patch notes change shows the preview engine's tooltip and its notes.
  const pv = usePreview();
  const pvRef = useRef({ pv, xml });
  pvRef.current = { pv, xml };
  const [loaded, setLoaded] = useState<Loaded>({ gem: null, item: null, compare: null });
  const timer = useRef<number>(0);
  const live = useRef(0);
  const engRef = useRef(engine);
  engRef.current = engine;

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    live.current += 1;
    setTip(null);
  }, []);

  const show = useCallback((el: Element, src: TipSource) => {
    window.clearTimeout(timer.current);
    const mine = ++live.current;
    const rect = el.getBoundingClientRect();
    timer.current = window.setTimeout(() => {
      if (mine !== live.current) return;
      const spec = typeof src === 'function' ? src() : src;
      const eng = engRef.current;
      if (!spec) return;
      const { pv: p, xml: x } = pvRef.current;
      const pvNotes = spec.gem && p.on && x ? p.info?.index.gems[spec.gem.skillId] ?? null : null;
      setTip({ spec, rect, pv: pvNotes });
      setLoaded({ gem: spec.gem ? null : 'none', item: spec.item ? null : 'none', compare: null });
      if (spec.gem && eng) {
        const g = spec.gem;
        (pvNotes ? previewCall('gemTip', x!, { skillId: g.skillId, level: g.level }).then((r) => r.result) : eng.call('gemTip', { skillId: g.skillId, level: g.level }))
          .then((r) => mine === live.current && setLoaded((l) => ({ ...l, gem: r.tip })))
          .catch(() => mine === live.current && setLoaded((l) => ({ ...l, gem: 'none' })));
      }
      if (spec.item) {
        spec
          .item()
          .then((i) => mine === live.current && setLoaded((l) => ({ ...l, item: i ?? 'none' })))
          .catch(() => mine === live.current && setLoaded((l) => ({ ...l, item: 'none' })));
      }
      const cmp = spec.compare;
      if (cmp && eng) {
        void (async () => {
          try {
            const [stats, r] = await Promise.all([eng.call('getStats'), eng.call('previewEdit', { edit: cmp.edit, full: true })]);
            if (mine !== live.current) return;
            const kind = skillKindOf(Object.fromEntries(stats.stats.map((x) => [x.id, x.value])));
            setLoaded((l) => ({ ...l, compare: compareLines(r.statDiff.changed, kind) }));
          } catch {
            if (mine === live.current) setLoaded((l) => ({ ...l, compare: [] }));
          }
        })();
      }
    }, 150);
  }, []);

  const bind = useCallback(
    (src: TipSource): TipBind => ({
      onMouseEnter: (e) => show(e.currentTarget, src),
      onMouseLeave: hide,
      onMouseDown: hide,
    }),
    [show, hide],
  );

  // F1 over a gem opens its page on the wiki (`itemLib.wiki`).
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so these keys only act on the tab on screen.
  useLayoutEffect(() => {
    const url = tip?.spec.wiki;
    if (!url) return;
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'F1') return;
      e.preventDefault();
      void window.pom.app.openExternal(url);
    };
    window.addEventListener('keyup', up);
    return () => window.removeEventListener('keyup', up);
  }, [tip]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so it only listens for the tab on screen.
  useLayoutEffect(() => {
    const k = () => hide();
    window.addEventListener('blur', k);
    document.addEventListener('scroll', k, true);
    return () => {
      window.removeEventListener('blur', k);
      document.removeEventListener('scroll', k, true);
    };
  }, [hide]);

  const node = tip ? <TipPortal spec={tip.spec} rect={tip.rect} loaded={loaded} pv={tip.pv ?? null} /> : null;
  return { bind, node, hide };
}

function Segs({ line }: { line: TipSeg[] }) {
  return (
    <div className="it-tt-line">
      {line.map((s, i) => (
        <span key={i} style={s.c ? { color: s.c } : undefined}>
          {s.t}
        </span>
      ))}
    </div>
  );
}

function TipPortal({ spec, rect, loaded, pv }: { spec: SkillTip; rect: DOMRect; loaded: Loaded; pv: PreviewNote[] | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Hold Alt for the group notes, the tips and the preview notes; without it the skill card and the stat changes.
  const alt = useAltHeld();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 10;
    let left = rect.right + gap;
    if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - gap - w);
    // A tip that cannot sit beside a wide element goes under it.
    if (left < rect.right && left + w > rect.left) left = Math.min(Math.max(8, rect.left), window.innerWidth - 8 - w);
    let top = rect.top;
    if (left >= rect.right || left + w <= rect.left) {
      if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - h);
    } else {
      top = rect.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - 6 - h);
    }
    setPos({ left, top });
  }, [rect, spec, loaded, alt]);
  const lines = loaded.compare;
  const compare = spec.compare ? (
    <div className="it-tt-cmp">
      {lines === null ? (
        <div className="c" style={{ color: 'var(--text-faint)' }}>{tr('skills_skillTips.calculating')}</div>
      ) : lines.length === 0 ? (
        <>
          <div className="h">{spec.compare.header}</div>
          <div className="c" style={{ color: 'var(--text-faint)' }}>{tr('skills_skillTips.no_changes_to_the_build')}</div>
        </>
      ) : (
        <>
          <div className="h">{spec.compare.header}</div>
          <div className={lines.length > 14 ? 'cols' : undefined}>
            {lines.map((l) => (
              <div key={l.stat} className={'c ' + (l.good ? 'good' : 'bad')}>
                {l.text}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  ) : null;
  const gem = loaded.gem && loaded.gem !== 'none' ? loaded.gem : null;
  const item = loaded.item && loaded.item !== 'none' ? loaded.item : null;
  const noItem = spec.item && loaded.item === 'none';
  // With a skill card, the group and the notes are extra; without one they are the tooltip.
  const plain = !spec.gem || alt;
  // The Alt hint sits inside the last card shown.
  const hint = alt ? null : <AltHint />;
  const hintIn = compare ? 'compare' : gem ? 'gem' : item ? 'item' : 'none';
  const body = (
    <>
      {spec.group && plain && (
        <div className="it-tt gem sk-tt-group" data-lg="pop" data-solid="" style={{ textAlign: 'left' }}>
          {spec.group.map((l, i) => (l.length ? <Segs key={i} line={l} /> : <div key={i} className="it-tt-sep" />))}
          {!gem && !compare && spec.notes?.map((n, i) => <div key={i} className="it-tt-line" style={{ color: 'var(--text-muted)' }}>{n}</div>)}
        </div>
      )}
      {gem && (
        <div className={spec.group ? 'sk-tt-gap' : undefined}>
          <GemTooltipView tip={gem} detail={alt} extra={hintIn === 'gem' ? hint : null} />
          {pv && <div className="it-tt" data-lg="pop" data-solid="" style={{ textAlign: 'left', marginTop: 6 }}><PvNoteBox notes={pv} /></div>}
        </div>
      )}
      {item && <ItemTooltip info={item} detail={alt} extra={hintIn === 'item' ? hint : null} />}
      {(spec.notes && !spec.group && plain) || noItem ? (
        <div className="it-tt" data-lg="pop" data-solid="" style={{ textAlign: 'left' }}>
          {spec.notes?.map((n, i) => (
            <div key={i} className="it-tt-line" style={{ color: 'var(--text-2)' }}>{n}</div>
          ))}
          {noItem && <div className="it-tt-line" style={{ color: 'var(--text-2)' }}>{tr('skills_skillTips.no_item_is_equipped_in')}</div>}
        </div>
      ) : null}
      {compare && (
        <div className="it-tt sk-tt-cmp" data-lg="pop" data-solid="" style={{ minWidth: 0 }}>
          {compare}
          {hintIn === 'compare' && hint}
        </div>
      )}
      {hintIn === 'none' && hint && <div className="it-tt sk-tt-alt" data-lg="pop" data-solid="">{hint}</div>}
    </>
  );
  return portal(
    <div ref={ref} className="it-tt-pop sk-tt-pop" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      {body}
    </div>,
    document.body,
  );
}

/** The text of an item in the open build, read by id from the build's own text, as the engine's item tooltip takes it. */
export async function loadItemInfo(engine: EngineHandle, itemId: number): Promise<ItemInfo | null> {
  const { buildXml } = await engine.call('getBuildXml');
  const text = readItems(buildXml).items.find((i) => i.id === itemId)?.text;
  if (!text) return null;
  const r = await engine.call('itemInfo', { itemText: text });
  return r.item;
}
