import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon, PortalMenu, Switch } from './ui';

/** One entry of a captioned dropdown. `sep` draws a divider instead of a row. */
export interface CapOption {
  value: string;
  label: string;
  /** A second line under the label. */
  sub?: string;
  /** Text at the right edge (a count). */
  hint?: string;
  icon?: string;
  /** A round picture before the label (a character's class). */
  img?: string;
  sep?: boolean;
}

/**
 * The tab toolbars' dropdown: a small caption over the chosen value, and a glass menu that follows DROPDOWNS.md
 * (the chevron turns while open, arrows and Enter choose, Escape closes).
 */
export function CapSelect({ caption, valueLabel, options, value, onChange, width = 190, minWidth = 110, ariaLabel, tone, title, disabled, size, leadImg }: { size?: 'tall' | 'short'; leadImg?: string; caption: string; valueLabel: string; options: CapOption[]; value: string; onChange: (v: string) => void; width?: number | string; minWidth?: number; ariaLabel: string; tone?: 'compare'; title?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const rows = options.filter((o) => !o.sep);
  const close = useCallback(() => setOpen(false), []);
  const openMenu = () => {
    setActive(Math.max(0, rows.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + rows.length) % rows.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = rows[active];
      if (o) onChange(o.value);
      setOpen(false);
    }
  };
  const style: CSSProperties = { flex: `0 1 ${typeof width === 'number' ? width + 'px' : width}`, minWidth, display: 'flex' };
  return (
    <div style={style}>
      <button ref={trigger} type="button" className={'capsel' + (size ? ' ' + size : '')} style={{ width: '100%' }} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} title={title} disabled={disabled} onClick={() => (open ? setOpen(false) : openMenu())} onKeyDown={onKey}>
        {tone === 'compare' && <span className="dot" />}
        {leadImg && <img src={leadImg} alt="" className="ix-face" />}
        <span className="txt">
          <span className="cap">{caption}</span>
          <span className="val" title={valueLabel}>{valueLabel}</span>
        </span>
        <Icon name="chevron-down" size={12} />
      </button>
      <PortalMenu anchor={trigger} open={open} onClose={close} role="listbox" label={ariaLabel} minWidth={Math.max(220, typeof width === 'number' ? width : 0)}>
        {options.map((o, i) =>
          o.sep ? (
            <div key={`s${i}`} className="menu-sep" />
          ) : (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              data-active={rows[active]?.value === o.value}
              className="menu-item"
              onMouseEnter={() => setActive(rows.findIndex((r) => r.value === o.value))}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.img && <img src={o.img} alt="" className="ix-face" />}
              {o.icon && <Icon name={o.icon} size={14} style={{ color: 'var(--text-muted)' }} />}
              <span className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span className="ellipsis">{o.label}</span>
                {o.sub && <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--text-muted)' }}>{o.sub}</span>}
              </span>
              {o.hint && <span className="meta">{o.hint}</span>}
              <span style={{ flex: 'none', width: 14, display: 'flex', color: 'var(--gold-400)' }}>{o.value === value && <Icon name="check" size={13} />}</span>
            </button>
          ),
        )}
      </PortalMenu>
    </div>
  );
}

/** A switch with its label; clicking the label toggles it. */
export function SwitchRow({ checked, onChange, label, title, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; title?: string; disabled?: boolean }) {
  return (
    <span className="sw-row" title={title} onClick={() => !disabled && onChange(!checked)} style={disabled ? { opacity: 0.5 } : undefined}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <span>{label}</span>
    </span>
  );
}

/** The design's gold check box. */
export function CheckBox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} className="chk" onClick={() => onChange(!checked)}>
      <span className="box">{checked && <Icon name="check" size={12} style={{ color: 'var(--text-on-accent)' }} />}</span>
      {label}
    </button>
  );
}

/** A small round filter chip (radio group). */
export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="chips">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A game object's art, 20 or 24 px beside its name; nothing when there is none (never a wrong picture). */
export function Art({ src, size = 22, round }: { src: string | undefined; size?: number; round?: boolean }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <span style={{ flex: 'none', width: size, height: size }} />;
  return <img src={src} alt="" onError={() => setBad(true)} className={round ? 'art round' : 'art'} style={{ width: size, height: size }} />;
}

export function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="pc-sec">
      <span className="h">
        {title}
        {aside}
      </span>
      {children}
    </div>
  );
}
