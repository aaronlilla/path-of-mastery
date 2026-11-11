// Tooltips for controls that show no words: a button that holds only an icon gets its aria-label as its tooltip, so a
// mouse user can read what it does. Controls whose label is already on screen are left alone (no repeated text), and text
// that is cut off with an ellipsis gets its full text as a tooltip while the pointer is over it.

const ICON_ONLY = 'button[aria-label]:not([title]), [role="button"][aria-label]:not([title])';

function visibleText(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, '').length ? (el.innerText ?? el.textContent ?? '').trim() : '';
}

function label(el: HTMLElement): void {
  if (el.hasAttribute('title') || visibleText(el)) return;
  const l = el.getAttribute('aria-label');
  if (l) el.setAttribute('title', l);
}

export function installAutoTitles(): void {
  if (typeof document === 'undefined' || (window as unknown as { __autoTitles?: boolean }).__autoTitles) return;
  (window as unknown as { __autoTitles?: boolean }).__autoTitles = true;
  const scan = (root: ParentNode) => root.querySelectorAll<HTMLElement>(ICON_ONLY).forEach(label);
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => n instanceof HTMLElement && (n.matches(ICON_ONLY) ? label(n) : scan(n)));
  }).observe(document.body, { childList: true, subtree: true });
  scan(document.body);

  // Cut-off text: set the tooltip only when something is actually hidden by an ellipsis.
  document.addEventListener(
    'pointerover',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const el = t.closest<HTMLElement>('.ellipsis, .tb-title, .tb-sub, .row .name, .card .nmt, .card .sub, .path-pill, [data-cut-title]');
      if (!el) return;
      if (el.scrollWidth > el.clientWidth + 1 || (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflow === 'hidden')) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text && el.getAttribute('title') !== text) el.setAttribute('title', text);
      } else if (el.hasAttribute('title') && el.getAttribute('title') === (el.innerText || el.textContent || '').trim()) {
        el.removeAttribute('title');
      }
    },
    true,
  );
}
