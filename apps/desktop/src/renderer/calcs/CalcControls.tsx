import { useCallback, useRef, useState, type ReactNode } from 'react';
import './calcs.css';
import { PortalMenu, Icon } from '../ui';

export interface SelOption {
  value: string;
  node: ReactNode;
  sub?: string;
  img?: string;
}

/** A toolbar dropdown: the design's captioned trigger and a glass menu (arrows and Enter choose, Escape closes). */
export function CalcSelect({ caption, ariaLabel, value, valueNode, options, onChange, grow, basis, disabled, title, emptyOption }: { caption: string; ariaLabel: string; value: string; valueNode: ReactNode; options: SelOption[]; onChange: (v: string) => void; grow: number; basis: number; disabled?: boolean; title?: string; emptyOption?: { label: string; action: string } }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const openMenu = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
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
      setActive((a) => (a + 1) % Math.max(1, options.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + options.length) % Math.max(1, options.length));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options[active];
      if (o) onChange(o.value);
      setOpen(false);
    }
  };
  return (
    <div className="calc-sel" style={{ flex: `${grow} 1 ${basis}px` }} title={disabled ? title : undefined}>
      <button ref={trigger} type="button" className="trig" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} disabled={disabled} title={title} onClick={() => (open ? setOpen(false) : openMenu())} onKeyDown={onKey}>
        <span className="tx">
          <span className="k">{caption}</span>
          <span className="v">{valueNode}</span>
        </span>
        <Icon name="chevron-down" size={12} />
      </button>
      <PortalMenu anchor={trigger} open={open} onClose={close} role="listbox" label={ariaLabel} minWidth={Math.max(240, basis)}>
        {options.length === 0 && emptyOption && <div className="menu-item" aria-disabled="true" style={{ color: 'var(--text-muted)' }}>{emptyOption.label}</div>}
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={o.value === value}
            data-active={i === active}
            className="menu-item"
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              onChange(o.value);
              setOpen(false);
            }}
          >
            {o.img && <img src={o.img} alt="" style={{ flex: 'none', width: 20, height: 20, objectFit: 'contain' }} />}
            <span className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span className="ellipsis">{o.node}</span>
              {o.sub && <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--text-muted)' }}>{o.sub}</span>}
            </span>
            <span style={{ flex: 'none', width: 14, display: 'flex', color: 'var(--gold-400)' }}>{o.value === value && <Icon name="check" size={13} />}</span>
          </button>
        ))}
      </PortalMenu>
    </div>
  );
}

/** A small captioned number box (skill stages, active mines): commits on Enter or when it loses focus. */
export function NumField({ caption, label, value, onCommit, placeholder }: { caption: string; label: string; value: number | null; onCommit: (n: number | null) => void; placeholder?: string }) {
  const shown = value === null ? '' : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    const d = draft;
    setDraft(null);
    if (d === null || d === shown) return;
    const n = d.trim() === '' ? null : Math.max(0, Math.floor(Number(d)));
    if (n !== null && !Number.isFinite(n)) return;
    onCommit(n);
  };
  return (
    <label className="calc-num" title={label}>
      <span className="k">{caption}</span>
      <input
        value={draft ?? shown}
        inputMode="numeric"
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') setDraft(null);
        }}
      />
    </label>
  );
}
