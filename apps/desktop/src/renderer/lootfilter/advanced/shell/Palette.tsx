import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogItem } from '../../../../shared/lootfilter/catalog.js';
import { tagKey } from '../../../../shared/lootfilter/blocks.js';
import { Icon } from '../../../ui';
import { LabelChip } from '../../LabelChip';
import { useLf } from '../../lfStore';
import { useAdvShell } from './selection';
import { tr } from '../../../i18n';

export interface PaletteScreen {
  id: string;
  label: string;
  key: string;
  icon: string;
}
export interface PaletteAction {
  id: string;
  label: string;
  sub: string;
  kbd?: string;
  run: () => void;
}

interface Row {
  id: string;
  type: 'SCREEN' | 'ACTION' | 'ITEM' | 'SECTION';
  n: string;
  sub: string;
  kbd?: string;
  item?: CatalogItem;
  pin?: boolean;
  run: () => void;
}

/** Ctrl K: items, sections, screens and actions in one list. */
export function CommandPalette({ screens, actions, onGo, onClose }: { screens: PaletteScreen[]; actions: PaletteAction[]; onGo: (id: string) => void; onClose: () => void }) {
  const lf = useLf();
  const sh = useAdvShell();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const pins = (Array.isArray(lf.ui.advPins) ? lf.ui.advPins : []) as string[];
  const cat = lf.catalog;

  const rows = useMemo<Row[]>(() => {
    const s = q.trim().toLowerCase();
    const out: Row[] = [];
    const openItem = (it: CatalogItem): (() => void) => () => {
      onClose();
      sh.goSection(it.type);
      sh.select({ kind: 'item', name: it.name });
      sh.openInspector();
    };
    const itemRow = (it: CatalogItem): Row => ({ id: 'i:' + it.name, type: 'ITEM', n: it.name, sub: `${cat?.types.find((t) => t.type === it.type)?.label ?? it.type} · ${cat?.tierByKey.get(tagKey({ type: it.type, tier: it.tier }))?.label ?? it.tier}`, item: it, pin: pins.includes(it.name), run: openItem(it) });
    // An action named by the word typed ("simple" for Switch to Simple) goes first, above item names that contain it.
    const wordHit = (a: PaletteAction): boolean => !!s && a.label.toLowerCase().split(/[^a-z0-9]+/).includes(s);
    const actionRow = (a: PaletteAction): Row => ({ id: 'a:' + a.id, type: 'ACTION', n: a.label, sub: a.sub, ...(a.kbd ? { kbd: a.kbd } : {}), run: () => { onClose(); a.run(); } });
    for (const a of actions) if (wordHit(a)) out.push(actionRow(a));
    if (!s) {
      if (cat) for (const n of pins) {
        const it = cat.byName.get(n);
        if (it) out.push(itemRow(it));
      }
    } else if (cat) {
      const hits = cat.items.filter((it) => it.name.toLowerCase().includes(s));
      hits.sort((a, b) => Number(pins.includes(b.name)) - Number(pins.includes(a.name)) || Number(b.name.toLowerCase().startsWith(s)) - Number(a.name.toLowerCase().startsWith(s)) || a.name.length - b.name.length);
      for (const it of hits.slice(0, 24)) out.push(itemRow(it));
      for (const t of cat.types.filter((x) => x.label.toLowerCase().includes(s) || x.type.toLowerCase().includes(s)).slice(0, 6)) {
        out.push({ id: 's:' + t.type, type: 'SECTION', n: t.label, sub: tr('lootfilter_advanced_shell_Palette.group_count_tiers', { count: t.tiers.length, group: t.group }), run: () => { onClose(); sh.goSection(t.type); } });
      }
    }
    for (const sc of screens) {
      if (!s || sc.label.toLowerCase().includes(s)) out.push({ id: 'v:' + sc.id, type: 'SCREEN', n: sc.label, sub: tr('lootfilter_advanced_shell_Palette.open_this_screen'), kbd: sc.key, run: () => { onClose(); onGo(sc.id); } });
    }
    for (const a of actions) {
      if (wordHit(a)) continue;
      if (!s || a.label.toLowerCase().includes(s) || a.sub.toLowerCase().includes(s)) out.push(actionRow(a));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, cat, pins.join('|'), screens, actions]);

  useEffect(() => setAt(0), [q]);
  const key = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAt((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      rows[at]?.run();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="adv-sh-scrim" onClick={onClose}>
      <div className="adv-sh-palette" data-lg="pop" style={{ position: 'absolute' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={tr('lootfilter_advanced_shell_Palette.command_palette')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', height: 52, borderBottom: '1px solid rgba(var(--line-rgb),.08)' }}>
          <Icon name="search" size={17} style={{ color: 'var(--text-muted)' }} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} aria-label={tr('lootfilter_advanced_shell_Palette.search')} placeholder={tr('lootfilter_advanced_shell_Palette.search_items_screens_and_actions')} style={{ flex: 1, minWidth: 0, height: 40, border: 0, background: 'transparent', color: 'var(--text-strong)', font: '15px Geist', outline: 'none' }} />
          <span className="adv-sh-k">{tr('lootfilter_advanced_shell_Palette.esc')}</span>
        </div>
        <div className="lf-scroll" style={{ maxHeight: 440, padding: 6 }}>
          {rows.map((r, i) => (
            <div key={r.id} className="adv-sh-prow" onClick={r.run} onMouseEnter={() => setAt(i)} style={{ borderColor: i === at ? 'rgba(var(--area-filter-rgb),.5)' : 'transparent', background: i === at ? 'rgba(var(--area-filter-rgb),.12)' : 'transparent' }}>
              <span style={{ font: '600 9.5px Geist', letterSpacing: '.1em', color: 'var(--text-faint)' }}>{r.type}</span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span className="ellipsis" style={{ color: 'var(--text-strong)' }}>{r.n}</span>
                <span className="ellipsis" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{r.sub}</span>
              </span>
              {r.item ? (
                <span style={{ padding: '4px 6px', borderRadius: 6, background: 'radial-gradient(120% 90% at 50% 40%,#2a2419,#0d0b08)', display: 'flex' }}>
                  <LabelChip name={r.item.name} style={lf.evaluateCatalogItem(r.item)?.style ?? r.item.style} fontPx={13} hidden={lf.evaluateCatalogItem(r.item)?.visible === false} />
                </span>
              ) : (
                <span />
              )}
              <span style={{ font: "500 10.5px 'Geist Mono'", color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{r.kbd ?? ''}</span>
              {r.item ? (
                <button
                  type="button"
                  title={r.pin ? tr('lootfilter_advanced_shell_Palette.unpin') : tr('lootfilter_advanced_shell_Palette.pin_to_the_top_of')}
                  aria-label={r.pin ? tr('lootfilter_advanced_shell_Palette.unpin') : tr('lootfilter_advanced_shell_Palette.pin')}
                  className="adv-sh-ib sm"
                  style={{ color: r.pin ? 'var(--gold-400)' : 'var(--text-faint)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const n = r.item!.name;
                    lf.setUi('advPins', r.pin ? pins.filter((x) => x !== n) : [n, ...pins].slice(0, 20));
                  }}
                >
                  <Icon name="pin" size={14} />
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
          {rows.length === 0 && <div style={{ padding: '30px 20px', textAlign: 'center', color: 'var(--text-muted)', lineHeight: 1.5 }}>{q ? tr('lootfilter_advanced_shell_Palette.nothing_matches_try_a_base') : tr('lootfilter_advanced_shell_Palette.type_to_search')}</div>}
        </div>
        <div style={{ display: 'flex', gap: 16, padding: '8px 14px', borderTop: '1px solid rgba(var(--line-rgb),.08)', color: 'var(--text-faint)', fontSize: 11.5 }}>
          <span>{tr('lootfilter_advanced_shell_Palette.up_and_down_to_choose')}</span>
          <span>{tr('lootfilter_advanced_shell_Palette.enter_to_open')}</span>
          <span>{tr('lootfilter_advanced_shell_Palette.then_m_to_move_e')}</span>
        </div>
      </div>
    </div>
  );
}
