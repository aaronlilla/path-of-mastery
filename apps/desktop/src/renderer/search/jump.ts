// Picking a search result: ring the thing on its tab with the assistant's highlight (the tabs already open the group, slot,
// row or node for it), scroll it into view, and put the ring away after a few seconds (no caption chip needs clicking away).
import { setHighlight, getHighlight } from '../assistant/bus';
import type { ShowTarget } from '../../shared/assistant/types.js';
import { tr } from '../i18n';

export function jumpTo(target: ShowTarget, title: string): void {
  setHighlight({ ...target, head: tr('h_search_jump.found'), text: title });
  const key = getHighlight()!.key;
  const t0 = performance.now();
  const find = () => {
    if (getHighlight()?.key !== key) return;
    const el = [...document.querySelectorAll<HTMLElement>('[data-assistant-highlight]')].find((e) => e.getClientRects().length);
    if (el) { if (!el.hasAttribute('data-asst-ring')) el.scrollIntoView({ block: 'center', inline: 'nearest' }); return; }
    if (performance.now() - t0 < 2500) requestAnimationFrame(find);
  };
  requestAnimationFrame(find);
  window.setTimeout(() => { if (getHighlight()?.key === key) setHighlight(null); }, 6000);
}
