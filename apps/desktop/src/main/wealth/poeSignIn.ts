/**
 * Sign in to Path of Exile in a window of the app's own, then read the POESESSID cookie from that window's own
 * session partition. The player types his password on GGG's page; the app never sees it. The app reads cookies only
 * from its own partition and never from any browser's store. Nothing here logs, returns to the renderer or stores the
 * cookie: it is handed to the Wealth service in the main process, which keeps it in safeStorage.
 *
 * This file has no electron import so it can be tested with fakes; the window itself is in poeSignInWindow.ts.
 */

export const POE_PARTITION = 'persist:poe';
export const COOKIE_NAME = 'POESESSID';

/** The site the cookie belongs to. A test build can point it at a local fake login page. */
export function poeOrigin(env: Record<string, string | undefined> = process.env): string {
  return env.POM_TEST_LOGIN === '1' && env.POM_POE_ORIGIN ? env.POM_POE_ORIGIN.replace(/\/$/, '') : 'https://www.pathofexile.com';
}

/**
 * Hosts the sign-in window may navigate to: Path of Exile itself and the sign-in providers its login offers (Steam,
 * Twitch, Microsoft/Xbox). Anything else is opened in the system browser instead. I could not read GGG's login page
 * from here (it answers scripts with a challenge), so this list is the providers GGG is known to offer; the first
 * real sign-in shows whether one is missing.
 */
const ALLOWED_SUFFIXES = [
  'pathofexile.com',
  'steamcommunity.com',
  'steampowered.com',
  'twitch.tv',
  'login.live.com',
  'login.microsoftonline.com',
  'xbox.com',
  'live.com',
];

export function isAllowedNavigation(url: string, origin: string = poeOrigin()): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const o = new URL(origin);
  if (o.protocol === 'http:') return u.protocol === 'http:' && u.host === o.host; // the test build's local page, and only it
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return ALLOWED_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

export interface CookieLike {
  name: string;
  value: string;
  domain?: string;
}

/** The slice of an Electron session the watcher uses. */
export interface SessionLike {
  cookies: {
    on(event: 'changed', cb: () => void): unknown;
    removeListener(event: 'changed', cb: () => void): unknown;
    get(filter: { name?: string; url?: string }): Promise<CookieLike[]>;
  };
}

const domainOk = (c: CookieLike, origin: string): boolean => {
  const host = new URL(origin).hostname;
  const d = (c.domain ?? host).replace(/^\./, '').toLowerCase();
  return d === host || host.endsWith('.' + d) || d.endsWith('.' + host);
};

/** Looks for the POESESSID of this site now. Cookies of other domains and other names are ignored. */
export async function findCookie(ses: SessionLike, origin: string = poeOrigin()): Promise<string | null> {
  const list = await ses.cookies.get({ name: COOKIE_NAME, url: origin });
  const c = list.find((x) => x.name === COOKIE_NAME && x.value && domainOk(x, origin));
  return c ? c.value : null;
}

export interface Watch {
  /** Resolves with the cookie the moment the session has one; never resolves if it does not. */
  found: Promise<string>;
  /** Check now (after a navigation). */
  check(): Promise<void>;
  stop(): void;
}

export function watchCookie(ses: SessionLike, origin: string = poeOrigin()): Watch {
  let done = false;
  let resolve!: (v: string) => void;
  const found = new Promise<string>((r) => (resolve = r));
  const check = async () => {
    if (done) return;
    const v = await findCookie(ses, origin).catch(() => null);
    if (v && !done) {
      done = true;
      stop();
      resolve(v);
    }
  };
  const onChanged = () => void check();
  const stop = () => {
    done = true;
    ses.cookies.removeListener('changed', onChanged);
  };
  ses.cookies.on('changed', onChanged);
  void check();
  return { found, check, stop };
}

/** The account name in a profile-style JSON answer ({ name } or { accountName }). */
export function accountFromProfile(j: unknown): string | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as { name?: unknown; accountName?: unknown };
  const v = typeof o.accountName === 'string' ? o.accountName : typeof o.name === 'string' ? o.name : '';
  return v.trim() ? v.trim() : null;
}

/** The account name from a signed-in page: the site's own profile link, /account/view-profile/Name-1234 (Name#1234). */
export function accountFromPage(html: string): string | null {
  const m = /\/account\/view-profile\/([^"'\/?#<>\s]+)/.exec(html);
  if (!m?.[1]) return null;
  let name: string;
  try {
    name = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  // The link writes the four-digit tag after a dash; everywhere else it follows a hash.
  return name.replace(/-(\d{4})$/, '#$1') || null;
}

/** The first character name in the character list answer. */
export function firstCharacter(j: unknown): string | null {
  if (!Array.isArray(j)) return null;
  for (const c of j) if (c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string') return (c as { name: string }).name;
  return null;
}

export interface WindowLike {
  loadURL(url: string): Promise<void>;
  close(): void;
  focus(): void;
  isDestroyed(): boolean;
  onClosed(cb: () => void): void;
  /** Called after every navigation inside the window. */
  onNavigated(cb: (url: string) => void): void;
  /** The account name shown by the page that is open now (the site's own profile link), or null when not signed in. */
  accountInPage?(): Promise<string | null>;
}

export type SignInResult = { ok: true; cookie: string; account: string } | { ok: false; reason: 'closed' | 'no-account' | 'error'; message: string };

export interface SignInDeps {
  session: SessionLike;
  createWindow(): WindowLike;
  /** Reads the signed-in account's name (Name#1234) from the profile endpoint, with the partition's own cookies. */
  accountName(): Promise<string | null>;
  /** What each account-name source answered on the last lookup (status codes only), for the failure message. */
  lookupTrail?(): string;
  /** How long to wait before asking for the account name again while the window is open (default 2 s). */
  retryMs?: number;
  clearPartition(): Promise<void>;
  origin?: string;
}

export class PoeSignIn {
  private win: WindowLike | null = null;
  private job: Promise<SignInResult> | null = null;

  constructor(private readonly d: SignInDeps) {}

  /** Opens the login window (or focuses the open one) and resolves when the player is signed in or closes it. */
  open(): Promise<SignInResult> {
    if (this.job) {
      if (this.win && !this.win.isDestroyed()) this.win.focus();
      return this.job;
    }
    this.job = this.run().finally(() => {
      this.job = null;
      this.win = null;
    });
    return this.job;
  }

  private async run(): Promise<SignInResult> {
    const origin = this.d.origin ?? poeOrigin();
    const win = this.d.createWindow();
    this.win = win;
    const watch = watchCookie(this.d.session, origin);
    let closed = false;
    const closedP = new Promise<'closed'>((r) =>
      win.onClosed(() => {
        closed = true;
        r('closed');
      }),
    );
    // A session cookie exists before the site has finished the login (an emailed unlock code, a provider's consent page),
    // so the cookie alone proves nothing. The sign-in is done when the account name can be read, and the window stays
    // open until then. Every navigation, and a slow tick, asks again.
    let wake: () => void = () => undefined;
    win.onNavigated(() => {
      void watch.check();
      wake();
    });
    try {
      await win.loadURL(`${origin}/login`).catch(() => undefined);
      const got = await Promise.race([watch.found, closedP]);
      if (got === 'closed') return { ok: false, reason: 'closed', message: 'The sign-in window was closed before you signed in.' };
      let account: string | null = null;
      while (!closed && !account) {
        account = await this.d.accountName().catch(() => null);
        if (account || closed) break;
        await Promise.race([closedP, new Promise<void>((r) => { wake = r; setTimeout(r, this.d.retryMs ?? 2000); })]);
      }
      if (!account) {
        const trail = this.d.lookupTrail?.() ?? '';
        return { ok: false, reason: 'no-account', message: `The sign-in window was closed before Path of Exile finished signing you in${trail ? ` (${trail})` : ''}. Try again and keep the window open until it closes by itself, or use \"Paste a cookie instead\".` };
      }
      // The cookie as it is now: the site may replace it when the login completes.
      const cookie = (await findCookie(this.d.session, origin).catch(() => null)) ?? got;
      if (!closed && !win.isDestroyed()) win.close();
      return { ok: true, cookie, account };
    } catch {
      return { ok: false, reason: 'error', message: 'Could not open the sign-in window.' };
    } finally {
      watch.stop();
      if (!closed && !win.isDestroyed()) win.close();
    }
  }

  /** Forgets the sign-in: the partition's cookies and storage are cleared. */
  async clear(): Promise<void> {
    await this.d.clearPartition();
  }
}
