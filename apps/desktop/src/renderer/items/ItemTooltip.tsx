import type { GemTip, ItemColour, ItemInfo, TooltipLine } from '@pom/protocol';
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { visibleSegs } from '../../shared/settingsEffects';
import { expandMarkers } from '../../shared/sourceMarkers';
import { getAppSettings } from '../appSettings';
import { shownLines } from '../tipLines';
import '../tipFrame.css';

/** The design token each of the engine's colour names stands for. */
export const COLOUR_VAR: Record<ItemColour, string> = {
  normal: 'var(--rarity-normal)',
  magic: 'var(--mod-explicit)',
  rare: 'var(--rarity-rare)',
  unique: 'var(--rarity-unique)',
  relic: 'var(--rarity-relic)',
  muted: 'var(--text-3)',
  white: 'var(--text-strong)',
  positive: 'var(--positive-text)',
  negative: 'var(--negative-text)',
  fire: 'var(--dmg-fire)',
  cold: 'var(--dmg-cold)',
  lightning: 'var(--dmg-lightning)',
  chaos: 'var(--dmg-chaos)',
  str: 'var(--attr-str)',
  dex: 'var(--attr-dex)',
  int: 'var(--attr-int)',
  scion: 'var(--socket-w)',
  'socket-a': 'var(--text-muted)',
  crafted: 'var(--mod-crafted)',
  fractured: 'var(--mod-fractured)',
  mutated: 'var(--mod-mutated)',
  scourge: 'var(--mod-scourge)',
  custom: 'var(--mod-custom)',
  crucible: 'var(--mod-crucible)',
  vestigial: 'var(--vestigial)',
  gem: 'var(--gem, #1aa29b)',
  unsupported: 'var(--mod-unsupported)',
  disabled: 'var(--mod-disabled)',
  source: 'var(--mod-source)',
  league: 'var(--negative-text)',
  memory: 'var(--memory)',
  intangibility: 'var(--intangibility)',
};

export function colourOf(c: ItemColour | null | undefined): string | undefined {
  return c ? COLOUR_VAR[c] : undefined;
}

const INFLUENCE_TOKEN: Record<string, string> = {
  Shaper: 'var(--influence-shaper)',
  Elder: 'var(--influence-elder)',
  Crusader: 'var(--influence-crusader)',
  Redeemer: 'var(--influence-eyrie)',
  Hunter: 'var(--influence-basilisk)',
  Warlord: 'var(--influence-adjudicator)',
  Exarch: 'var(--influence-cleansing)',
  Eater: 'var(--influence-tangle)',
  Fractured: 'var(--mod-fractured)',
  Synthesis: 'var(--mod-crafted)',
  Foulborn: 'var(--mod-mutated)',
  Veiled: 'var(--text-muted)',
  Vestigial: 'var(--vestigial)',
  Experimented: 'var(--mod-scourge)',
  Memory: 'var(--memory)',
};

export function influenceColour(name: string): string {
  return INFLUENCE_TOKEN[name] ?? 'var(--text-muted)';
}

function Line({ l }: { l: TooltipLine }) {
  if (l.k === 'sep') return <div className="it-tt-sep" />;
  const prefs = getAppSettings();
  // Settings: flavour text and the unsupported-mod note can each be switched off.
  if (l.k === 'flavour' && !prefs.styledTooltips) return null;
  return (
    <div className={'it-tt-line ' + l.k}>
      {expandMarkers(visibleSegs(l.segs, prefs.tooltipsUnsupportedMods), colourOf).map((s, i) => (
        <span key={i} style={{ color: s.colour }}>
          {s.t}
        </span>
      ))}
    </div>
  );
}

/** The item as upstream's tooltip draws it: rarity header band, base stats, requirements, modifier groups, flavour. `detail` false (a hover without Alt) leaves out the tips and the source line. */
export function ItemTooltip({ info, extra, className, style, art, detail = true }: { info: ItemInfo; extra?: ReactNode; className?: string; style?: CSSProperties; art?: string; detail?: boolean }) {
  const rc = colourOf(info.headerRarity) ?? 'var(--rarity-normal)';
  const influences = info.headerInfluence ?? [];
  const lines = shownLines(info.lines, detail);
  const titles = lines.filter((l) => l.k === 'title');
  return (
    <div className={'it-tt ' + (className ?? '')} style={{ ...style, borderColor: rc, ['--tt-rc' as string]: rc }} data-lg="pop" data-solid="">
      {art && <img className="it-tt-art" src={art} alt="" />}
      <div className="tt-band col">
        {titles.map((l, i) => (
          <div key={i} className="it-tt-head">
            {i === 0 && influences[0] && <i className="it-inf" style={{ background: influenceColour(influences[0]) }} title={influences[0]} />}
            <span className={titles.length > 1 && i > 0 ? 'base' : 'name'}>{l.segs.map((s) => s.t).join('')}</span>
            {i === 0 && influences[0] && <i className="it-inf" style={{ background: influenceColour(influences[1] ?? influences[0]) }} title={influences[1] ?? influences[0]} />}
          </div>
        ))}
      </div>
      {lines.map((l, i) => (l.k === 'title' ? null : <Line key={i} l={l} />))}
      {extra}
    </div>
  );
}

/** A compact list of the item's lines for dropdowns and rows. */
export function PlainLines({ lines }: { lines: TooltipLine[] }) {
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={i}>
          <Line l={l} />
        </Fragment>
      ))}
    </>
  );
}

/** A skill's tooltip as the gem tooltip draws it (the skills an item grants, shown while Shift is held). */
export function GemTooltipView({ tip, detail = true, extra }: { tip: GemTip; detail?: boolean; extra?: ReactNode }) {
  const lines = shownLines(tip.lines, detail);
  return (
    <div className="it-tt gem" style={{ borderColor: 'var(--gem, #1aa29b)', ['--tt-rc' as string]: 'var(--gem, #1aa29b)' }} data-lg="pop" data-solid="">
      <div className="tt-band col">
        {lines.filter((l) => l.k === 'title').map((l, i) => <div key={i} className="it-tt-head"><span className="name">{l.segs.map((s) => s.t).join('')}</span></div>)}
      </div>
      {lines.map((l, i) => (l.k === 'title' ? null : <Line key={i} l={l} />))}
      {extra}
    </div>
  );
}
