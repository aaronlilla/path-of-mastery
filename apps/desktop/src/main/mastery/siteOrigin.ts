/**
 * The site API origin: the baked value, or POM_SITE_ORIGIN in an unpackaged run. Null when neither is set.
 * `localhost` is turned into 127.0.0.1 because the transports only accept the literal loopback address.
 * An origin that is not https and not loopback is refused by the transports, so a typo cannot send tokens in clear text.
 */
export function resolveSiteOrigin(env: Record<string, string | undefined>, isPackaged: boolean, baked = ''): string | null {
  // A packaged app never honours the override: the user's access token goes only to the baked site.
  const raw = (isPackaged ? baked : env['POM_SITE_ORIGIN'] || baked).trim();
  return raw ? raw.replace(/\/+$/, '').replace(/^(http:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1') : null;
}
