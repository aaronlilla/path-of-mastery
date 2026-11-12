// The tooltip over a passive node: the node's text, what allocating or removing it changes (the engine's numbers), the
// anoint oils, the points and gold it costs, and the tips upstream prints. A jewel socket shows its jewel as an item.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ItemInfo } from '@pom/protocol';
import type { CompareLine } from '../displayStats';
import { engineSend, type EngineBuild } from '../engineBuild';
import { artFor } from '../gameArt';
import { Icon } from '../ui';
import { usePreview } from '../preview/preview';
import { PlainLines } from '../items/ItemTooltip';
import { AltHint, useAltHeld } from '../tipFrame';
import { shownLines } from '../tipLines';
import type { NodeHoverDetail } from './PassiveTreeView';
import type { PassiveTree } from './PassiveTree';
import type { JewelInfo } from './treeTypes';
import { tr } from '../i18n';

const NODE_TYPE = [tr('tree_PowerReport_2.normal'), tr('tree_PowerReport_2.notable'), tr('tree_PowerReport_2.keystone'), tr('tree_NodeTooltip.mastery'), tr('timeless_TimelessDialog.jewel_socket_2'), tr('tree_PowerReport_2.class_start'), tr('h_c_Tree.ascendancy_start')];

/** `data.goldRespecPrices`: the gold one respec point costs, by character level. */
const GOLD_RESPEC = [4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 11, 12, 14, 15, 17, 18, 20, 22, 24, 26, 28, 31, 34, 36, 39, 43, 46, 50, 54, 58, 62, 67, 72, 83, 90, 97, 105, 113, 121, 130, 151, 161, 171, 182, 209, 222, 237, 252, 267, 295, 313, 333, 354, 376, 427, 452, 482, 513, 546, 618, 656, 694, 733, 773, 816, 860, 892, 921, 1055, 1203, 1365, 1541, 1748, 1974, 2221, 2490, 2770, 3073, 3400, 3752, 4131, 4538, 4976, 5444, 5967, 6526, 7126, 7766, 8450, 9851, 11380, 13042, 14847, 16801, 18914, 21192, 23647, 26286, 29119];

/** Gold to unallocate `count` points at a character level (upstream multiplies ascendancy points by five). */
export function respecGold(level: number, count: number, ascendancy: boolean): number {
  const per = GOLD_RESPEC[Math.max(1, Math.min(GOLD_RESPEC.length, Math.floor(level))) - 1] ?? 0;
  return per * (ascendancy ? 5 : 1) * count;
}

const num = (n: number) => n.toLocaleString('en-US');

/** Space between the pointer and the tooltip, and the least space kept round the node itself. */
const POINTER_GAP = 36;
const NODE_GAP = 20;

/** The text of item `id` in the build XML (the Items tab keeps the same text). */
export function itemTextById(xml: string, id: number): string | null {
  const m = new RegExp(`<Item\\s+id="${id}"[^>]*>([\\s\\S]*?)</Item>`).exec(xml);
  if (!m) return null;
  return m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/^\s*\n/, '').trim();
}

const itemCache = new Map<string, ItemInfo>();
function useJewelItem(eng: EngineBuild, xml: string, itemId: number | undefined): ItemInfo | null {
  const [info, setInfo] = useState<ItemInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (itemId === undefined || !eng.buildId) return;
    const text = itemTextById(xml, itemId);
    if (!text) return;
    const key = eng.buildId + '|' + text;
    const hit = itemCache.get(key);
    if (hit) {
      setInfo(hit);
      return;
    }
    let live = true;
    void engineSend('itemInfo', { buildId: eng.buildId, itemText: text })
      .then((r) => {
        if (itemCache.size > 80) itemCache.clear();
        itemCache.set(key, r.item);
        if (live) setInfo(r.item);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [eng.buildId, xml, itemId]);
  return info;
}

/** The node's own icon from the tree's sprite sheet, as a CSS background (no separate image file per node exists). */
export function nodeIcon(tree: PassiveTree | null, id: number, size = 40): React.CSSProperties | undefined {
  const n = tree?.nodeById(id);
  if (!tree || !n) return undefined;
  // A mastery's art is its own sprite (the selected one when it is allocated), not the node icon fields.
  const idx = n.mastery ? (tree.alloc.has(id) && n.mastery.active >= 0 ? n.mastery.active : n.mastery.inactive) : tree.alloc.has(id) ? n.iconActive : n.iconInactive;
  const sp = idx >= 0 ? tree.data.sprites[idx] : undefined;
  if (!sp) return undefined;
  const sheet = tree.data.sheets[sp[0]!];
  if (!sheet?.file) return undefined;
  const k = size / Math.max(sp[3]!, sp[4]!);
  const base = tree.opts.base ?? '';
  return { backgroundImage: `url(${base}${sheet.file})`, backgroundSize: `${sheet.w * k}px ${sheet.h * k}px`, backgroundPosition: `${-sp[1]! * k}px ${-sp[2]! * k}px`, backgroundRepeat: 'no-repeat' };
}

/** The header colour by node kind: normal, notable, keystone, mastery, jewel socket, class start, ascendancy start. */
const NODE_RC = ['var(--rarity-normal)', 'var(--rarity-rare)', 'var(--rarity-unique)', 'var(--mod-explicit)', 'var(--gem, #1aa29b)', 'var(--rarity-normal)', 'var(--rarity-normal)'];

/** The ornate end cap of a mastery's header bar (the right one is the left one mirrored). */
const MasteryCap = ({ flip }: { flip?: boolean }) => (
  <svg className="cap" style={flip ? { transform: 'scaleX(-1)' } : undefined} width="36" height="22" viewBox="0 0 36 22" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M1 11h11" /><path d="M12 11l5.5-7 5.5 7-5.5 7z" fill="currentColor" fillOpacity=".35" /><path d="M23 11h12" /><path d="M7 6l4 5-4 5" strokeWidth="1" /></svg>
);

const oilLabel = (o: string) => o.replace(/([a-z])Oil$/, '$1 Oil').replace(/^([A-Za-z]+)Oil$/, '$1 Oil');

export function NodeTooltip({ d, lines, pathLines, blocked, host, tree, jewel, eng, xml, showDiff, traceMode, level, extra }: { d: NodeHoverDetail; lines: CompareLine[] | null; pathLines?: CompareLine[] | null; blocked: string | null; host: HTMLElement | undefined; tree: PassiveTree | null; jewel?: Record<number, JewelInfo>; eng: EngineBuild; xml: string; showDiff: boolean; traceMode: boolean; level: number; extra?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Hold Alt for the details (anoint recipe, cost, shortcuts, tips); without it the node's text and what it changes.
  const alt = useAltHeld();
  /** Counts the toasts coming and going, so the tooltip makes room for one that shows up while it is open. */
  const [toastRev, setToastRev] = useState(0);
  useEffect(() => {
    const t = document.querySelector('.toasts');
    if (!t) return;
    const mo = new MutationObserver(() => setToastRev((v) => v + 1));
    mo.observe(t, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  const n = d.node;
  const itemId = n.t === 4 ? tree?.jewels.get(d.id) : undefined;
  const item = useJewelItem(eng, xml, itemId);
  // Placed before the browser paints (a layout effect): the first frame the tooltip shows is already at the node. With a
  // passive effect it was laid out at the host's top-left corner for a frame, and the motion layer, which took that
  // corner for the tooltip's box, played its entrance and exit there.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !host) return;
    const W = host.clientWidth;
    const H = host.clientHeight;
    // Inside the free area: not under the sidebar, the tab strip or the toolbar.
    const ins = tree?.opts.insets ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const maxH = Math.max(120, H - ins.top - ins.bottom - 16);
    const maxW = W - ins.left - ins.right - 16;
    // Too tall for the free area: the longest stat list goes to more columns, as upstream's tooltip does.
    el.style.maxHeight = el.style.maxWidth = 'none';
    const lists = [...el.querySelectorAll<HTMLElement>(':scope > .diff')];
    for (const l of lists) l.style.columnCount = '';
    el.removeAttribute('data-dense');
    while (el.offsetHeight > maxH && lists.length) {
      const l = lists.reduce((a, b) => (b.offsetHeight > a.offsetHeight ? b : a));
      const n = (Number(l.style.columnCount) || 1) + 1;
      l.style.columnCount = String(n);
      if (n > 4 || el.offsetWidth > maxW) {
        l.style.columnCount = n > 2 ? String(n - 1) : '';
        break;
      }
    }
    if (el.offsetHeight > maxH) el.setAttribute('data-dense', '');
    el.style.maxWidth = `${maxW}px`;
    // Never taller than the free area: what still does not fit shrinks (tree.css), the name, the points and gold to
    // refund and the shortcuts always show. Before, a long allocated-node tooltip ran past the window's bottom.
    el.style.maxHeight = `${maxH}px`;
    // Each shrinking panel keeps a readable minimum height, so several of them (an anoint recipe and two change panels on
    // a notable) can still push the footer out at 800x600. Then whole panels fold away, least needed first (anoint
    // recipe, the dependents' change, the node's own change, ...), until the footer (points, gold, shortcuts) fits.
    const panels = [...el.querySelectorAll<HTMLElement>(':scope > :is(.diff, .opts, .mods, .jw-item, .oils)')];
    for (const p of panels) p.removeAttribute('data-fold');
    const foot = el.querySelector<HTMLElement>(':scope > .foot');
    if (foot) {
      const rank = (p: HTMLElement) => (p.matches('.oils') ? 0 : p.matches('.diff') ? 1 : p.matches('.jw-item') ? 2 : p.matches('.opts') ? 3 : 4);
      const order = panels.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || b.i - a.i).map((x) => x.p);
      const padB = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      for (const p of order) {
        if (foot.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom - padB + 0.5) break;
        p.setAttribute('data-fold', '');
      }
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    for (const d of panels) d.toggleAttribute('data-cut', d.scrollHeight > d.clientHeight + 1);
    // Beside the pointer and clear of the node, on the right if it fits, else the left, else whichever side has more room.
    const px = d.cx ?? d.sx;
    const right = Math.max(px + POINTER_GAP, d.sx + d.r + NODE_GAP);
    const leftOf = Math.min(px - POINTER_GAP, d.sx - d.r - NODE_GAP) - w;
    const minX = ins.left + 8;
    const maxX = W - ins.right - w - 8;
    let left = right <= maxX ? right : leftOf;
    let top = (d.cy ?? d.sy) - 20;
    // No room on either side (a small window, a very long list): below the node, above it, else hard against the roomier side.
    if (right > maxX && leftOf < minX) {
      const below = d.sy + d.r + NODE_GAP;
      const above = d.sy - d.r - NODE_GAP - h;
      const fitsBelow = below + h <= H - ins.bottom - 8;
      if (fitsBelow || above >= ins.top + 8) {
        left = Math.max(minX, Math.min(maxX, d.sx - w / 2));
        top = fitsBelow ? below : above;
      } else left = right - maxX < minX - leftOf ? maxX : minX;
    }
    // Never over a toast (its text and its Undo button): the tooltip stops above the toasts it would cover sideways.
    const hr = host.getBoundingClientRect();
    let limit = H - ins.bottom - 8;
    for (const t of document.querySelectorAll('.toasts .toast')) {
      const r = t.getBoundingClientRect();
      if (r.width && r.right > hr.left + left - 8 && r.left < hr.left + left + w + 8) limit = Math.min(limit, r.top - hr.top - 8);
    }
    top = Math.max(ins.top + 8, Math.min(top, limit - h));
    setPos({ left, top });
  }, [d, lines, pathLines, host, blocked, item, showDiff, toastRev, alt]);
  const eff = tree?.masteries.get(d.id);
  const mastery = n.me;
  const ji = jewel?.[d.id];
  // Preview on: a node the patch notes change reads as it will in the next patch.
  const pv = usePreview();
  const pvLines = pv.on && !mastery ? pv.info?.index.nodeText?.[String(d.id)] : undefined;
  const statLines = pvLines ?? (eff !== undefined && mastery ? mastery.find((m) => m.e === eff)?.s ?? [] : mastery ? [] : n.s);
  const node = tree?.nodeById(d.id);
  const oils = node?.recipe;
  const points = d.alloc ? d.dependents.length + 1 : d.path.length;
  const gold = d.alloc ? respecGold(level, d.dependents.length + 1, !!n.a) : 0;
  const tattoo = !!tree?.overrides.get(d.id)?.tattoo;
  // The stat numbers line up in one column, so the eye runs down them.
  const valueWidth = Math.max(0, ...(lines ?? []).map((l) => l.value.length), ...(pathLines ?? []).map((l) => l.value.length));
  const editable = !n.a && (tattoo || n.t === 2 || (n.t === 0 && /^(Strength|Dexterity|Intelligence)$/.test(n.n)) || (n.t === 1 && /^\+30 to (Strength|Dexterity|Intelligence)/.test(n.s[0] ?? '')));
  return (
    <div ref={ref} className={n.t === 3 ? 'tt-tip mastery' : 'tt-tip'} role="tooltip" data-lg="pop" data-solid="" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', ['--tt-rc' as string]: NODE_RC[n.t], ['--tt-vw' as string]: `${valueWidth}ch` }}>
      <div className="head tt-band">
        {n.t === 3 && <MasteryCap />}
        {n.t === 3 ? <div className="t"><span className="nm">{n.n || NODE_TYPE[n.t]}</span><span className="kind">{tr('tree_NodeTooltip.mastery')}</span></div> : <span className="nm">{n.n || NODE_TYPE[n.t]}</span>}
        {n.t === 3 && <MasteryCap flip />}
      </div>
      {n.t === 4 && (item ? <div className="jw-item"><PlainLines lines={shownLines(item.lines, alt)} /></div> : ji ? <div className="jw"><b>{ji.title}</b><span>{ji.base}{ji.radius ? tr('tree_NodeTooltip.radius_radius', { radius: ji.radius }) : ''}</span></div> : null)}
      {statLines.length > 0 && (
        <div className="mods" data-pv-text={pvLines ? '' : undefined}>
          {statLines.map((s, i) => <div key={i}>{s}</div>)}
        </div>
      )}
      {n.t === 3 && mastery && eff === undefined && (
        <div className="opts">
          <div className="cap">{tr('tree_NodeTooltip.available_mastery_node_options_are')}</div>
          {mastery.map((m) => (
            <div key={m.e} className="opt">{m.s.map((l, i) => <div key={i}>{l}</div>)}</div>
          ))}
        </div>
      )}
      {n.t === 3 && !mastery && statLines.length === 0 && <div className="mods" style={{ color: 'var(--text-muted)' }}>{tr('tree_NodeTooltip.this_mastery_has_no_effects')}</div>}
      {alt && oils && oils.length > 0 && (
        <div className="oils" aria-label={tr('tree_NodeTooltip.anoint_recipe')}>
          <span className="cap"><Icon name="sparkle" size={12} />{tr('tree_NodeTooltip.anoint_on_an_amulet_with')}</span>
          <div className="row">
            {oils.map((o, i) => {
              const src = artFor(oilLabel(o));
              return <span key={i} className="oil">{src && <img src={src} alt="" />}{oilLabel(o)}</span>;
            })}
          </div>
        </div>
      )}
      {alt && n.a && <div className="asc">{tr('tree_NodeTooltip.ascendancy_a', { a: n.a })}</div>}
      {alt && blocked === 'OtherAscendancy' && <div className="note">{tr('tree_NodeTooltip.another_ascendancy_clicking_changes_')}</div>}
      {showDiff && lines !== null && lines.length > 0 && (
        <div className="diff">
          <div className="cap">{d.alloc ? tr('tree_NodeTooltip.unallocating_this_node_will_give') : tr('tree_NodeTooltip.allocating_this_node_will_give')}</div>
          {lines.map((l) => (
            <div key={l.key} className={l.good ? 'up' : 'down'}><span className="v">{l.value}</span> {l.label}{l.percent}</div>
          ))}
        </div>
      )}
      {showDiff && pathLines && pathLines.length > 0 && (
        <div className="diff">
          <div className="cap">{d.alloc ? tr('tree_NodeTooltip.unallocating_this_node_and_all') : tr('tree_NodeTooltip.allocating_this_node_and_all')}</div>
          {pathLines.map((l) => (
            <div key={l.key} className={l.good ? 'up' : 'down'}><span className="v">{l.value}</span> {l.label}{l.percent}{l.perPoint ? <span className="pp"> {l.perPoint}</span> : null}</div>
          ))}
        </div>
      )}
      {showDiff && lines !== null && lines.length === 0 && (!pathLines || pathLines.length === 0) && !blocked && n.t !== 3 && (
        <div className="diff"><div className="cap">{tr(`h_c_Tree.${d.alloc ? 'nc_un' : 'nc_al'}${(d.alloc ? d.dependents.length > 0 : d.path.length > 1) ? '_path' : ''}`)}</div></div>
      )}
      {alt && editable && <div className="tip">{tr('tree_NodeTooltip.right_click_to_edit_the')} {tattoo || n.t !== 3 ? tr('tree_NodeTooltip.tattoo') : tr('tree_NodeTooltip.runegraft')} {tr('tree_NodeTooltip.for_this_node')}</div>}
      {alt && !showDiff && <div className="tip">{tr('tree_NodeTooltip.stat_changes_are_off_press')}</div>}
      {(alt || pv.on) && extra}
      <div className="foot">
        <div className="l">
          {d.alloc ? (
            <>
              {points > 1 && <span className="pts">{tr('tree_NodeTooltip.points_points_gained_from_unallocati', { points })}</span>}
              {alt && <span className="gold">{tr('tree_NodeTooltip.gold_gold', { gold: num(gold) })} <span className="rest">{tr('tree_NodeTooltip.required_to_unallocate')} {points > 1 ? tr('tree_NodeTooltip.these_nodes') : tr('tree_NodeTooltip.this_node')}</span></span>}
            </>
          ) : traceMode && points > 0 ? (
            <span className="pts">{tr('tree_NodeTooltip.points_nodes_in_trace_path', { points })}</span>
          ) : points > 0 ? (
            <>
              <span className="pts">{tr('tree_NodeTooltip.count_points', { count: points })} {tr('tree_NodeTooltip.to_node')}</span>
              {alt && points > 1 && <span className="hint">{tr('tree_NodeTooltip.hold_shift_then_trace_the')}</span>}
            </>
          ) : null}
        </div>
        {alt && (
          <div className="keys">
            <span><kbd>{n.t === 4 ? tr('h_c_Tree.key_shift') : tr('h_c_Tree.key_ctrl')}</kbd> {tr('tree_NodeTooltip.hide')}</span>
            {n.t !== 4 && <span><kbd>{tr('h_c_Tree.kbd_copy')}</kbd> {tr('tree_NodeTooltip.copy')}</span>}
            <span><kbd>{tr('h_c_Tree.kbd_stats')}</kbd> {tr('tree_NodeTooltip.stats')}</span>
          </div>
        )}
        {!alt && <AltHint />}
      </div>
    </div>
  );
}
