import { BrowserWindow, session, shell } from 'electron';
import { appIconPath } from '../windows.js';
import { accountFromPage, accountFromProfile, firstCharacter, isAllowedNavigation, poeOrigin, PoeSignIn, POE_PARTITION, type WindowLike } from './poeSignIn.js';

/** The real sign-in: a window of its own on its own persistent partition, no preload, no node, sandboxed. */
export function createPoeSignIn(getParent: () => BrowserWindow | null): PoeSignIn {
  const ses = session.fromPartition(POE_PARTITION);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  const origin = poeOrigin();

  let openWc: Electron.WebContents | null = null;
  const createWindow = (): WindowLike => {
    const parent = getParent();
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      title: 'Sign in to Path of Exile',
      icon: appIconPath(),
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      autoHideMenuBar: true,
      webPreferences: { partition: POE_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    const wc = win.webContents;
    openWc = wc;
    win.on('closed', () => { if (openWc === wc) openWc = null; });
    // The title bar is the address bar: the player sees where he is typing.
    const show = (url: string) => !win.isDestroyed() && win.setTitle(`Sign in to Path of Exile · ${url}`);
    win.on('page-title-updated', (e) => e.preventDefault());
    const guard = (e: Electron.Event, url: string) => {
      if (isAllowedNavigation(url, origin)) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedNavigation(url, origin)) void win.loadURL(url);
      else if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('did-navigate', (_e, url) => show(url));
    wc.on('did-navigate-in-page', (_e, url) => show(url));
    return {
      loadURL: (u) => win.loadURL(u),
      close: () => !win.isDestroyed() && win.close(),
      focus: () => win.focus(),
      isDestroyed: () => win.isDestroyed(),
      onClosed: (cb) => win.on('closed', cb),
      onNavigated: (cb) => {
        wc.on('did-navigate', (_e, url) => cb(url));
        wc.on('did-navigate-in-page', (_e, url) => cb(url));
        wc.on('did-finish-load', () => cb(wc.getURL()));
      },
    };
  };

  // The signed-in session can open three places that carry the account name. Each is tried in turn; `trail` records
  // what each answered (status codes only), so a failure says where it stopped.
  const trail: string[] = [];
  // Reading the open page's profile link costs nothing; every other lookup is a request to pathofexile.com, and while
  // the player is still typing those count against the same limits as the stash reads. They go at most every 20 s,
  // and a 429 stops them for a minute, so a slow sign-in cannot get the player's address blocked.
  let netAfter = 0;
  const netAllowed = () => Date.now() >= netAfter;
  const spent = (status: number) => { netAfter = Date.now() + (status === 429 ? 60_000 : 20_000); };
  const get = async (path: string, accept: string) => ses.fetch(`${origin}${path}`, { credentials: 'include', headers: { Accept: accept } });
  const accountName = async (): Promise<string | null> => {
    trail.length = 0;
    const net = netAllowed();
    if (net) spent(0);
    // First the page the player is looking at: a signed-in page of the site carries a link to the player's own profile.
    // It is read inside the page, so it works whatever the site answers to requests made from outside a page.
    const wc = openWc;
    if (wc && !wc.isDestroyed()) {
      try {
        // Inside the page: the profile link, and failing that the character list and the account that owns the first character.
        const got = (await wc.executeJavaScript(
          `(async () => {
            const o = { href: null, chars: 0, byChar: null, s1: 0, s2: 0 };
            const a = document.querySelector('a[href*="/account/view-profile/"]');
            if (a) { o.href = a.getAttribute('href'); return o; }
            if (!${net}) return o;
            try {
              const r = await fetch('/character-window/get-characters', { credentials: 'include', headers: { Accept: 'application/json' } });
              o.s1 = r.status;
              const j = r.ok ? await r.json() : null;
              if (Array.isArray(j) && j.length) {
                o.chars = j.length;
                const r2 = await fetch('/character-window/get-account-name-by-character?character=' + encodeURIComponent(j[0].name), { credentials: 'include', headers: { Accept: 'application/json' } });
                o.s2 = r2.status;
                const k = r2.ok ? await r2.json() : null;
                if (k && typeof k.accountName === 'string') o.byChar = k.accountName;
              }
            } catch (e) {}
            return o;
          })()`,
          true,
        )) as { href: string | null; chars: number; byChar: string | null; s1: number; s2: number };
        const name = got.href ? accountFromPage(got.href) : got.byChar ? got.byChar.trim() : null;
        const at = wc.getURL().replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*/, '') || '/';
        trail.push(name ? 'signed-in page read' : `page ${at}: no profile link, characters ${got.s1 || 'not asked'}${got.s2 ? `, name by character ${got.s2}` : ''}`);
        if (name) return name;
        if (got.s1 === 429 || got.s2 === 429) spent(429);
      } catch {
        trail.push('page not readable');
      }
    }
    if (!net) return null;
    try {
      const res = await get('/api/profile', 'application/json');
      trail.push(`profile ${res.status}`);
      if (res.status === 429) { spent(429); return null; }
      if (res.ok) {
        const name = accountFromProfile(await res.json().catch(() => null));
        if (name) return name;
      }
    } catch {
      trail.push('profile failed');
    }
    try {
      const res = await get('/my-account', 'text/html');
      trail.push(`account page ${res.status}`);
      if (res.status === 429) { spent(429); return null; }
      if (res.ok) {
        const name = accountFromPage(await res.text());
        if (name) return name;
        trail.push('no name on the account page');
      }
    } catch {
      trail.push('account page failed');
    }
    try {
      const res = await get('/character-window/get-characters', 'application/json');
      trail.push(`characters ${res.status}`);
      if (res.status === 429) { spent(429); return null; }
      const first = res.ok ? firstCharacter(await res.json().catch(() => null)) : null;
      if (first) {
        const r2 = await get(`/character-window/get-account-name-by-character?character=${encodeURIComponent(first)}`, 'application/json');
        trail.push(`name by character ${r2.status}`);
        const name = r2.ok ? accountFromProfile(await r2.json().catch(() => null)) : null;
        if (name) return name;
      } else if (res.ok) trail.push('no characters');
    } catch {
      trail.push('characters failed');
    }
    return null;
  };

  return new PoeSignIn({
    session: ses as unknown as ConstructorParameters<typeof PoeSignIn>[0]['session'],
    createWindow,
    accountName,
    lookupTrail: () => trail.join(', '),
    clearPartition: async () => {
      await ses.clearStorageData();
      await ses.cookies.flushStore();
    },
    origin,
  });
}
