import { useEffect, useMemo, useRef, useState } from 'react';
import type { LevelingCandidateRow } from '../../../shared/lootfilter/ipcTypes.js';
import type { GameData } from '../../../shared/lootfilter/profile.js';
import { tr } from '../../i18n';

/**
 * The leveling skill picker of the Stages step: the computed choice, the skills the class can start with (best fit first,
 * each with why) and "Any gem...". The pick is a gemId; `undefined` is the computed choice.
 */
export function LevelingPicker({ candidates, game, value, current, onPick }: { candidates: LevelingCandidateRow[]; game: GameData | null; value: string | undefined; current: string; onPick(gemId: string | undefined): void }) {
  const [open, setOpen] = useState(false);
  const [any, setAny] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const gems = useMemo(() => {
    if (!game) return [] as { id: string; name: string }[];
    const seen = new Set<string>();
    const out: { id: string; name: string }[] = [];
    for (const [id, g] of Object.entries(game.gems)) {
      if (g.support || !id.startsWith('Metadata/Items/Gems/SkillGem') || /Vaal|Alt[A-Z]$/.test(id) || seen.has(g.name)) continue;
      seen.add(g.name);
      out.push({ id: g.gameId ?? id, name: g.name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [game]);
  const matches = useMemo(() => {
    const w = q.trim().toLowerCase();
    return (w ? gems.filter((g) => g.name.toLowerCase().includes(w)) : gems).slice(0, 8);
  }, [gems, q]);

  const nameOf = (id: string): string => candidates.find((c) => c.gemId === id)?.name ?? game?.gems[id]?.name ?? id;
  const pick = (id: string | undefined): void => {
    onPick(id);
    setOpen(false);
    setAny(false);
    setQ('');
  };
  const label = value ? nameOf(value) : tr('lootfilter_buildfilter_LevelingPicker.automatic_current', { current });

  return (
    <div className="bf-pick" ref={root} data-open={open}>
      <button type="button" className="bf-select bf-pick-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={tr('lootfilter_buildfilter_LevelingPicker.leveling_skill')} onClick={() => setOpen(!open)}>
        <span className="bf-pick-label">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="bf-pick-pop" role="listbox" aria-label={tr('lootfilter_buildfilter_LevelingPicker.leveling_skills')}>
          <button type="button" role="option" aria-selected={!value} className="bf-pick-row" onClick={() => pick(undefined)}>
            <span className="bf-pick-name">{tr('lootfilter_buildfilter_LevelingPicker.automatic')}</span>
            <span className="bf-pick-why">{tr('lootfilter_buildfilter_LevelingPicker.the_best_fit_for_your', { current })}</span>
          </button>
          {candidates.map((c) => (
            <button key={c.gemId} type="button" role="option" aria-selected={value === c.gemId} className="bf-pick-row" data-gem={c.gemId} onClick={() => pick(c.gemId)}>
              <span className="bf-pick-name">{c.name}</span>
              <span className="bf-pick-why">{c.reason}</span>
            </button>
          ))}
          <button type="button" role="option" aria-selected={any} className="bf-pick-row" data-any="1" onClick={() => setAny(true)}>
            <span className="bf-pick-name">{tr('lootfilter_buildfilter_LevelingPicker.any_gem')}</span>
            <span className="bf-pick-why">{tr('lootfilter_buildfilter_LevelingPicker.search_every_skill_gem')}</span>
          </button>
          {any && (
            <div className="bf-pick-any">
              <input autoFocus className="bf-select" aria-label={tr('lootfilter_buildfilter_LevelingPicker.search_skill_gems')} placeholder={tr('lootfilter_buildfilter_LevelingPicker.gem_name')} value={q} onChange={(e) => setQ(e.target.value)} />
              {matches.map((g) => (
                <button key={g.id} type="button" className="bf-pick-row" onClick={() => pick(g.id)}>
                  <span className="bf-pick-name">{g.name}</span>
                </button>
              ))}
              {!matches.length && <span className="bf-pick-why">{tr('lootfilter_buildfilter_LevelingPicker.no_skill_gem_matches')}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
