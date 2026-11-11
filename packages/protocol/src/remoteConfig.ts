/**
 * The remote config document served by `GET /api/app/config` and the one rule evaluator used by the
 * app, the site and the server.
 *
 * Fail-safe by construction: the parser never throws on a field it does not like. A document that is not an object,
 * or has another `schema`, is rejected as a whole (the caller keeps its last good document). Inside a good document an
 * unknown flag key is ignored, a known key with an invalid value falls back to its default (ON), a malformed alert is
 * dropped, and malformed maintenance / update policy / telemetry fields take their defaults. Protected flags are
 * always on, whatever the document says.
 */
import { compareVersions, isSemver } from './semver.js';
import { LIMITS, distinctSubset, httpsLinkOk, textOk, timestampOk } from './limits.js';
import { bucketOf, utf8ByteLength } from './sha256.js';
import { flagDef, type FlagMode } from './flagRegistry.js';
import { parseUpdatePolicyDoc, type UpdatePolicyDoc } from './updatePolicy.js';

export const REMOTE_CONFIG_SCHEMA = 1;
/** At most this many alerts in one document; the database refuses the 51st open alert (ops_max_alerts()). */
export const REMOTE_CONFIG_MAX_ALERTS = LIMITS.alerts;
/** Hard size limit of the document body (6.1), in UTF-8 bytes. */
export const REMOTE_CONFIG_MAX_BYTES = 32 * 1024;

export type FlagState = 'on' | 'off' | 'rules';
export type Tier = 'signed_out' | 'signed_in' | 'pro';
export type Channel = 'stable' | 'beta';
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'maintenance';
export type AlertSurface = 'app' | 'site';
export type AlertComponent = 'sign_in' | 'sync' | 'marketplace' | 'ai' | 'updates' | 'downloads' | 'website';

export interface FlagRules {
  percent?: number;
  minVersion?: string;
  maxVersion?: string;
  channels?: Channel[];
  tiers?: Tier[];
  /** sha256 hex of account ids; matches only when signed in. */
  testers?: string[];
}
export interface FlagEntry {
  state: FlagState;
  rules?: FlagRules;
  mode?: FlagMode;
  immediate?: boolean;
  message?: string | null;
}
export interface RemoteAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  link: { url: string; label: string } | null;
  surfaces: AlertSurface[];
  audience: { maxVersion: string | null; tiers: Tier[] | null };
  components: AlertComponent[];
  startsAt: string;
  endsAt: string | null;
  dismissible: boolean;
}
export interface Maintenance { network: boolean; siteWrites: boolean; message: string | null; until: string | null }
export interface TelemetryControl { accept: boolean; batchMinutes: number }
export interface RemoteConfig {
  schema: 1;
  configVersion: number;
  generatedAt: string;
  flags: Record<string, FlagEntry>;
  alerts: RemoteAlert[];
  maintenance: Maintenance;
  updatePolicy: UpdatePolicyDoc | null;
  telemetry: TelemetryControl;
  proOpenBeta: boolean;
}

/**
 * `userData/remote-config.json` (6.2): the served document exactly as received, with two extra top-level fields. Readers
 * that look only at `flags[key].state` (tools/mastery-starters/runtime.ts startersFlagFrom) work on it unchanged, and
 * parseRemoteConfig ignores the extra fields.
 */
export type RemoteConfigCache = Record<string, unknown> & { schema: 1; flags?: Record<string, unknown>; fetchedAt: string; etag: string | null };

export function remoteConfigCache(document: Record<string, unknown>, fetchedAt: Date, etag: string | null): RemoteConfigCache {
  return { ...document, schema: 1, fetchedAt: fetchedAt.toISOString(), etag };
}

export interface FlagContext {
  appVersion: string;
  channel: Channel;
  tier: Tier;
  /** 0-99, from flagBucket(rolloutSeed, key) on the client or hash(user id + key) on the server. Absent: percent rules are off. */
  bucket?: number;
  /** sha256 hex of the signed-in account id, for `testers`. */
  accountHash?: string | null;
}
export interface EvaluatedFlag { on: boolean; message: string | null; mode: FlagMode; immediate: boolean }

export const MESSAGE_MAX = LIMITS.flagMessage;
const HEX64 = /^[0-9a-f]{64}$/;
const SEVERITIES: readonly AlertSeverity[] = ['info', 'warning', 'critical', 'maintenance'];
const COMPONENTS: readonly AlertComponent[] = ['sign_in', 'sync', 'marketplace', 'ai', 'updates', 'downloads', 'website'];
const TIERS: readonly Tier[] = ['signed_out', 'signed_in', 'pro'];
const CHANNELS: readonly Channel[] = ['stable', 'beta'];

/** The bundled defaults (6.2): every flag at its registry default, no alerts, no maintenance, no update policy. */
export function defaultRemoteConfig(): RemoteConfig {
  return {
    schema: 1, configVersion: 0, generatedAt: new Date(0).toISOString(), flags: {}, alerts: [],
    maintenance: { network: false, siteWrites: false, message: null, until: null },
    updatePolicy: null, telemetry: { accept: true, batchMinutes: 10 }, proOpenBeta: false,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
// All value rules come from limits.ts, the same rules the database enforces (ops_text_ok, ops_https_ok, ...).
const subset = distinctSubset;

/** Reads rules from untrusted JSON. Null means invalid: the flag then falls back to its default. */
export function parseRules(raw: unknown): FlagRules | null {
  if (!isObj(raw)) return null;
  const known = ['percent', 'minVersion', 'maxVersion', 'channels', 'tiers', 'testers'];
  if (Object.keys(raw).some((k) => !known.includes(k))) return null;
  const out: FlagRules = {};
  if (raw.percent !== undefined) {
    if (typeof raw.percent !== 'number' || !Number.isInteger(raw.percent) || raw.percent < 0 || raw.percent > 100) return null;
    out.percent = raw.percent;
  }
  for (const k of ['minVersion', 'maxVersion'] as const) {
    if (raw[k] === undefined) continue;
    if (!isSemver(raw[k])) return null;
    out[k] = raw[k] as string;
  }
  if (raw.channels !== undefined) { const c = subset(raw.channels, CHANNELS); if (!c) return null; out.channels = c; }
  if (raw.tiers !== undefined) { const t = subset(raw.tiers, TIERS); if (!t) return null; out.tiers = t; }
  if (raw.testers !== undefined) {
    if (!Array.isArray(raw.testers) || raw.testers.length > LIMITS.testers || !raw.testers.every((x) => typeof x === 'string' && HEX64.test(x))) return null;
    if (new Set(raw.testers).size !== raw.testers.length) return null;
    out.testers = raw.testers as string[];
  }
  return out;
}

/** Reads one flag entry for `key`. Null means: unknown or protected key, or invalid value (use the default). */
export function parseFlagEntry(key: string, raw: unknown): FlagEntry | null {
  const d = flagDef(key);
  if (!d || d.protected || !isObj(raw)) return null;
  if (Object.keys(raw).some((k) => !['state', 'rules', 'mode', 'immediate', 'message'].includes(k))) return null;
  const state = raw.state;
  if (state !== 'on' && state !== 'off' && state !== 'rules') return null;
  const mode = raw.mode === undefined ? 'pause' : raw.mode;
  if (mode !== 'pause' && mode !== 'hide') return null;
  if (!d.modes.includes(mode)) return null;
  if (raw.immediate !== undefined && typeof raw.immediate !== 'boolean') return null;
  if (raw.message !== undefined && raw.message !== null && !textOk(raw.message, { max: LIMITS.flagMessage })) return null;
  const entry: FlagEntry = { state, mode, immediate: raw.immediate === true, message: (raw.message as string | null | undefined) ?? null };
  if (state === 'rules') {
    const rules = parseRules(raw.rules);
    if (!rules) return null;
    entry.rules = rules;
  }
  return entry;
}

const ALERT_KEYS = ['id', 'severity', 'title', 'body', 'link', 'surfaces', 'audience', 'components', 'startsAt', 'endsAt', 'dismissible'];
export function parseAlert(raw: unknown): RemoteAlert | null {
  if (!isObj(raw)) return null;
  if (Object.keys(raw).some((k) => !ALERT_KEYS.includes(k))) return null;
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(raw.id) ? raw.id : null;
  if (!id || !textOk(raw.title, { max: LIMITS.alertTitle, nonBlank: true }) || !textOk(raw.body, { max: LIMITS.alertBody, allowNewline: true })) return null;
  const title = raw.title, body = raw.body;
  if (!SEVERITIES.includes(raw.severity as AlertSeverity)) return null;
  const surfaces = subset(raw.surfaces, ['app', 'site'] as const);
  if (!surfaces || surfaces.length === 0) return null;
  const components = raw.components === undefined ? [] : subset(raw.components, COMPONENTS);
  if (!components) return null;
  if (!timestampOk(raw.startsAt)) return null;
  if (raw.endsAt !== null && raw.endsAt !== undefined && !(timestampOk(raw.endsAt) && Date.parse(raw.endsAt) > Date.parse(raw.startsAt))) return null;
  if (raw.dismissible !== undefined && typeof raw.dismissible !== 'boolean') return null;
  let link: RemoteAlert['link'] = null;
  if (raw.link !== null && raw.link !== undefined) {
    if (!isObj(raw.link) || !httpsLinkOk(raw.link.url) || !textOk(raw.link.label, { max: LIMITS.alertLinkLabel, nonBlank: true })) return null;
    link = { url: raw.link.url, label: raw.link.label as string };
  }
  if (raw.audience !== undefined && !isObj(raw.audience)) return null;
  const aud = isObj(raw.audience) ? raw.audience : {};
  const maxVersion = aud.maxVersion === null || aud.maxVersion === undefined ? null : isSemver(aud.maxVersion) ? aud.maxVersion : undefined;
  const tiers = aud.tiers === null || aud.tiers === undefined ? null : subset(aud.tiers, TIERS);
  if (maxVersion === undefined || (aud.tiers !== null && aud.tiers !== undefined && !tiers)) return null;
  const severity = raw.severity as AlertSeverity;
  // Critical and maintenance alerts can never be dismissed.
  const dismissible = raw.dismissible === true && severity !== 'critical' && severity !== 'maintenance';
  return { id, severity, title, body, link, surfaces, audience: { maxVersion, tiers }, components, startsAt: raw.startsAt,
    endsAt: (raw.endsAt as string | null | undefined) ?? null, dismissible };
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, maintenance: 1, warning: 2, info: 3 };
/** Highest severity first, then newest start, then id (stable). */
function alertOrder(a: RemoteAlert, b: RemoteAlert): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Date.parse(b.startsAt) - Date.parse(a.startsAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export type ParseResult = { ok: true; value: RemoteConfig; dropped: string[] } | { ok: false; reason: string };

/** Parses the document. `dropped` lists what was ignored, for logs; it never contains values. */
export function parseRemoteConfig(raw: unknown): ParseResult {
  if (typeof raw === 'string') {
    if (raw.length > REMOTE_CONFIG_MAX_BYTES || utf8ByteLength(raw) > REMOTE_CONFIG_MAX_BYTES) return { ok: false, reason: 'too_large' };
    try { raw = JSON.parse(raw); } catch { return { ok: false, reason: 'not_json' }; }
  }
  if (!isObj(raw)) return { ok: false, reason: 'not_object' };
  if (raw.schema !== REMOTE_CONFIG_SCHEMA) return { ok: false, reason: 'schema' };
  const out = defaultRemoteConfig();
  const dropped: string[] = [];
  if (typeof raw.configVersion === 'number' && Number.isInteger(raw.configVersion) && raw.configVersion >= 0) out.configVersion = raw.configVersion;
  if (timestampOk(raw.generatedAt)) out.generatedAt = raw.generatedAt;
  if (isObj(raw.flags)) {
    for (const [key, value] of Object.entries(raw.flags)) {
      const e = parseFlagEntry(key, value);
      if (e) out.flags[key] = e; else dropped.push(`flag:${key.slice(0, 64)}`);
    }
  }
  if (Array.isArray(raw.alerts)) {
    // Parse them all (bounded), then keep the most important: highest severity first, then newest. A cut is reported in
    // `dropped`, never silent, and a critical or maintenance alert can only be cut by more of its own kind.
    const parsed: RemoteAlert[] = [];
    raw.alerts.forEach((a, i) => {
      if (i >= REMOTE_CONFIG_MAX_ALERTS * 10) { dropped.push(`alert:${i}`); return; }
      const p = parseAlert(a); if (p) parsed.push(p); else dropped.push(`alert:${i}`);
    });
    parsed.sort(alertOrder);
    out.alerts = parsed.slice(0, REMOTE_CONFIG_MAX_ALERTS);
    for (const a of parsed.slice(REMOTE_CONFIG_MAX_ALERTS)) dropped.push(`alert_overflow:${a.id}`);
  }
  if (isObj(raw.maintenance)) {
    const m = raw.maintenance;
    // All or nothing: a malformed maintenance object is ignored whole (the database refuses the same objects).
    const okMsg = m.message === undefined || m.message === null || textOk(m.message, { max: LIMITS.maintenanceMessage });
    const okUntil = m.until === undefined || m.until === null || timestampOk(m.until);
    if (typeof m.network === 'boolean' && typeof m.siteWrites === 'boolean' && okMsg && okUntil
        && Object.keys(m).every((k) => ['network', 'siteWrites', 'message', 'until'].includes(k))) {
      out.maintenance = { network: m.network, siteWrites: m.siteWrites, message: (m.message as string | null | undefined) ?? null, until: (m.until as string | null | undefined) ?? null };
    } else dropped.push('maintenance');
  }
  if (isObj(raw.updatePolicy)) out.updatePolicy = parseUpdatePolicyDoc(raw.updatePolicy);
  if (isObj(raw.telemetry)) {
    const t = raw.telemetry;
    if (typeof t.accept === 'boolean' && typeof t.batchMinutes === 'number' && Number.isInteger(t.batchMinutes) && t.batchMinutes >= 5 && t.batchMinutes <= 60
        && Object.keys(t).every((k) => k === 'accept' || k === 'batchMinutes')) {
      out.telemetry = { accept: t.accept, batchMinutes: t.batchMinutes };
    } else dropped.push('telemetry');
  }
  out.proOpenBeta = raw.proOpenBeta === true;
  return { ok: true, value: out, dropped };
}

/** The per-flag bucket on the client: first 2 bytes of sha256(rolloutSeed + ':' + flagKey) mod 100 (6.3). */
export function flagBucket(rolloutSeed: string, key: string): number {
  return bucketOf(`${rolloutSeed}:${key}`);
}

/** Whether `rules` switch the flag on for `ctx`: every present condition must hold. */
export function rulesMatch(rules: FlagRules, ctx: FlagContext): boolean {
  if (rules.percent !== undefined && !(ctx.bucket !== undefined && ctx.bucket < rules.percent)) return false;
  if (rules.minVersion !== undefined && !((compareVersions(ctx.appVersion, rules.minVersion) ?? -1) >= 0)) return false;
  if (rules.maxVersion !== undefined && !((compareVersions(ctx.appVersion, rules.maxVersion) ?? 1) <= 0)) return false;
  if (rules.channels !== undefined && !rules.channels.includes(ctx.channel)) return false;
  if (rules.tiers !== undefined && !rules.tiers.includes(ctx.tier)) return false;
  if (rules.testers !== undefined && !(ctx.tier !== 'signed_out' && ctx.accountHash && rules.testers.includes(ctx.accountHash))) return false;
  return true;
}

/**
 * evaluateFlag(entry, ctx) (6.3): `on`/`off` are absolute, `rules` is on only if all present conditions hold.
 * No entry (or an invalid one) is the registry default: on.
 */
export function evaluateFlag(entry: FlagEntry | null | undefined, ctx: FlagContext): EvaluatedFlag {
  if (!entry) return { on: true, message: null, mode: 'pause', immediate: false };
  const on = entry.state === 'on' ? true : entry.state === 'off' ? false : rulesMatch(entry.rules ?? {}, ctx);
  return { on, message: on ? null : entry.message ?? null, mode: entry.mode ?? 'pause', immediate: on ? false : entry.immediate === true };
}

/** One flag of a parsed document, with the registry applied: protected and unknown keys are always on. */
export function flagFromConfig(config: RemoteConfig, key: string, ctx: FlagContext): EvaluatedFlag {
  const d = flagDef(key);
  if (!d || d.protected) return evaluateFlag(null, ctx);
  return evaluateFlag(config.flags[key] ?? null, ctx);
}


/** Alerts to show now on `surface` for `ctx`, highest severity first, then newest. Expired ones drop locally. */
export function activeAlerts(config: RemoteConfig, surface: AlertSurface, now: Date, ctx?: Pick<FlagContext, 'appVersion' | 'tier'>): RemoteAlert[] {
  const t = now.getTime();
  return config.alerts
    .filter((a) => a.surfaces.includes(surface) && Date.parse(a.startsAt) <= t && (a.endsAt === null || Date.parse(a.endsAt) > t))
    .filter((a) => !ctx || ((a.audience.maxVersion === null || (compareVersions(ctx.appVersion, a.audience.maxVersion) ?? 1) <= 0)
      && (a.audience.tiers === null || a.audience.tiers.includes(ctx.tier))))
    .sort(alertOrder);
}

/** Maintenance with a past `until` is dropped locally even when the document is old (6.2). */
export function effectiveMaintenance(config: RemoteConfig, now: Date): Maintenance {
  const m = config.maintenance;
  if (m.until !== null && Date.parse(m.until) <= now.getTime()) return { network: false, siteWrites: false, message: null, until: null };
  return m;
}
