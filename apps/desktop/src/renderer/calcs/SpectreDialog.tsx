import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { portal } from '../Freeze';
import type { SpectreInfo } from '../../shared/library';
import { spectreMatches, spectreTipLines, type Mode } from '../../shared/spectreLogic';
import { engineCall } from '../engineHandle';
import { Dialog, Icon } from '../ui';
import { tr } from '../i18n';

const MODES: Mode[] = ['Names', 'Skills', 'Both'];
const MODE_WORD: Record<Mode, string> = { Names: tr('calcs_SpectreDialog_2.names'), Skills: tr('calcs_SpectreDialog_2.skills'), Both: tr('calcs_SpectreDialog_2.both') };

/**
 * The Spectre Library (`Build:OpenSpectreLibrary`): the spectres the build holds on the left, every spectre-capable
 * minion with a search box (names, skills or both) on the right. The Add button, a double-click or dragging a row across
 * adds one (never twice), Remove, the Delete key or Backspace takes the chosen one out, and dragging a row inside the left
 * list reorders it; hovering a row shows its multipliers, resistances, damage and skills. Save writes the list.
 */
export function SpectreDialog({ current, onSave, onCancel }: { current: string[]; onSave: (ids: string[]) => void; onCancel: () => void }) {
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string }> | null>(null);
  const [info, setInfo] = useState<Record<string, SpectreInfo>>({});
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<string[]>(current);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<Mode>('Names');
  const [selL, setSelL] = useState<number | null>(null);
  const [selR, setSelR] = useState<string | null>(null);
  const [tip, setTip] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [over, setOver] = useState<number | 'end' | null>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    engineCall('spectreCatalog', {}).then((r) => live && setCatalog(r.spectres)).catch((e: Error) => live && setError(e.message));
    void window.pom.game.spectres().then((r) => live && r.ok && setInfo(r.value));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    search.current?.focus();
  }, [catalog]);
  const names = useMemo(() => new Map((catalog ?? []).map((c) => [c.id, c.name])), [catalog]);
  const shown = useMemo(() => (catalog ?? []).filter((c) => spectreMatches(c.name, info[c.id]?.skills ?? [], q, mode)), [catalog, q, mode, info]);
  const add = (id: string, at?: number) =>
    setList((l) => {
      const without = l.filter((x) => x !== id);
      if (at === undefined) return l.includes(id) ? l : [...l, id];
      const k = Math.min(at, without.length);
      return [...without.slice(0, k), id, ...without.slice(k)];
    });
  const chooseFirst = (text: string, m: Mode) => {
    const first = (catalog ?? []).find((c) => spectreMatches(c.name, info[c.id]?.skills ?? [], text, m));
    setSelR(text.trim() && first ? first.id : null);
  };
  const remove = (i: number) => {
    setList((l) => l.filter((_, k) => k !== i));
    setSelL(null);
    setTip(null);
  };
  const drag = (e: React.DragEvent, from: 'lib' | 'all', id: string) => {
    e.dataTransfer.setData('text/spectre', JSON.stringify({ from, id }));
    e.dataTransfer.effectAllowed = 'move';
    setTip(null);
  };
  const drop = (e: React.DragEvent, at: number | 'end') => {
    e.preventDefault();
    setOver(null);
    try {
      const d = JSON.parse(e.dataTransfer.getData('text/spectre')) as { from: 'lib' | 'all'; id: string };
      add(d.id, at === 'end' ? list.length : at);
    } catch {
      // not one of ours
    }
  };
  const moveL = (d: number) => setSelL((i) => (list.length === 0 ? null : Math.max(0, Math.min(list.length - 1, (i ?? (d > 0 ? -1 : list.length)) + d))));
  const moveR = (d: number) => {
    if (shown.length === 0) return;
    const at = shown.findIndex((c) => c.id === selR);
    setSelR(shown[Math.max(0, Math.min(shown.length - 1, (at < 0 ? (d > 0 ? -1 : shown.length) : at) + d))]!.id);
  };
  const keysL = (e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selL !== null) {
        e.preventDefault();
        remove(selL);
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveL(e.key === 'ArrowDown' ? 1 : -1);
    }
  };
  const keysR = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveR(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (selR && !list.includes(selR)) add(selR);
    }
  };
  const hoverRow = (id: string) => (e: React.MouseEvent) => setTip({ id, rect: e.currentTarget.getBoundingClientRect() });
  const canAdd = selR !== null && !list.includes(selR);
  const rowRef = (el: HTMLElement | null, on: boolean) => on && el?.scrollIntoView?.({ block: 'nearest' });
  return portal(
    <Dialog size="large" icon="user" title={tr('calcs_SpectreDialog.spectre_library')} confirmLabel={tr('calcs_SpectreDialog.save')} onConfirm={() => onSave(list)} onCancel={onCancel} confirmDisabled={!catalog}>
      <div className="calc-spec-dlg" data-testid="spectre-library">
        <div className="col">
          <div className="cap">
            <span>{tr('calcs_SpectreDialog.spectres_in_build')}</span>
            <button type="button" className="btn sm outline" disabled={selL === null} title={tr('calcs_SpectreDialog.take_the_chosen_spectre_out')} onClick={() => selL !== null && remove(selL)}>
              {tr('calcs_SpectreDialog.remove')}
            </button>
          </div>
          <div className="lst" role="listbox" aria-label={tr('calcs_SpectreDialog.spectres_in_build')} tabIndex={0} onKeyDown={keysL} onDragOver={(e) => { e.preventDefault(); setOver('end'); }} onDragLeave={() => setOver(null)} onDrop={(e) => drop(e, 'end')} style={over === 'end' ? { borderColor: 'rgba(var(--accent-rgb), .6)' } : undefined}>
            {list.length === 0 && <div className="empty">{tr('calcs_SpectreDialog.no_spectres_yet_choose_one')}</div>}
            {list.map((id, i) => (
              <button
                key={id}
                ref={(el) => rowRef(el, selL === i)}
                type="button"
                role="option"
                aria-selected={selL === i}
                className={'row' + (selL === i ? ' on' : '')}
                draggable
                onDragStart={(e) => drag(e, 'lib', id)}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(i); }}
                onDrop={(e) => { e.stopPropagation(); drop(e, i); }}
                style={over === i ? { boxShadow: 'inset 0 2px 0 rgba(var(--accent-rgb), .8)' } : undefined}
                onClick={() => setSelL(i)}
                onMouseEnter={hoverRow(id)}
                onMouseLeave={() => setTip(null)}
                onFocus={(e) => setTip({ id, rect: e.currentTarget.getBoundingClientRect() })}
                onBlur={() => setTip(null)}
              >
                <span className="t">{names.get(id) ?? id}</span>
              </button>
            ))}
          </div>
          <div className="note">{tr('calcs_SpectreDialog.spectres_in_your_library_must')}</div>
        </div>
        <div className="col">
          <div className="cap">
            <span>{tr('calcs_SpectreDialog.available_spectres')}</span>
            <button type="button" className="btn sm outline" disabled={!canAdd} title={tr('calcs_SpectreDialog.put_the_chosen_spectre_in')} onClick={() => selR && add(selR)}>
              {tr('calcs_SpectreDialog.add')}
            </button>
          </div>
          <div className="srchrow">
            <label className="srch">
              <Icon name="search" size={14} />
              <input
                ref={search}
                value={q}
                placeholder={tr('calcs_SpectreDialog.search')}
                aria-label={tr('calcs_SpectreDialog.search_spectres')}
                spellCheck={false}
                maxLength={100}
                onChange={(e) => {
                  setQ(e.target.value);
                  chooseFirst(e.target.value, mode);
                }}
                onKeyDown={keysR}
              />
            </label>
            <div className="seg" role="radiogroup" aria-label={tr('calcs_SpectreDialog.what_the_search_looks_at')}>
              {MODES.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} title={m === 'Names' ? tr('calcs_SpectreDialog.search_the_spectre_names') : m === 'Skills' ? tr('calcs_SpectreDialog.search_the_names_of_their') : tr('calcs_SpectreDialog.search_names_and_skills')} onClick={() => { setMode(m); chooseFirst(q, m); }}>
                  {MODE_WORD[m]}
                </button>
              ))}
            </div>
          </div>
          <div className="lst" role="listbox" aria-label={tr('calcs_SpectreDialog.available_spectres')} tabIndex={0} onKeyDown={keysR}>
            {error && <div className="empty">{error}</div>}
            {!catalog && !error && <div className="empty">{tr('calcs_SpectreDialog.reading_the_spectre_list')}</div>}
            {catalog && shown.length === 0 && <div className="empty">{tr('calcs_SpectreDialog.no_spectre_matches_q', { value: q })}</div>}
            {shown.map((c) => (
              <button
                key={c.id}
                ref={(el) => rowRef(el, selR === c.id)}
                type="button"
                role="option"
                aria-selected={selR === c.id}
                className={'row' + (selR === c.id ? ' on' : '')}
                draggable
                onDragStart={(e) => drag(e, 'all', c.id)}
                onClick={() => setSelR(c.id)}
                onDoubleClick={() => add(c.id)}
                onMouseEnter={hoverRow(c.id)}
                onMouseLeave={() => setTip(null)}
                onFocus={(e) => setTip({ id: c.id, rect: e.currentTarget.getBoundingClientRect() })}
                onBlur={() => setTip(null)}
              >
                <span className="t">{c.name}</span>
                {list.includes(c.id) && <Icon name="check" size={13} style={{ color: 'var(--gold-400)' }} />}
              </button>
            ))}
          </div>
        </div>
      </div>
      {tip && info[tip.id] && <SpectreTip name={names.get(tip.id) ?? info[tip.id]!.name} m={info[tip.id]!} rect={tip.rect} />}
    </Dialog>,
    document.getElementById('root') ?? document.body,
  );
}

function SpectreTip({ name, m, rect }: { name: string; m: SpectreInfo; rect: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Placed before paint, so the first frame shown is already in place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let left = rect.right + 10;
    if (left + el.offsetWidth > window.innerWidth - 8) left = Math.max(8, rect.left - 10 - el.offsetWidth);
    setPos({ left, top: Math.max(8, Math.min(rect.top, window.innerHeight - 8 - el.offsetHeight)) });
  }, [rect]);
  return portal(
    <div ref={ref} className="calc-spec-tip" role="tooltip" data-testid="spectre-tip" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      <div className="nm">{name}</div>
      {spectreTipLines(m).map((l, i) =>
        l.startsWith('Resistances: ') ? (
          <div key={i}>
            {tr('calcs_SpectreDialog.resistances')} <span style={{ color: 'var(--dmg-fire)' }}>{m.resist.fire}</span>/<span style={{ color: 'var(--dmg-cold)' }}>{m.resist.cold}</span>/<span style={{ color: 'var(--dmg-lightning)' }}>{m.resist.lightning}</span>/<span style={{ color: 'var(--dmg-chaos)' }}>{m.resist.chaos}</span>
          </div>
        ) : (
          <div key={i}>{l}</div>
        ),
      )}
    </div>,
    document.body,
  );
}
