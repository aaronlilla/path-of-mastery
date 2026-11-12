import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { portal } from '../Freeze';
import type { CalcDetail, CalcModRow, CalcModTable, ItemInfo } from './types';
import type { TreeState } from '../tree';
import { PassiveTreeView } from '../tree';
import { breakdownBlocks, formatNumSep, groupsDigits, lookupBreakdown, modValueTone, type NumFormat, type PopupBlock, type SlotItems } from '../../shared/calcsLogic';
import { artFor } from '../gameArt';
import { RARITY_COLOUR, gemColour, useGameInfo } from '../gameData';
import { ItemTooltip } from '../items/ItemTooltip';
import { ColorText } from '../ColorText';
import { AltHint, useAltHeld } from '../tipFrame';
import { Icon } from '../ui';
import { NodeIcon } from './NodeIcon';
import { label as lbl, tr } from '../i18n';

/** The tree node kinds (English, from the tree data) in the current language. */
const KIND_WORD: Record<string, string> = { Passive: tr('compare_PowerTable.passive'), 'Notable Passive': tr('h_c_Tree.notable_passive'), Notable: tr('tree_PowerReport_2.notable'), Keystone: tr('tree_PowerReport_2.keystone'), Mastery: tr('tree_NodeTooltip.mastery'), 'Jewel Socket': tr('timeless_TimelessDialog.jewel_socket_2') };

export interface PopupTarget {
  /** The cell the popup belongs to. */
  key: string;
  pinned: boolean;
  /** Where the cell and its card are (viewport pixels). */
  cell: DOMRect;
  card: DOMRect;
  title: string;
  /** The cell's own number, drawn in the short card. */
  text?: string;
  details: CalcDetail[];
}

export interface PopupEnv {
  /** The engine's breakdown tables of the shown actor. */
  tables: Record<string, unknown> | null;
  loadMods: (d: CalcDetail) => Promise<CalcModTable | null>;
  slotItem: SlotItems;
  /** An item of the build by id: its rarity, and its tooltip once asked for. */
  itemRarity: (id: number) => string | null;
  loadItem: (id: number) => Promise<ItemInfo | null>;
  treeVersion: string;
  /** A passive node of the build by id: name, type, ascendancy, icon in the tree's sheet and its stat lines. */
  node: (id: number) => { n: string; t: string; a?: string; sp?: [number, number, number]; stats?: string[] } | undefined;
  /** The build's tree (what the location viewer draws), when it has been read. */
  treeState: TreeState | null;
  fmt: NumFormat;
}

/** What a hover on a source row shows beside the popup. */
export interface TipState {
  rect: DOMRect;
  info: ItemInfo | null;
  text?: string;
  /** A passive node: its tooltip and where it sits on the tree. */
  node?: { id: number; name: string; kind: string; asc?: string; stats: string[]; version: string; state: TreeState | null };
}

/** The popup: the formula lines, tables and per-source modifier rows upstream's breakdown control shows for a cell. */
export function Popup({ target, env, onClose, onKeep, onLeave }: { target: PopupTarget; env: PopupEnv; onClose: () => void; onKeep: () => void; onLeave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [blocks, setBlocks] = useState<PopupBlock[] | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number; w: number } | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  // Without Alt (and not pinned) a hover shows a short card; Alt or a click opens the breakdown.
  const full = useAltHeld() || target.pinned;

  // The blocks of every entry, in order: a breakdown table by key, or the modifiers of a stat.
  const detailsKey = JSON.stringify(target.details);
  useEffect(() => {
    let live = true;
    setBlocks(null);
    void (async () => {
      const out: PopupBlock[] = [];
      for (const d of target.details) {
        if (d.breakdown && d.breakdown !== 'SkillBuffs' && d.breakdown !== 'SkillDebuffs') out.push(...breakdownBlocks(lookupBreakdown(env.tables, d.breakdown), d, env.slotItem));
        else if (d.modName || d.breakdown) {
          const t = await env.loadMods(d).catch(() => null);
          if (t && t.rows.length > 0) out.push({ kind: 'mods', table: { ...t, label: t.label ?? d.label ?? null } });
        }
      }
      if (live) setBlocks(out);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsKey, env.tables]);

  // Place beside the card (right, else left), else under or over the cell, kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = full ? Math.min(640, W - 24) : 280;
    const c = target.card;
    const a = target.cell;
    let left: number;
    let side = true;
    if (c.right + 10 + w <= W - 8) left = c.right + 10;
    else if (c.left - 10 - w >= 8) left = c.left - 10 - w;
    else {
      side = false;
      left = Math.max(8, Math.min(c.left, W - w - 8));
    }
    const h = Math.min(el.scrollHeight, H - 16);
    let top: number;
    if (side) top = a.top > H * 0.55 ? Math.max(8, a.bottom - h + 24) : Math.max(8, a.top - 24);
    else top = H - a.bottom < Math.min(h, 260) && a.top > H - a.bottom ? Math.max(8, a.top - 6 - h) : a.bottom + 6;
    top = Math.max(8, Math.min(top, H - h - 8));
    setPos({ left, top, maxH: H - top - 8, w });
  }, [target.cell, target.card, blocks, full]);

  const fmt = (s: string) => formatNumSep(s, env.fmt);
  const empty = blocks !== null && blocks.length === 0;
  // Upstream shows nothing for a number with no breakdown.
  useEffect(() => {
    if (empty) onClose();
  }, [empty]); // eslint-disable-line react-hooks/exhaustive-deps

  return portal(
    <div
      ref={ref}
      className={'calc-bd' + (full ? '' : ' calc-short')}
      role="dialog"
      aria-label={target.title}
      data-bd="1"
      data-lg="pop"
      data-solid=""
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: pos?.w ?? 600, maxHeight: pos?.maxH, visibility: pos && !empty ? 'visible' : 'hidden' }}
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
    >
      {!full && (
        <>
          <div className="tt-band col"><span className="ttl">{target.title}</span></div>
          {target.text && <div className="short-v">{target.text}</div>}
          <AltHint />
        </>
      )}
      {full && <div className="hd">
        <span className="ttl" title={target.title}>{target.title}</span>
        <span className="hint">{target.pinned ? tr('calcs_Popup_2.esc_to_close') : tr('calcs_Popup.click_to_pin_esc_to')}</span>
        {target.pinned && (
          <button type="button" className="x" aria-label={tr('calcs_Popup.close_breakdown')} onClick={onClose}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>}
      {full && blocks === null && <div className="note">{tr('calcs_Popup.reading_the_calculation')}</div>}
      {full && blocks?.map((b, i) => (
        <BlockView key={i} block={b} fmt={fmt} env={env} onTip={setTip} />
      ))}
      {full && tip && <SourceTip tip={tip} />}
    </div>,
    document.body,
  );
}

function BlockView({ block, fmt, env, onTip }: { block: PopupBlock; fmt: (s: string) => string; env: PopupEnv; onTip: (t: TipState | null) => void }) {
  if (block.kind === 'text') {
    return (
      <div className="lines" data-block="text">
        {block.lines.map((l, i) => (
          <div key={i} className="ln">
            <ColorText text={fmt(l)} />
          </div>
        ))}
      </div>
    );
  }
  if (block.kind === 'radius') {
    return (
      <div className="radius" data-block="radius" title={tr('calcs_Popup.radius_radius', { radius: block.radius })}>
        <span className="circ" style={{ width: Math.min(150, 20 + block.radius * 1.4), height: Math.min(150, 20 + block.radius * 1.4) }} />
        <span className="n">{tr('calcs_Popup.radius_radius', { radius: block.radius })}</span>
      </div>
    );
  }
  if (block.kind === 'mods') return <ModsView table={block.table} env={env} onTip={onTip} />;
  const cols = block.cols.filter((c) => block.rows.some((r) => r[c.key] !== undefined));
  return (
    <div className="tbl" data-block="table">
      {block.label && <div className="lbl">{lbl(block.label)}:</div>}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols.length}, auto)` }}>
        {cols.map((c) => (
          <span key={c.key} className={'th' + (c.right ? ' r' : '')}>{lbl(c.label)}</span>
        ))}
        {block.rows.map((r, ri) =>
          cols.map((c) => {
            const v = r[c.key];
            if (v === undefined) return <span key={ri + c.key} className="td" />;
            const text = groupsDigits(v) ? fmt(v) : v;
            if (c.key === 'sourceLabel' && r._item) {
              return (
                <span key={ri + c.key} className="td src" style={{ color: RARITY_COLOUR[r._rarity ?? ''] }} onMouseEnter={(e) => hoverItem(e, Number(r._item), env, onTip)} onMouseLeave={() => onTip(null)}>
                  <img src={artFor(v) ?? undefined} alt="" hidden={!artFor(v)} />
                  <span className="t">{v}</span>
                </span>
              );
            }
            return (
              <span key={ri + c.key} className={'td' + (c.right ? ' r' : '')}>
                <ColorText text={text} />
              </span>
            );
          }),
        )}
      </div>
      {block.footer && <div className="foot"><ColorText text={fmt(block.footer)} /></div>}
    </div>
  );
}

function hoverItem(e: React.MouseEvent, id: number, env: PopupEnv, onTip: (t: TipState | null) => void): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  onTip({ rect, info: null });
  void env.loadItem(id).then((info) => onTip({ rect, info }));
}

function ModsView({ table, env, onTip }: { table: CalcModTable; env: PopupEnv; onTip: (t: TipState | null) => void }) {
  const info = useGameInfo();
  const hasFlags = table.rows.some((r) => r.flags);
  const hasTags = table.rows.some((r) => r.tags);
  const cols = useMemo(() => {
    const c = [tr('calcs_Popup_2.value')];
    if (table.named) c.push(tr('calcs_Popup_2.stat'));
    if (hasFlags) c.push(tr('calcs_Popup.skill_types'));
    if (hasTags) c.push(tr('calcs_Popup_2.notes'));
    c.push(tr('calcs_Popup_2.source'), tr('calcs_Popup_2.source_name'));
    return c;
  }, [table.named, hasFlags, hasTags]);
  const tmpl = `max-content ${table.named ? 'max-content ' : ''}${hasFlags ? 'max-content ' : ''}${hasTags ? 'minmax(0,1fr) ' : ''}max-content minmax(0,1fr)`;
  return (
    <div className="mods" data-block="mods">
      {table.label && <div className="lbl">{table.label}:</div>}
      <div className="head" style={{ gridTemplateColumns: tmpl }}>
        {cols.map((c) => (
          <span key={c}>{c.toUpperCase()}</span>
        ))}
      </div>
      {table.rows.map((r, i) => (
        <div key={i} className="mrow" style={{ gridTemplateColumns: tmpl, background: i % 2 ? 'rgba(var(--line-rgb),.015)' : undefined }}>
          <span className={'v ' + modValueTone(r.value)}>{r.value}</span>
          {table.named && <span className="st" title={r.name}>{r.name}</span>}
          {hasFlags && <span className="fl" title={r.flags}>{r.flags}</span>}
          {hasTags && <span className="tg" title={r.tags}>{r.tags}</span>}
          <span
            className="sty"
            onMouseEnter={(e) => {
              const lines = table.totals?.[r.source];
              if (lines && lines.length) onTip({ rect: e.currentTarget.getBoundingClientRect(), info: null, text: tr('calcs_Popup.total_from_source_join', { source: r.source, lines: lines.join('\n') }) });
            }}
            onMouseLeave={() => onTip(null)}
          >
            {r.source}
          </span>
          <SourceName row={r} env={env} onTip={onTip} gem={info ? (n) => gemColour(info, n) : undefined} />
        </div>
      ))}
    </div>
  );
}

function SourceName({ row, env, onTip, gem }: { row: CalcModRow; env: PopupEnv; onTip: (t: TipState | null) => void; gem?: (n: string) => string }) {
  if (row.source === 'Item' && row.sourceName) {
    const rar = row.itemId !== undefined ? env.itemRarity(row.itemId) : null;
    const art = artFor(row.sourceName);
    return (
      <span
        className="sn"
        style={{ color: rar ? RARITY_COLOUR[rar] : undefined }}
        onMouseEnter={(e) => row.itemId !== undefined && hoverItem(e, row.itemId, env, onTip)}
        onMouseLeave={() => onTip(null)}
      >
        {art ? <img src={art} alt="" /> : <Icon name="items" size={14} />}
        <span className="t" title={row.sourceName}>{row.sourceName}</span>
      </span>
    );
  }
  if (row.source === 'Tree') {
    const n = row.nodeId !== undefined ? env.node(row.nodeId) : undefined;
    const name = n?.n ?? row.sourceName ?? (row.nodeId !== undefined ? tr('calcs_Popup.node_nodeid', { nodeId: row.nodeId }) : '');
    return (
      <span
        className="sn"
        onMouseEnter={(e) =>
          n &&
          row.nodeId !== undefined &&
          onTip({ rect: e.currentTarget.getBoundingClientRect(), info: null, node: { id: row.nodeId, name: n.n, kind: n.t, asc: n.a, stats: n.stats ?? [], version: env.treeVersion, state: env.treeState } })
        }
        onMouseLeave={() => onTip(null)}
      >
        {n?.sp ? <NodeIcon version={env.treeVersion} sprite={n.sp} size={20} /> : <Icon name="tree" size={14} style={{ color: 'var(--text-muted)' }} />}
        <span className="t" title={name}>{name}</span>
      </span>
    );
  }
  if (row.source === 'Skill' && row.sourceName) {
    const art = artFor(row.sourceName, 'gems') ?? artFor(row.sourceName);
    return (
      <span className="sn" style={{ color: gem?.(row.sourceName) }}>
        {art ? <img src={art} alt="" /> : <Icon name="gem" size={14} style={{ color: 'var(--text-muted)' }} />}
        <span className="t" title={row.sourceName}>{row.sourceName}</span>
      </span>
    );
  }
  const icon: Record<string, string> = { Base: 'user', Config: 'sliders', Charge: 'zap', Pantheon: 'pantheon', Spectre: 'minion', Custom: 'edit' };
  return (
    <span className="sn">
      <Icon name={icon[row.source] ?? 'dot'} size={14} style={{ color: 'var(--text-muted)' }} />
      <span className="t" title={row.sourceName ?? ''}>{row.sourceName ?? ''}</span>
    </span>
  );
}

/** The tooltip beside a source row: an item's own tooltip, a passive node's text and place on the tree, or plain lines. */
function SourceTip({ tip }: { tip: TipState }) {
  const { rect, info, text, node } = tip;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = rect.right + 10;
    if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - 10 - w);
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 8 - h));
    setPos({ left, top });
  }, [rect, info, text, node]);
  return portal(
    <div ref={ref} className="calc-tip" role="tooltip" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      {info ? (
        <ItemTooltip info={info} />
      ) : node ? (
        <div className="node-tip">
          <div className="nm">{node.name}</div>
          <div className="kind">{KIND_WORD[node.kind] ?? node.kind}{node.asc ? ` · ${node.asc}` : ''}</div>
          {node.stats.length > 0 ? <div className="mods">{node.stats.map((l, i) => <div key={i}>{l}</div>)}</div> : <div className="mods" style={{ color: 'var(--text-faint)' }}>{tr('calcs_Popup.no_stats')}</div>}
          {node.state && (
            <div className="calc-tv" aria-label={tr('calcs_Popup.where_this_passive_is_on')}>
              <PassiveTreeView key={node.id} state={node.state} base={`game/tree/${node.version}/`} autoApply={false} frame={[node.id]} zoom={0.9} interactive={false} overlay={{ added: [node.id] }} />
            </div>
          )}
        </div>
      ) : text ? (
        text.split('\n').map((l, i) => <div key={i} style={i === 0 ? { color: 'var(--text-strong)', fontWeight: 600 } : undefined}>{l}</div>)
      ) : (
        <div style={{ color: 'var(--text-faint)' }}>{tr('calcs_Popup.reading_the_item')}</div>
      )}
    </div>,
    document.body,
  );
}
