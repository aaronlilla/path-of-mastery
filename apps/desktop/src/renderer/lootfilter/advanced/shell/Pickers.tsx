import { useEffect, useRef, useState } from 'react';
import type { Color, LabelStyle } from '../../../../shared/lootfilter/types.js';
import { COLOUR_HEX, GAME_SWATCHES, SHAPE_PATH, SOUND_NAMES, contrast, rgba } from '../../../../shared/lootfilter/styles.js';
import { MINIMAP_COLOURS, MINIMAP_SHAPES } from '../../../../shared/lootfilter/syntax.js';
import { Icon } from '../../../ui';
import { LabelChip, groundFor } from '../../LabelChip';
import { playAlertTone } from '../../audio';
import type { Ground } from './selection';
import { tr } from '../../../i18n';
import { colourName, shapeName, sizeName } from '../../names';

export type PickerKind = 'fg' | 'bd' | 'bg' | 'snd' | 'icon' | 'beam';

/** A range input that previews while dragging and writes once when the drag ends. */
export function RangeInput({ value, min, max, onCommit, label, onLive }: { value: number; min: number; max: number; onCommit: (v: number) => void; label: string; onLive?: (v: number) => void }) {
  const [v, setV] = useState(value);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setV(value);
  }, [value]);
  const end = (): void => {
    if (dirty.current) {
      dirty.current = false;
      onCommit(v);
    }
  };
  return (
    <input
      type="range"
      min={min}
      max={max}
      value={v}
      aria-label={label}
      onChange={(e) => {
        dirty.current = true;
        const n = Number(e.target.value);
        setV(n);
        onLive?.(n);
      }}
      onPointerUp={end}
      onKeyUp={end}
      onBlur={end}
      style={{ width: '100%', accentColor: 'var(--gold-400)' }}
    />
  );
}

/** A number box that writes when you leave it or press Enter. */
export function NumInput({ value, min, max, onCommit, label, width = '100%' }: { value: number; min: number; max: number; onCommit: (v: number) => void; label: string; width?: string | number }) {
  const [t, setT] = useState(String(value));
  useEffect(() => setT(String(value)), [value]);
  const done = (): void => {
    const n = Math.max(min, Math.min(max, Math.round(Number(t))));
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setT(String(value));
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={t}
      aria-label={label}
      onChange={(e) => setT(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className="adv-sh-num"
      style={{ width }}
    />
  );
}

function PickShell({ title, right, width, onClose, extra, children }: { title: string; right: number; width: number; onClose: () => void; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="adv-sh-pick" data-lg="pop" style={{ position: 'absolute', right, width }} role="dialog" aria-label={title}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1, color: 'var(--text-strong)', fontWeight: 500 }}>{title}</span>
        {extra}
        <button type="button" className="adv-sh-ib sm" aria-label={tr('lootfilter_advanced_shell_Pickers.close')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {children}
    </div>
  );
}

const key = (c: Color): string => c.join(',');

export function ColourPicker({
  title,
  field,
  look,
  name,
  ground,
  right,
  used,
  recent,
  onChange,
  onClose,
}: {
  title: string;
  field: 'fg' | 'bd' | 'bg';
  look: LabelStyle;
  name: string;
  ground: Ground;
  right: number;
  used: Color[];
  recent: Color[];
  onChange: (c: Color | undefined) => void;
  onClose: () => void;
}) {
  const cur = look[field];
  const c: Color = cur ?? [0, 0, 0, 0];
  const a = c[3] ?? 255;
  const cr = look.fg && look.bg ? contrast(look.fg, look.bg) : 0;
  const crShow = field !== 'bd' && cr > 0;
  const crTone = cr >= 4.5 ? ['var(--positive-text)', 'rgba(79,220,124,.12)', tr('lootfilter_advanced_shell_Pickers_2.easy_to_read')] : cr >= 3 ? ['var(--warning-text)', 'rgba(255,153,34,.12)', tr('lootfilter_advanced_shell_Pickers_2.readable')] : ['var(--negative-text)', 'rgba(239,70,86,.12)', tr('lootfilter_advanced_shell_Pickers_2.hard_to_read')];
  const set = (i: number, v: number): void => {
    const next = [c[0]!, c[1]!, c[2]!, c[3] ?? 255];
    next[i] = v;
    onChange(next[3] === 255 ? next.slice(0, 3) : next);
  };
  const sw = (list: Color[], max: number): React.ReactNode =>
    list.slice(0, max).map((s) => (
      <button key={key(s)} type="button" title={tr('lootfilter_advanced_shell_Pickers.rgb_v1_v2_v3_v4', { value: s[0], value2: s[1], value3: s[2], value4: s[3] !== undefined && s[3] < 255 ? `, ${s[3]}` : '' })} aria-label={tr('lootfilter_advanced_shell_Pickers.colour_v1', { value: key(s) })} onClick={() => onChange(s)} className="adv-sh-sw" style={{ background: rgba(s), borderColor: cur && key(cur) === key(s) ? 'var(--gold-400)' : 'rgba(255,255,255,.18)' }} />
    ));
  return (
    <PickShell title={title} right={right} width={360} onClose={onClose}>
      <div style={{ padding: 14, borderRadius: 10, background: groundFor(ground), display: 'flex', justifyContent: 'center' }}>
        <LabelChip name={name} style={look} bright={ground === 'bright'} />
      </div>
      <span className="lf-eyebrow" style={{ fontSize: 10 }}>{tr('lootfilter_advanced_shell_Pickers.game_colours')}</span>
      <div className="adv-sh-swgrid">{sw(GAME_SWATCHES, 14)}</div>
      {used.length > 0 && (
        <>
          <span className="lf-eyebrow" style={{ fontSize: 10 }}>{tr('lootfilter_advanced_shell_Pickers.used_in_this_filter')}</span>
          <div className="adv-sh-swgrid">{sw(used, 14)}</div>
        </>
      )}
      {recent.length > 0 && (
        <>
          <span className="lf-eyebrow" style={{ fontSize: 10 }}>{tr('lootfilter_advanced_shell_Pickers.recent')}</span>
          <div className="adv-sh-swgrid">{sw(recent, 7)}</div>
        </>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
        {(['R', 'G', 'B', 'A'] as const).map((l, i) => (
          <label key={l} style={{ display: 'flex', flexDirection: 'column', gap: 3, color: 'var(--text-muted)', fontSize: 11 }}>
            {l}
            <NumInput value={i === 3 ? a : c[i]!} min={0} max={255} label={l} onCommit={(v) => set(i, v)} />
          </label>
        ))}
      </div>
      <RangeInput value={a} min={0} max={255} label={tr('lootfilter_advanced_shell_Pickers.alpha')} onCommit={(v) => set(3, v)} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {crShow ? (
          <>
            <span style={{ height: 22, padding: '0 8px', borderRadius: 11, display: 'flex', alignItems: 'center', font: '600 11.5px Geist', color: crTone[0], background: crTone[1] }}>{cr.toFixed(1)} : 1</span>
            <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 12 }}>{tr('lootfilter_advanced_shell_Pickers.crtone_text_against_the_background', { crTone: crTone[2] })}</span>
          </>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <button type="button" className="adv-sh-btn sm text" onClick={() => onChange(undefined)}>
          {tr('lootfilter_advanced_shell_Pickers.not_set')}
        </button>
      </div>
    </PickShell>
  );
}

export function SoundPicker({
  look,
  right,
  preview,
  onChange,
  onClose,
}: {
  look: LabelStyle;
  right: number;
  preview: boolean;
  onChange: (s: LabelStyle['sound']) => void;
  onClose: () => void;
}) {
  const s = look.sound;
  const builtin = s && s.kind === 'builtin' ? s : null;
  const vol = s ? s.vol : 150;
  const [file, setFile] = useState(s && s.kind === 'custom' ? s.file : '');
  const hover = useRef<number | undefined>(undefined);
  const audition = (id: number): void => {
    if (preview) playAlertTone(id, vol);
  };
  return (
    <PickShell title={tr('lootfilter_advanced_shell_Pickers.alert_sound')} right={right} width={480} onClose={onClose} extra={<span style={{ color: 'var(--text-muted)', fontSize: 12, marginRight: 6 }}>{preview ? tr('lootfilter_advanced_shell_Pickers.hover_press_or_focus_a') : tr('lootfilter_advanced_shell_Pickers.previews_are_off_in_settings')}</span>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 6 }}>
        {SOUND_NAMES.map((n, i) => {
          const id = i + 1;
          const on = builtin?.id === id;
          return (
            <div
              key={n}
              onMouseEnter={() => {
                window.clearTimeout(hover.current);
                hover.current = window.setTimeout(() => audition(id), 150);
              }}
              onMouseLeave={() => window.clearTimeout(hover.current)}
              className="adv-sh-sndrow"
              style={{ borderColor: on ? 'var(--gold-400)' : 'rgba(var(--line-rgb),.1)', background: on ? 'rgba(var(--accent-rgb),.12)' : 'transparent' }}
            >
              <button type="button" aria-label={tr('lootfilter_advanced_shell_Pickers.play_n', { n })} title={tr('lootfilter_advanced_shell_Pickers.play_a_preview_tone')} className="adv-sh-ib sm" style={{ color: 'var(--gold-text)', background: 'rgba(var(--line-rgb),.07)' }} onClick={() => playAlertTone(id, vol)}>
                <Icon name="caret-right" size={12} />
              </button>
              <button type="button" className="adv-sh-sndpick" onFocus={() => audition(id)} onClick={() => { audition(id); onChange({ kind: 'builtin', id, vol, ...(builtin?.positional ? { positional: true } : {}) }); }}>
                <span style={{ color: 'var(--text-faint)', font: "500 10.5px 'Geist Mono'" }}>{id}</span>
                {n}
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="adv-sh-btn" style={{ borderColor: s === null ? 'var(--gold-400)' : undefined }} onClick={() => onChange(null)}>
        {tr('lootfilter_advanced_shell_Pickers.none_silent')}
      </button>
      <div style={{ display: 'grid', gridTemplateColumns: '60px minmax(0,1fr) 64px', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'var(--text-2)' }}>{tr('lootfilter_advanced_shell_Pickers.volume')}</span>
        <RangeInput value={vol} min={0} max={300} label={tr('lootfilter_advanced_shell_Pickers.volume')} onCommit={(v) => s && onChange({ ...s, vol: v })} />
        <NumInput value={vol} min={0} max={300} label={tr('lootfilter_advanced_shell_Pickers.volume_number')} onCommit={(v) => s && onChange({ ...s, vol: v })} />
      </div>
      <button type="button" className="adv-sh-check" onClick={() => builtin && onChange({ ...builtin, positional: !builtin.positional })} aria-pressed={!!builtin?.positional} disabled={!builtin}>
        <span className="adv-sh-tog" data-on={builtin?.positional ? '1' : '0'}>
          <span />
        </span>
        {tr('lootfilter_advanced_shell_Pickers.positional_louder_when_the_item')}
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 9, border: '1px dashed rgba(var(--line-rgb),.2)' }}>
        <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Pickers.custom_sound_a_mp3_already')}</span>
        <input className="adv-sh-field" aria-label={tr('lootfilter_advanced_shell_Pickers.custom_sound_file_name')} placeholder={tr('lootfilter_advanced_shell_Pickers.my_sound_mp3')} value={file} onChange={(e) => setFile(e.target.value)} style={{ width: 130, height: 28 }} />
        <button type="button" className="adv-sh-btn sm" disabled={!file.trim()} onClick={() => onChange({ kind: 'custom', file: file.trim(), vol })}>
          {tr('lootfilter_advanced_shell_Pickers.use')}
        </button>
      </div>
    </PickShell>
  );
}

export function IconPicker({ look, right, onChange, onClose }: { look: LabelStyle; right: number; onChange: (s: LabelStyle['icon']) => void; onClose: () => void }) {
  const ic = look.icon;
  const size = ic?.size ?? 1;
  const sizes: { v: 0 | 1 | 2; l: string }[] = [
    { v: 0, l: tr('lootfilter_advanced_shell_Pickers_2.large') },
    { v: 1, l: tr('lootfilter_advanced_shell_Pickers_2.medium') },
    { v: 2, l: tr('lootfilter_advanced_shell_Pickers_2.small') },
  ];
  return (
    <PickShell
      title={tr('lootfilter_advanced_shell_Pickers.minimap_icon')}
      right={right}
      width={470}
      onClose={onClose}
      extra={
        <span className="adv-sh-seg" role="group" aria-label={tr('lootfilter_advanced_shell_Pickers.icon_size')}>
          {sizes.map((s) => (
            <button key={s.v} type="button" aria-pressed={size === s.v} onClick={() => ic && onChange({ ...ic, size: s.v })}>
              {s.l}
            </button>
          ))}
        </span>
      }
    >
      <div style={{ padding: 8, borderRadius: 10, background: 'rgba(10,16,24,.8)', display: 'grid', gridTemplateColumns: '56px repeat(12,28px)', gap: 2, alignItems: 'center', overflowX: 'auto' }}>
        <span />
        {MINIMAP_SHAPES.map((sh) => (
          <span key={sh} title={shapeName(sh)} style={{ display: 'flex', justifyContent: 'center' }}>
            <svg width="9" height="9" viewBox="0 0 10 10">
              <path d={SHAPE_PATH[sh]} fill="rgba(255,255,255,.35)" />
            </svg>
          </span>
        ))}
        {MINIMAP_COLOURS.map((col) => (
          <ColourRow key={col} col={col} cur={ic} size={size} onPick={(shape) => onChange({ size: size as 0 | 1 | 2, colour: col, shape })} />
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, color: 'var(--text-2)', fontSize: 12.5 }}>{ic ? `${sizeName(ic.size)} ${colourName(ic.colour)} ${shapeName(ic.shape)}` : look.icon === null ? tr('lootfilter_advanced_shell_Pickers.no_icon_on_the_minimap') : tr('lootfilter_advanced_shell_Pickers.not_set_keeps_neversink_s')}</span>
        <button type="button" className="adv-sh-btn sm" onClick={() => onChange(null)}>
          {tr('lootfilter_advanced_shell_Pickers.no_icon')}
        </button>
      </div>
    </PickShell>
  );
}

function ColourRow({ col, cur, size, onPick }: { col: string; cur: LabelStyle['icon']; size: number; onPick: (shape: string) => void }) {
  return (
    <>
      <span style={{ color: 'rgba(255,255,255,.6)', fontSize: 11 }}>{colourName(col)}</span>
      {MINIMAP_SHAPES.map((sh) => {
        const on = cur?.colour === col && cur.shape === sh;
        return (
          <button key={sh} type="button" title={`${colourName(col)} ${shapeName(sh)}`} aria-label={`${colourName(col)} ${shapeName(sh)}`} onClick={() => onPick(sh)} className="adv-sh-icell" style={{ borderColor: on ? 'var(--gold-400)' : 'transparent', background: on ? 'rgba(255,255,255,.12)' : 'transparent' }}>
            <svg width={[14, 12, 10][size] ?? 12} height={[14, 12, 10][size] ?? 12} viewBox="0 0 10 10">
              <path d={SHAPE_PATH[sh]} fill={COLOUR_HEX[col] ?? '#fff'} stroke="rgba(0,0,0,.8)" strokeWidth=".7" />
            </svg>
          </button>
        );
      })}
    </>
  );
}

export function BeamPicker({ look, right, onChange, onClose }: { look: LabelStyle; right: number; onChange: (b: LabelStyle['beam']) => void; onClose: () => void }) {
  const b = look.beam;
  return (
    <PickShell
      title={tr('lootfilter_advanced_shell_Pickers.light_beam')}
      right={right}
      width={420}
      onClose={onClose}
      extra={
        <span className="adv-sh-seg" role="group" aria-label={tr('lootfilter_advanced_shell_Pickers.beam_length')}>
          {[
            { v: false, l: tr('lootfilter_advanced_shell_Pickers_2.permanent') },
            { v: true, l: tr('lootfilter_advanced_shell_Pickers_2.temporary') },
          ].map((s) => (
            <button key={s.l} type="button" aria-pressed={!!b?.temp === s.v} onClick={() => b && onChange({ colour: b.colour, ...(s.v ? { temp: true } : {}) })}>
              {s.l}
            </button>
          ))}
        </span>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(11,1fr)', gap: 4, padding: '10px 8px 6px', borderRadius: 10, background: groundFor('dark') }}>
        {MINIMAP_COLOURS.map((c) => (
          <button key={c} type="button" title={colourName(c)} aria-label={tr('lootfilter_advanced_shell_Pickers.c_beam', { c: colourName(c) })} onClick={() => onChange({ colour: c, ...(b?.temp ? { temp: true } : {}) })} className="adv-sh-beamcol" style={{ borderColor: b?.colour === c ? 'var(--gold-400)' : 'transparent', background: b?.colour === c ? 'rgba(255,255,255,.1)' : 'transparent' }}>
            <span style={{ width: 5, height: 56, borderRadius: 3, background: `linear-gradient(0deg,${COLOUR_HEX[c]},transparent)`, filter: 'blur(.6px)' }} />
            <span style={{ color: 'rgba(255,240,215,.7)', fontSize: 9.5 }}>{colourName(c)}</span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, color: 'var(--text-2)', fontSize: 12.5 }}>{b ? tr(b.temp ? 'h_lootB_Names.beam_colour_temp' : 'h_lootB_Names.beam_colour', { colour: colourName(b.colour) }) : look.beam === null ? tr('lootfilter_advanced_shell_Pickers.no_beam') : tr('lootfilter_advanced_shell_Pickers.not_set_keeps_neversink_s_2')}</span>
        <button type="button" className="adv-sh-btn sm" onClick={() => onChange(null)}>
          {tr('lootfilter_advanced_shell_Pickers.no_beam')}
        </button>
      </div>
    </PickShell>
  );
}

