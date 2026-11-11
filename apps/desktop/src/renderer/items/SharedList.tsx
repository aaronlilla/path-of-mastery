import type { ItemInfo } from '@pom/protocol';
import { useEffect, useMemo, useState } from 'react';
import { addShared, removeSharedItem } from '../../shared/sharedItems.js';
import { useSignedIn } from '../accounts/useAccount';
import { Dialog, Icon, useToast } from '../ui';
import { Over } from './dialogs';
import { itemArt, rarityColour, type TipSpec, type useHoverTip } from './parts';
import type { SharedState } from './useShared';
import type { ItemsEnv } from './useItems';
import { tr } from '../i18n';

export interface SharedListProps {
  env: ItemsEnv;
  shared: SharedState;
  tip: ReturnType<typeof useHoverTip>;
  tipFor: (info: ItemInfo, def: undefined, target: { text: string }) => TipSpec;
  onOpen: (text: string, label: string) => void;
  onCtrl: (text: string, alt: boolean) => void;
  dragRef: React.MutableRefObject<{ id?: number; text?: string } | null>;
}

/** The items shared between builds (`SharedItemListControl`): drop an item on it to share it, drag one out to add it to this build. */
export function SharedList({ env, shared, tip, tipFor, onOpen, onCtrl, dragRef }: SharedListProps) {
  const toast = useToast();
  const signedIn = useSignedIn();
  const items = shared.data.items;
  const [infos, setInfos] = useState<ItemInfo[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const key = useMemo(() => items.join('\u0000'), [items]);

  useEffect(() => {
    if (!env.buildId || !items.length) {
      setInfos([]);
      return;
    }
    let dead = false;
    void env.infoMany(items).then((r) => !dead && setInfos(r)).catch(() => !dead && setInfos([]));
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, env.buildId]);

  const textOfDrag = (): string | undefined => {
    const d = dragRef.current;
    if (!d) return undefined;
    return d.text ?? (d.id !== undefined ? env.model.items.find((i) => i.id === d.id)?.text : undefined);
  };

  const remove = (i: number) => {
    shared.update((l) => removeSharedItem(l, i));
    setSel(null);
    setConfirm(null);
  };

  return (
    <>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span className="it-sub" style={{ flex: 1, whiteSpace: 'normal', lineHeight: 1.4 }}>
          {tr('items_SharedList.items_kept_here_are_in')}
          {signedIn && <> <span className="tag" data-shared-sync>{tr('items_SharedList.synced_to_your_account')}</span></>}
        </span>
        <button type="button" className="it-btn xs" disabled={sel === null} title={tr('items_SharedList.remove_the_selected_item_from')} onClick={() => sel !== null && setConfirm(sel)}>
          <Icon name="trash" size={14} />
          {tr('items_SharedList.delete')}
        </button>
      </div>
      <div
        role="listbox"
        aria-label={tr('items_SharedList.shared_items')}
        tabIndex={0}
        className="it-box"
        style={{ flex: 1, minHeight: 90 }}
        onDragOver={(e) => {
          if (dragRef.current) e.preventDefault();
        }}
        onDrop={(e) => {
          const text = textOfDrag();
          dragRef.current = null;
          if (!text) return;
          e.preventDefault();
          shared.update((l) => addShared(l, text));
          toast({ text: tr('items_SharedList.added_to_the_shared_items'), kind: 'ok', ttl: 1800 });
        }}
        onKeyDown={(e) => {
          if (sel === null) return;
          if (e.key === 'ArrowDown' && sel < items.length - 1) {
            e.preventDefault();
            setSel(sel + 1);
          } else if (e.key === 'ArrowUp' && sel > 0) {
            e.preventDefault();
            setSel(sel - 1);
          } else if (e.key === 'Delete') {
            e.preventDefault();
            setConfirm(sel);
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            void navigator.clipboard.writeText((items[sel] ?? '').replace(/\n/g, '\r\n'));
            toast({ text: tr('items_SharedList.copied_the_item_text'), kind: 'ok', ttl: 1800 });
          }
        }}
      >
        {items.map((text, i) => {
          const info = infos[i];
          const art = itemArt(info);
          return (
            <div
              key={`${i}:${text.length}:${text.slice(0, 40)}`}
              role="option"
              aria-selected={sel === i}
              className="it-li"
              draggable
              onDragStart={(e) => {
                dragRef.current = { text };
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('text/plain', info?.name ?? '');
                tip.hide();
              }}
              onDragEnd={() => (dragRef.current = null)}
              onClick={(e) => {
                setSel(i);
                if (e.ctrlKey || e.metaKey) onCtrl(text, e.shiftKey);
              }}
              onDoubleClick={() => onOpen(text, info?.name ?? tr('items_SharedList.shared_item'))}
              onMouseEnter={(e) => info?.valid && tip.show(e.currentTarget, tipFor(info, undefined, { text }))}
              onMouseLeave={tip.hide}
            >
              {art && <img src={art} alt="" />}
              <span className="n" style={{ color: rarityColour(info) }}>{info?.name ?? '…'}</span>
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="it-empty">
            <span className="s">{shared.ready ? tr('items_SharedList.this_is_a_list_of') : tr('items_SharedList.loading')}</span>
          </div>
        )}
      </div>
      {confirm !== null && (
        <Over>
          <Dialog size="small" tone="danger" icon="danger" title={tr('items_SharedList.delete_item')} confirmLabel={tr('items_SharedList.delete')} onCancel={() => setConfirm(null)} onConfirm={() => remove(confirm)}>
            <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.5 }}>{tr('items_SharedList.are_you_sure_you_want', { name: infos[confirm]?.name ?? 'this item' })}</p>
          </Dialog>
        </Over>
      )}
    </>
  );
}
