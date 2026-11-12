// A small picture of a jewel socket's radius (upstream shows the tree around the socket while its list is open):
// the nodes in reach, the ones the build has in gold, the ring of the Large radius.
import { useEffect, useRef } from 'react';
import type { TimelessSocket } from '@pom/protocol';
import { tr } from '../i18n';

const SIZE = 104;

export function SocketPreview({ socket, treeVersion }: { socket: TimelessSocket; treeVersion: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = SIZE * ratio;
    c.height = SIZE * ratio;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(ratio, ratio);
    g.clearRect(0, 0, SIZE, SIZE);
    const css = getComputedStyle(c);
    const ink = css.getPropertyValue('--text-muted') || '#999';
    const gold = css.getPropertyValue('--gold-text') || '#e6b84a';
    const [maj, min] = treeVersion.split('_').map(Number);
    const outer = (maj ?? 3) > 3 || ((maj ?? 3) === 3 && (min ?? 0) >= 16) ? 1800 : 1500;
    const k = (SIZE / 2 - 3) / outer;
    const cx = SIZE / 2;
    g.strokeStyle = 'rgba(255,255,255,.18)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cx, outer * k, 0, Math.PI * 2);
    g.stroke();
    for (const [dx, dy, kind, alloc] of socket.preview ?? []) {
      g.fillStyle = alloc ? gold : ink;
      g.globalAlpha = alloc ? 1 : 0.55;
      const r = kind === 2 ? 3.2 : kind === 1 ? 2.4 : kind === 3 ? 2.6 : 1.3;
      g.beginPath();
      g.arc(cx + dx * k, cx + dy * k, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.strokeStyle = gold;
    g.beginPath();
    g.moveTo(cx - 5, cx);
    g.lineTo(cx + 5, cx);
    g.moveTo(cx, cx - 5);
    g.lineTo(cx, cx + 5);
    g.stroke();
  }, [socket, treeVersion]);
  return <canvas ref={ref} className="tl-preview" style={{ width: SIZE, height: SIZE }} aria-label={tr('timeless_SocketPreview.radius_of_socket_id', { id: socket.id })} role="img" />;
}
