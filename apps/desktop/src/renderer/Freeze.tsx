import { createContext, Suspense, useContext, useId, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const never: Promise<never> = new Promise(() => undefined);

function Hold({ freeze, children }: { freeze: boolean; children: ReactNode }): ReactNode {
  if (freeze) throw never;
  return children;
}

/** The kept tab an overlay was opened from (see `portal`). */
const PortalOwner = createContext<string | null>(null);

function Owned({ host, children }: { host: Element | DocumentFragment; children: ReactNode }) {
  const owner = useContext(PortalOwner);
  return createPortal(owner ? <div data-owner={owner} style={{ display: 'contents' }}>{children}</div> : children, host);
}

/**
 * \`createPortal\` for overlays (tooltips, menus, popups): inside a kept tab the overlay is marked with that tab, so it is
 * hidden while the tab is (a portal is drawn outside the tab's own box, which React's hiding does not reach).
 */
export function portal(children: ReactNode, host: Element | DocumentFragment): ReactNode {
  return <Owned host={host}>{children}</Owned>;
}

let sheet: CSSStyleSheet | null = null;
const hidden = new Set<string>();
function setHidden(owner: string, on: boolean): void {
  if (on) hidden.add(owner);
  else hidden.delete(owner);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  sheet.replaceSync([...hidden].map((o) => `[data-owner="${o}"]{display:none !important}`).join('\n'));
}

/**
 * Keeps a tab that has been opened alive while another tab shows. Frozen, it is hidden by React (display: none) and does
 * not render: its state, scroll position and loaded data are kept, and showing it again is one render with the latest
 * props instead of building the tab from nothing (0.25 to 0.5 s for Items, Calcs, Config and Skills). Its overlays are
 * hidden with it; any tooltip still open from before is closed when it shows again (the tips close on a window blur).
 */
export function Freeze({ freeze, children }: { freeze: boolean; children: ReactNode }) {
  const owner = useId();
  useLayoutEffect(() => {
    setHidden(owner, freeze);
    if (!freeze) window.dispatchEvent(new Event('blur'));
  }, [owner, freeze]);
  useLayoutEffect(() => () => setHidden(owner, false), [owner]);
  return (
    <PortalOwner.Provider value={owner}>
      <Suspense fallback={null}>
        <Hold freeze={freeze}>{children}</Hold>
      </Suspense>
    </PortalOwner.Provider>
  );
}
