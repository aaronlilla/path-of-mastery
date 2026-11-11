// Keyboard focus for every overlay in the app (modal dialogs, the command palette, the account menu, dropdowns and menus):
// focus moves inside when one opens, Tab stays inside while it is open, and focus goes back to the control that opened it
// when it closes. One observer does this for all of them, so a dialog added later gets it without any code of its own.

/** What counts as an overlay. Inline lists that happen to carry a role (such as a listbox in a dialog) do not. */
export const LAYER_SELECTOR = '[role="dialog"][aria-modal="true"], .search-box, .acct-menu, .menu.portal:not([role="listbox"])';

// Links only: an icon's <use href> (one shared symbol per icon) is not something Tab can reach.
const FOCUSABLE = 'button:not([disabled]), a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

interface Layer {
  el: HTMLElement;
  opener: HTMLElement | null;
}

const layers: Layer[] = [];
/** The last control outside every overlay that had focus: where focus goes back to when an overlay closes. */
let lastOutside: HTMLElement | null = null;

const visible = (e: HTMLElement) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';

/** The controls inside `el` that Tab can reach, in order. */
export function focusablesIn(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => visible(e) && !e.closest('[inert]'));
}

function isLayer(n: Node): n is HTMLElement {
  return n instanceof HTMLElement && n.matches(LAYER_SELECTOR);
}

function layersWithin(n: Node): HTMLElement[] {
  if (!(n instanceof HTMLElement)) return [];
  return [...(isLayer(n) ? [n] : []), ...n.querySelectorAll<HTMLElement>(LAYER_SELECTOR)];
}

function moveInside(l: Layer): void {
  const a = document.activeElement;
  if (a && l.el.contains(a) && a !== l.el) return;
  const inner = focusablesIn(l.el);
  const target = l.el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? inner.find((e) => e.matches('input, textarea, [role="menuitem"], [role="option"][aria-selected="true"]')) ?? inner[0];
  if (target) target.focus({ preventScroll: true });
  else {
    if (!l.el.hasAttribute('tabindex')) l.el.setAttribute('tabindex', '-1');
    l.el.focus({ preventScroll: true });
  }
}

export function installFocusLayers(): void {
  if (typeof document === 'undefined' || (window as unknown as { __focusLayers?: boolean }).__focusLayers) return;
  (window as unknown as { __focusLayers?: boolean }).__focusLayers = true;

  const sync = (added: Node[], removedAny: boolean) => {
    // Layers that left the page first: focus goes back to the control that opened the top one, unless another layer took over.
    let inherited: HTMLElement | null = null;
    if (removedAny) {
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i]!;
        if (l.el.isConnected) continue;
        layers.splice(i, 1);
        inherited = l.opener ?? inherited;
      }
    }
    const fresh: Layer[] = [];
    for (const n of added) {
      for (const el of layersWithin(n)) {
        if (layers.some((l) => l.el === el)) continue;
        const l: Layer = { el, opener: lastOutside && lastOutside.isConnected && !el.contains(lastOutside) ? lastOutside : inherited };
        layers.push(l);
        fresh.push(l);
      }
    }
    if (fresh.length) {
      // Let the component finish its own focus handling first, then make sure focus is inside.
      requestAnimationFrame(() => fresh.forEach((l) => l.el.isConnected && layers[layers.length - 1] === l && moveInside(l)));
      return;
    }
    if (removedAny && inherited && inherited.isConnected) {
      const a = document.activeElement;
      const top = layers[layers.length - 1];
      if (top) {
        if (!(a && top.el.contains(a))) moveInside(top);
      } else if (!a || a === document.body || !document.contains(a)) {
        inherited.focus({ preventScroll: true });
      }
    }
  };

  new MutationObserver((muts) => {
    const added: Node[] = [];
    let removedAny = false;
    for (const m of muts) {
      m.addedNodes.forEach((n) => added.push(n));
      if (m.removedNodes.length) removedAny = true;
    }
    sync(added, removedAny);
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && t !== document.body && !t.closest(LAYER_SELECTOR)) lastOutside = t;
    },
    true,
  );

  // Layers present at start-up.
  sync([document.body], false);

  // A control inside an overlay that disappears (it re-rendered, a button became disabled) must not leave focus on the page.
  document.addEventListener(
    'focusout',
    () => {
      requestAnimationFrame(() => {
        const top = layers[layers.length - 1];
        const a = document.activeElement;
        if (top && top.el.isConnected && (!a || a === document.body)) moveInside(top);
      });
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      for (let i = layers.length - 1; i >= 0; i--) if (!layers[i]!.el.isConnected) layers.splice(i, 1);
      const top = layers[layers.length - 1];
      if (!top) return;
      const f = focusablesIn(top.el);
      const a = document.activeElement as HTMLElement | null;
      if (!f.length) {
        e.preventDefault();
        e.stopPropagation();
        moveInside(top);
        return;
      }
      const first = f[0]!;
      const last = f[f.length - 1]!;
      const inside = !!a && top.el.contains(a);
      if (!inside) {
        e.preventDefault();
        e.stopPropagation();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (a === first || a === top.el)) {
        e.preventDefault();
        e.stopPropagation();
        last.focus();
      } else if (!e.shiftKey && a === last) {
        e.preventDefault();
        e.stopPropagation();
        first.focus();
      }
    },
    true,
  );
}
