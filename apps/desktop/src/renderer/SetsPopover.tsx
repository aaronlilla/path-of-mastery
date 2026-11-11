import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Over } from './items/dialogs';
import { Dialog, Icon, PortalMenu } from './ui';
import { tr } from './i18n';

export interface SetRow {
  id: number;
  title: string;
}

/**
 * The popover under "Manage…" (design: Item sets, Skill sets, Config sets): one row per set with the active mark, the
 * name (edited in place), Copy and Delete, and a New button at the foot. Anything the design has no place for goes in
 * `footer`.
 */
export function SetsPopover({ title, noun, anchor, open, onClose, rows, current, onUse, onRename, onCopy, onDelete, onNew, newLabel, footer }: {
  title: string;
  /** "item set" or "skill set": the wording of the delete question. */
  noun: string;
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  rows: SetRow[];
  current: number;
  onUse: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onCopy: (id: number) => void;
  onDelete: (id: number) => void;
  onNew: () => void;
  newLabel: string;
  footer?: ReactNode;
}) {
  const [names, setNames] = useState<Record<number, string>>({});
  const [del, setDel] = useState<SetRow | null>(null);
  useEffect(() => {
    if (open) setNames({});
  }, [open]);
  const commit = (r: SetRow) => {
    const v = (names[r.id] ?? r.title).trim();
    setNames((n) => {
      const { [r.id]: _drop, ...rest } = n;
      return rest;
    });
    if (v && v !== (r.title || tr('SetsPopover_2.default'))) onRename(r.id, v);
  };
  return (
    <>
      <PortalMenu anchor={anchor} open={open && !del} onClose={onClose} role="dialog" label={title} minWidth={340} className="setpop">
        <div className="setpop-hd">
          <span>{title}</span>
          <button type="button" className="icon-btn" aria-label={tr('SetsPopover.close')} onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="setpop-rows">
          {rows.map((r) => {
            const on = r.id === current;
            return (
              <div key={r.id} className={'setpop-row' + (on ? ' on' : '')}>
                <button type="button" className="setpop-radio" role="radio" aria-checked={on} aria-label={tr('SetsPopover.use_title', { title: r.title || tr('SetsPopover.default') })} title={on ? tr('SetsPopover.the_set_in_use') : tr('SetsPopover.use_this_set')} onClick={() => !on && onUse(r.id)}>
                  {on && <Icon name="check" size={11} />}
                </button>
                <input
                  value={names[r.id] ?? (r.title || tr('SetsPopover_2.default'))}
                  aria-label={tr('SetsPopover.name_of_title', { title: r.title || tr('SetsPopover.default') })}
                  spellCheck={false}
                  maxLength={100}
                  onChange={(e) => setNames((n) => ({ ...n, [r.id]: e.target.value }))}
                  onBlur={() => commit(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    else if (e.key === 'Escape' && r.id in names) {
                      e.stopPropagation();
                      setNames((n) => {
                        const { [r.id]: _drop, ...rest } = n;
                        return rest;
                      });
                    }
                  }}
                />
                <button type="button" className="setpop-ico" aria-label={tr('SetsPopover.copy_title', { title: r.title || tr('SetsPopover.default') })} title={tr('SetsPopover.copy')} onClick={() => onCopy(r.id)}>
                  <Icon name="copy" size={15} />
                </button>
                <button type="button" className="setpop-ico" aria-label={tr('SetsPopover.delete_title', { title: r.title || tr('SetsPopover.default') })} title={rows.length < 2 ? tr('SetsPopover.the_last_noun_cannot_be', { noun }) : tr('SetsPopover.delete')} disabled={rows.length < 2} onClick={() => setDel(r)}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="setpop-ft">
          <button type="button" className="btn ghost sm" onClick={onNew}>
            <Icon name="plus" size={14} />
            {newLabel}
          </button>
          {footer}
        </div>
      </PortalMenu>
      {del && (
        <Over>
          <Dialog
            size="small"
            tone="danger"
            icon="danger"
            title={tr('SetsPopover.delete_touppercase_slice', { value: noun[0]!.toUpperCase(), noun: noun.slice(1) })}
            confirmLabel={tr('SetsPopover.delete')}
            onCancel={() => setDel(null)}
            onConfirm={() => {
              const id = del.id;
              setDel(null);
              onDelete(id);
            }}
          >
            <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.5 }}>{tr('SetsPopover.are_you_sure_you_want', { title: del.title || tr('SetsPopover.default') })}</p>
          </Dialog>
        </Over>
      )}
    </>
  );
}
