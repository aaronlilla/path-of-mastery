import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Icon, PortalMenu } from './ui';

export interface MenuAction {
  label?: string;
  icon?: string;
  meta?: string;
  danger?: boolean;
  sep?: boolean;
  disabled?: boolean;
  run?: () => void;
}

/** A button that opens a small glass menu of actions. */
export function ActionMenu({ trigger, actions, align = 'right', title, className }: { trigger: ReactNode; actions: MenuAction[]; align?: 'left' | 'right'; up?: boolean; title?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) return;
    const items = [...document.querySelectorAll<HTMLElement>('.menu.portal .menu-item:not([disabled])')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };
  return (
    <div style={{ position: 'relative', flex: 'none' }} onKeyDown={onKey} onClick={(e) => e.stopPropagation()}>
      <button ref={btn} type="button" className={className ?? 'btn sm icon outline'} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {trigger}
      </button>
      <PortalMenu anchor={btn} open={open} onClose={close} align={align} label={title} minWidth={200}>
        {actions.map((a, i) =>
          a.sep ? (
            <div key={i} className="menu-sep" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={'menu-item' + (a.danger ? ' danger' : '')}
              disabled={a.disabled}
              onClick={() => {
                setOpen(false);
                a.run?.();
              }}
            >
              {a.icon && <Icon name={a.icon} size={15} />}
              <span className="grow">{a.label}</span>
              {a.meta && <span className="meta">{a.meta}</span>}
            </button>
          ),
        )}
      </PortalMenu>
    </div>
  );
}
