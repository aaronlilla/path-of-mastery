import type { ItemInfo } from '@pom/protocol';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../ui';
import { Over } from './dialogs';
import { PassiveTreeView, type PassiveTree, type TreeState as RenderTreeState } from '../tree';
import { PickButton, type MenuEntry } from './parts';
import type { SlotDef } from './slots';
import type { ItemsEnv } from './useItems';
import { tr } from '../i18n';

/** The outer radius of each label, in tree units. */
const OUTER: Record<string, number> = { Small: 960, Medium: 1440, Large: 1800, 'Very Large': 2400, Massive: 2880, Variable: 2040 };

/** A jewel's radius on the passive tree: the Tree tab's renderer, with the radius drawn round the chosen socket. */
export function RadiusDialog({ info, env, sockets: all, initial, openMenu, onClose }: { info: ItemInfo; env: ItemsEnv; sockets: SlotDef[]; initial?: number; openMenu: (anchor: HTMLElement, entries: MenuEntry[], width?: number) => void; onClose: () => void }) {
  // The sockets in the Items tab's order (the tree's node order, "Socket #1, #2, ..."), cluster sockets among them: the
  // size note (Large, Medium, Small) says which they are, and the numbering in the list matches the slot list.
  const sockets = all;
  const [socket, setSocket] = useState<number | undefined>(initial ?? sockets[0]?.nodeId);
  const [ready, setReady] = useState(false);
  const tree = useRef<PassiveTree | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const state = env.tree as unknown as RenderTreeState | null;
  const cur = sockets.find((s) => s.nodeId === socket);
  const label = info.jewelRadius || 'Large';

  useEffect(() => {
    const t = tree.current;
    if (!ready || !t || socket === undefined) return;
    t.setRadiusPreview(socket, label, info.title ?? info.name ?? '', info.jewelRadiusIndex);
    // Frame the socket so its radius fills most of the view.
    const timer = window.setTimeout(() => {
      const box = host.current;
      const half = box ? Math.min(box.clientWidth, box.clientHeight) / 2 : 250;
      t.focusNode(socket, (half * 0.9) / (OUTER[label] ?? 2040));
    }, 350);
    return () => {
      window.clearTimeout(timer);
      t.setRadiusPreview(null);
    };
  }, [ready, socket, label, info.title, info.name, info.jewelRadiusIndex]);

  return (
    <Over>
    <Dialog size="large" title={tr('items_RadiusDialog.jewel_radius')} subtitle={tr('items_RadiusDialog.name_label_radius', { name: info.title ?? info.name, label })} cancelLabel={tr('items_RadiusDialog.close')} confirmLabel={null} onCancel={onClose}>
      <div className="it-frow" style={{ marginBottom: 10 }}>
        <span className="k" style={{ width: 70 }}>{tr('items_RadiusDialog.socket')}</span>
        {sockets.length ? (
          <PickButton
            dataKey="radius:socket"
            value={cur ? `${cur.label}${cur.note ? ` (${cur.note})` : ''}` : tr('items_RadiusDialog_2.choose_a_socket')}
            onOpen={(el) => openMenu(el, sockets.map((s) => ({ key: String(s.nodeId), label: `${s.label}${s.note ? ` (${s.note})` : ''}`, on: s.nodeId === socket, run: () => setSocket(s.nodeId) })), 260)}
          />
        ) : (
          <span className="it-sub">{tr('items_RadiusDialog.the_build_has_no_jewel')}</span>
        )}
      </div>
      <div ref={host} data-r="radius-tree" style={{ height: 'min(62vh, 640px)', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(var(--line-rgb), .18)' }}>
        {state ? (
          <PassiveTreeView
            key={state.treeVersion}
            base={`game/tree/${state.treeVersion}/`}
            state={state}
            fit="alloc"
            maxDpr={2}
            onReady={(t) => {
              tree.current = t;
              setReady(true);
            }}
          />
        ) : (
          <span className="it-sub" style={{ padding: 16, display: 'block' }}>{tr('items_RadiusDialog.the_passive_tree_is_not')}</span>
        )}
      </div>
    </Dialog>
    </Over>
  );
}
