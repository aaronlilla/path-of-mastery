import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { portal } from './Freeze';
import { engineCall } from './engineHandle';
import { filterMods, type ModEntry } from '../shared/modBrowser';
import { Dialog, Icon } from './ui';
import './modPicker.css';
import { tr } from './i18n';

/** The open build's engine id: the mod list follows its passive tree version. */
export const ModsBuild = createContext<string | null>(null);

const modsByBuild = new Map<string, Promise<ModEntry[]>>();
/** Every mod line the engine's parser accepts from tree nodes and item mods (kept per build id). */
function loadMods(buildId: string): Promise<ModEntry[]> {
  let p = modsByBuild.get(buildId);
  if (!p) {
    p = window.pom.sendCommand('configMods' as never, { buildId } as never).then((r: { ok: boolean; result?: unknown; error?: { message: string } }) => {
      if (!r.ok) throw new Error(r.error?.message ?? tr('ModPicker_2.engine_error'));
      return (r.result as { mods: ModEntry[] }).mods;
    });
    modsByBuild.set(buildId, p);
    p.catch(() => modsByBuild.delete(buildId));
  }
  return p;
}

const SHOWN = 300;

/** Upstream's Mod Browser (ConfigModBrowser.lua): search the supported mod lines, pick one, and it is added to the group. */
export function ModPicker({ onPick, onClose }: { onPick: (line: string) => void; onClose: () => void }) {
  const buildId = useContext(ModsBuild);
  const [mods, setMods] = useState<ModEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    if (!buildId) {
      setErr(tr('ModPicker.the_engine_is_not_ready'));
      return;
    }
    loadMods(buildId).then(
      (m) => live && setMods(m),
      (e) => live && setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [buildId]);
  const found = useMemo(() => (mods ? filterMods(mods, q) : []), [mods, q]);
  const shown = found.slice(0, SHOWN);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, shown.length]);
  const cur = shown[sel];
  const pick = (m: ModEntry | undefined) => {
    if (!m) return;
    onPick(m.text);
    onClose();
  };
  return portal(
    <Dialog
      size="medium"
      icon="import"
      title={tr('ModPicker.mod_browser')}
      subtitle={tr('ModPicker.supported_modifier_lines_from_passiv')}
      confirmLabel={tr('ModPicker.add')}
      confirmIcon="plus"
      confirmDisabled={!cur}
      onConfirm={() => pick(cur)}
      onCancel={onClose}
      note={tr('ModPicker.this_is_only_a_limited')}
    >
      <div className="cfg-modpick">
        <label className="search">
          <Icon name="search" size={16} />
          <input
            type="text"
            value={q}
            maxLength={100}
            placeholder={tr('ModPicker.search')}
            aria-label={tr('ModPicker.search_modifiers')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(shown.length - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                pick(cur);
              }
            }}
          />
          {q && (
            <button type="button" aria-label={tr('ModPicker.clear_search')} onClick={() => setQ('')}>
              <Icon name="x" size={12} />
            </button>
          )}
        </label>
        <div className="list" role="listbox" aria-label={tr('ModPicker.modifiers')} ref={listRef}>
          {err && <div className="none">{tr('ModPicker.could_not_load_the_modifier', { err })}</div>}
          {!err && !mods && <div className="none">{tr('ModPicker.loading_modifiers')}</div>}
          {mods && !found.length && <div className="none">{tr('ModPicker.no_matching_modifiers_found')}</div>}
          {shown.map((m, i) => (
            <div key={m.text} role="option" aria-selected={i === sel} className={'mod' + (i === sel ? ' on' : '')} title={m.sources.join('\n')} onClick={() => setSel(i)} onDoubleClick={() => pick(m)}>
              {m.text}
            </div>
          ))}
          {found.length > SHOWN && <div className="none">{tr('ModPicker.shown_more_type_to_narrow', { SHOWN: found.length - SHOWN })}</div>}
        </div>
        {mods && <div className="count">{found.length === mods.length ? tr('ModPicker.length_modifiers', { count: mods.length }) : tr('ModPicker.length_of_length2_modifiers', { count: found.length, count2: mods.length })}</div>}
      </div>
    </Dialog>,
    document.getElementById('root') ?? document.body,
  );
}
