/**
 * Every limit on what an admin can write into the remote config document, defined once and counted one way.
 *
 * Text is measured in Unicode code points: JavaScript `[...s].length` here, Postgres `char_length()` in the database
 * (the database is UTF-8, where char_length counts code points). The SQL migration validates with exactly these rules
 * (`public.ops_text_ok`, `public.ops_limits()`), and supabase/tests/admin-fuzz.test.mjs proves, on thousands of random
 * payloads, that the database accepts a payload exactly when the client parser keeps it unchanged.
 *
 * Rules for every text field:
 *  - well-formed Unicode (no lone surrogates; Postgres refuses them too),
 *  - no control characters U+0000-U+001F and U+007F-U+009F (a body may contain U+000A line feeds),
 *  - length in code points within the field's maximum,
 *  - "non-blank" fields need at least one character other than U+0020.
 */
export const LIMITS = Object.freeze({
  flagMessage: 160,
  alertTitle: 80,
  alertBody: 500,
  alertLinkLabel: 40,
  alertLinkUrl: 500,
  maintenanceMessage: 300,
  testers: 100,
  blockedVersions: 50,
  alerts: 50,
  versionLength: 64,
  /** Timestamps must fall in these UTC years (JavaScript Date.parse reads 4-digit years only). */
  yearMin: 2000,
  yearMax: 9999,
});

/** https only, ASCII host, no credentials (no '@'), no spaces. The same pattern is in the SQL migration (ops_https_ok). */
export const HTTPS_LINK_PATTERN = "^https://[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&()*+,;=:%/?#-]*)?$";
const HTTPS_LINK = new RegExp(HTTPS_LINK_PATTERN);

/** ISO timestamp as JavaScript and Postgres both read it the same way; the database stores and serves this form. */
export const ISO_TIMESTAMP_PATTERN = "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$";
const ISO_TIMESTAMP = new RegExp(ISO_TIMESTAMP_PATTERN);

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_BUT_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export interface TextRule { max: number; allowNewline?: boolean; nonBlank?: boolean }

/** True when `v` is a string that satisfies the rule (see the header). */
export function textOk(v: unknown, rule: TextRule): v is string {
  if (typeof v !== 'string') return false;
  if (LONE_SURROGATE.test(v)) return false;
  if ((rule.allowNewline ? CONTROL_BUT_LF : CONTROL).test(v)) return false;
  if (codePointLength(v) > rule.max) return false;
  if (rule.nonBlank && !/[^ ]/.test(v)) return false;
  return true;
}

export function httpsLinkOk(v: unknown): v is string {
  return typeof v === 'string' && v.length <= LIMITS.alertLinkUrl && HTTPS_LINK.test(v);
}

/** An ISO timestamp in the allowed years that Date.parse reads. */
export function timestampOk(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_TIMESTAMP.test(v)) return false;
  // The calendar day must exist (Postgres refuses 30 February; Date.parse would roll it over).
  const [y0, m0, d0] = [Number(v.slice(0, 4)), Number(v.slice(5, 7)), Number(v.slice(8, 10))];
  if (d0 > new Date(Date.UTC(y0, m0, 0)).getUTCDate()) return false;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return false;
  const y = new Date(t).getUTCFullYear();
  return y >= LIMITS.yearMin && y <= LIMITS.yearMax;
}

/** A JSON array of distinct values all from `allowed` (no duplicates: a duplicate is refused, not silently merged). */
export function distinctSubset<T extends string>(v: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(v) || v.length > allowed.length) return null;
  if (!v.every((x) => (allowed as readonly unknown[]).includes(x))) return null;
  if (new Set(v).size !== v.length) return null;
  return [...(v as T[])];
}
