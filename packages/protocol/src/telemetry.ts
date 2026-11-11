/**
 * The telemetry contract: the closed allowlist of events and fields the app may send, the message
 * template allowlist (an error message is only ever sent as the id of a template from our own code), the stack-frame
 * filter and the error fingerprint. The app runs these before it sends; the ingest route runs `validateBatch` again, so a
 * buggy or forged client cannot store more (7.3).
 *
 * Never sent (7.3): builds, build codes, item text, allocations, gem or skill names, notes, timeline content, character or
 * account names, Discord name, email, file names or paths, game log lines, the pathofexile.com session, AI prompts or
 * answers, IP address, country.
 */
import { sha256Hex, utf8ByteLength } from './sha256.js';
import { isKnownFlag } from './flagRegistry.js';
import { isSemver } from './semver.js';
import { APP_ERROR_CODES, APP_ERROR_NAMES, APP_MESSAGE_TEMPLATES, APP_STARTER_IDS } from './messageTemplates.generated.js';
import { APP_BUNDLE_FILES, APP_BUNDLE_PACKAGES } from './bundleFiles.generated.js';
import { APP_RENDERER_ASSETS } from './rendererAssets.generated.js';

export const TELEMETRY_SCHEMA = 1;
export const TELEMETRY_MAX_BYTES = 64 * 1024;
export const TELEMETRY_MAX_EVENTS = 200;
export const MAX_FRAMES = 8;
export const MAX_BREADCRUMBS = 10;

export const AREAS = ['builds', 'atlas', 'timelines', 'marketplace', 'wealth', 'lootfilter'] as const;
export type Area = typeof AREAS[number];
export const EVENT_TYPES = ['session_start', 'presence', 'usage', 'error', 'crash', 'update', 'alert', 'session_end'] as const;
export type EventType = typeof EVENT_TYPES[number];
export const ERROR_KINDS = ['renderer_uncaught', 'renderer_rejection', 'react_boundary', 'main_uncaught', 'main_rejection',
  'engine_calc_failed', 'engine_crashed', 'ipc_failed', 'save_failed', 'update_failed', 'sync_failed', 'server_failed'] as const;
export type ErrorKind = typeof ERROR_KINDS[number];
export const CRASH_PROCESSES = ['renderer', 'gpu', 'utility', 'engine'] as const;
/** Electron's render-process-gone / child-process-gone `reason` values. */
export const CRASH_REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'] as const;
export const UPDATE_OUTCOMES = ['offered', 'downloaded', 'verified', 'installed', 'failed', 'deferred', 'required_shown', 'restart_now', 'held_by_policy'] as const;
export const TIMED_OPS = ['startup_to_interactive', 'calc_full', 'calc_incremental', 'tree_alloc_recalc', 'import_code', 'import_link',
  'import_ninja', 'save_build', 'save_atlas', 'optimizer_find_paths', 'filter_build', 'timeline_compile', 'run_start', 'sync_pass',
  'update_download', 'engine_hot_swap'] as const;
export const FUNNEL_KEYS = ['run.first_next', 'run.complete', 'atlas.plan_created', 'optimizer.applied', 'timeline.clip_added',
  'marketplace.copy', 'marketplace.saved', 'publish.submitted', 'ai.lock_seen', 'ai.request_ok'] as const;

/** The gate's denial codes (mastery-contracts FailureCode) that may appear in `ai.request_denied.{code}`. */
export const AI_DENIAL_CODES = ['SIGN_IN_REQUIRED', 'AI_ACCESS_REQUIRED', 'ENTITLEMENT_UNAVAILABLE', 'HUMAN_CHECK_REQUIRED', 'CONNECTION_REVOKED',
  'AI_SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'MODERATION_REJECTED', 'FEATURE_PAUSED', 'MAINTENANCE'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OS_BUILD = /^\d{1,3}\.\d{1,3}\.\d{1,6}$/;
let featureKeys: ReadonlySet<string> | null = null;

/**
 * A feature counter key (7.2), from closed lists only: a flag registry key, a funnel step, `starter.follow.{id}` for a
 * starter the release approved (generated from tools/mastery-starters/approvals.json), or `ai.request_denied.{code}`
 * for a gate denial code. Nothing is matched by pattern.
 */
export function isFeatureKey(key: string): boolean {
  if (!featureKeys) {
    featureKeys = new Set([...FUNNEL_KEYS, ...APP_STARTER_IDS.map((id) => `starter.follow.${id}`), ...AI_DENIAL_CODES.map((c) => `ai.request_denied.${c}`)]);
  }
  return typeof key === 'string' && (isKnownFlag(key) || featureKeys.has(key));
}

/** Versions in telemetry: x.y.z, optionally -alpha.N / -beta.N / -rc.N. Digits only, so no text can ride in a version. */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-(?:alpha|beta|rc)\.\d{1,4})?$/;

// ---------------------------------------------------------------------------------------------------------------------
// Error messages: allowlist only (7.3)
//
// An error report never carries the text of an error message. It carries the id of a known message template, either one
// the app's own code raises (messageTemplates.generated.ts, built from the source by scripts/gen-message-templates.mjs) or
// a JavaScript/Electron runtime message below. A message that matches no template is reported as "[message removed]".
// The dashboard shows the template's own text (from our code), so a build name, path, user name or code that was in the
// filled-in message can never reach the database.

export const MESSAGE_REMOVED = '[message removed]';
export const MESSAGE_REMOVED_ID = 'removed';

/** Runtime messages (V8, Chromium, Node, Electron) worth grouping by: [id, literal parts]. */
const RUNTIME_TEMPLATES: readonly (readonly [string, readonly string[]])[] = [
  ['js.read_props_undefined', ['Cannot read properties of undefined (reading ', ')']],
  ['js.read_props_null', ['Cannot read properties of null (reading ', ')']],
  ['js.set_props_undefined', ['Cannot set properties of undefined (setting ', ')']],
  ['js.set_props_null', ['Cannot set properties of null (setting ', ')']],
  ['js.not_a_function', ['', ' is not a function']],
  ['js.not_a_constructor', ['', ' is not a constructor']],
  ['js.not_defined', ['', ' is not defined']],
  ['js.not_iterable', ['', ' is not iterable']],
  ['js.before_init', ['Cannot access ', ' before initialization']],
  ['js.const_assign', ['Assignment to constant variable.']],
  ['js.stack_overflow', ['Maximum call stack size exceeded']],
  ['js.invalid_array_length', ['Invalid array length']],
  ['js.invalid_string_length', ['Invalid string length']],
  ['js.json_unexpected_end', ['Unexpected end of JSON input']],
  ['js.json_unexpected_token', ['Unexpected token ', ' in JSON at position ', '']],
  ['js.json_not_valid', ['Unexpected token ', ' is not valid JSON']],
  ['js.out_of_memory', ['out of memory']],
  ['net.failed_to_fetch', ['Failed to fetch']],
  ['net.fetch_failed', ['fetch failed']],
  ['net.network_error', ['NetworkError when attempting to fetch resource.']],
  ['net.aborted', ['The operation was aborted.']],
  ['net.aborted2', ['This operation was aborted']],
  ['net.timeout', ['The operation was aborted due to timeout']],
  ['dom.resize_observer', ['ResizeObserver loop completed with undelivered notifications.']],
  ['dom.resize_observer_limit', ['ResizeObserver loop limit exceeded']],
  ['ipc.no_handler', ['Error invoking remote method ', ': Error: No handler registered for ', '']],
  ['ipc.remote_error', ['Error invoking remote method ', '']],
];

interface CompiledTemplate { id: string; text: string; re: RegExp; specificity: number }
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile(rows: readonly (readonly [string, readonly string[]])[]): CompiledTemplate[] {
  return rows.map(([id, parts]) => ({
    id, text: parts.join('{x}'),
    re: new RegExp(`^${parts.map(escapeRe).join('[\\s\\S]*?')}$`),
    specificity: parts.join('').length,
  }));
}
let compiled: CompiledTemplate[] | null = null;
let byId: Map<string, CompiledTemplate> | null = null;
let appNames: ReadonlySet<string> | null = null;
function table(): CompiledTemplate[] {
  if (!compiled) {
    // The most specific template wins (more literal text first), so "HTTP {x}" never shadows a longer one.
    compiled = [...compile(APP_MESSAGE_TEMPLATES), ...compile(RUNTIME_TEMPLATES)].sort((a, b) => b.specificity - a.specificity || (a.id < b.id ? -1 : 1));
    byId = new Map(compiled.map((t) => [t.id, t]));
  }
  return compiled;
}

/** The id of the known template the whole message matches, or null. Only the id ever leaves the PC. */
export function messageTemplateId(message: unknown): string | null {
  if (typeof message !== 'string' || message.length === 0 || message.length > 2000) return null;
  const m = message.trim();
  // Node system errors ("ENOENT: no such file or directory, open 'C:\...'"): one group; the code goes in `code`.
  if (/^E[A-Z0-9]{2,15}: /.test(m)) return 'node.system_error';
  for (const t of table()) if (t.re.test(m)) return t.id;
  return null;
}

/** True for template ids the ingest route accepts (a known id or "removed"). */
export function isMessageTemplateId(id: unknown): id is string {
  table();
  return typeof id === 'string' && (id === MESSAGE_REMOVED_ID || id === 'node.system_error' || byId!.has(id));
}

/** The text shown for a reported template: the template from our own code with {x} placeholders, or "[message removed]". */
export function messageTemplateText(id: string | null | undefined): string {
  table();
  if (id === 'node.system_error') return '{code}: {x}';
  return (id && byId!.get(id)?.text) || MESSAGE_REMOVED;
}

/** What an error report carries for a message: the template id ("removed" when none matches) and the text to display. */
export function reportedMessage(message: unknown): { template: string; text: string } {
  const id = messageTemplateId(message);
  return id === null ? { template: MESSAGE_REMOVED_ID, text: MESSAGE_REMOVED } : { template: id, text: messageTemplateText(id) };
}

/** Error class names declared in the app or built into JavaScript; anything else is reported as "Error". */
export function reportedErrorName(name: unknown): string {
  if (!appNames) appNames = new Set([...APP_ERROR_NAMES, 'DOMException', 'AbortError', 'TimeoutError', 'NetworkError', 'SystemError']);
  return typeof name === 'string' && appNames.has(name) ? name : 'Error';
}

/** Node and Chromium error codes worth keeping; the app's own codes come from its source (APP_ERROR_CODES). */
const RUNTIME_CODES = ['EACCES', 'EADDRINUSE', 'EAGAIN', 'EAI_AGAIN', 'EBADF', 'EBUSY', 'ECANCELED', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET',
  'EEXIST', 'EHOSTUNREACH', 'EINVAL', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE', 'ENAMETOOLONG', 'ENETUNREACH', 'ENFILE', 'ENOENT', 'ENOMEM',
  'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'ENOTFOUND', 'EPERM', 'EPIPE', 'EROFS', 'ETIMEDOUT', 'EXDEV', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_URL', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_IPC_CHANNEL_CLOSED', 'ERR_HTTP_HEADERS_SENT',
  'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_UNHANDLED_REJECTION', 'ERR_OUT_OF_RANGE', 'ERR_FS_FILE_TOO_LARGE', 'ERR_ZLIB_INITIALIZATION_FAILED',
  'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];
let codes: ReadonlySet<string> | null = null;

/** An error code: one the app's own source uses, or a known Node/Chromium code; anything else is dropped (null). */
export function reportedErrorCode(code: unknown): string | null {
  if (!codes) codes = new Set([...APP_ERROR_CODES, ...RUNTIME_CODES]);
  return typeof code === 'string' && codes.has(code) ? code : null;
}

// Stack frames: allowlist only (7.3). A frame is kept only when its file is one of the scripts the app ships
// (bundleFiles.generated.ts, built from apps/desktop's build scripts by scripts/gen-bundle-files.mjs). Everything else,
// URLs of any kind, user files and node internals, is "[frame removed]".

export const FRAME_REMOVED = '[frame removed]';
let shipped: ReadonlySet<string> | null = null;
let bundlePackages: ReadonlySet<string> | null = null;
/** The exact shipped script names: source-derived files plus the renderer assets of every build (with their hashes). */
function shippedFiles(): ReadonlySet<string> {
  if (!shipped) shipped = new Set([...APP_BUNDLE_FILES, ...APP_RENDERER_ASSETS]);
  return shipped;
}
function packages(): ReadonlySet<string> {
  if (!bundlePackages) bundlePackages = new Set(APP_BUNDLE_PACKAGES);
  return bundlePackages;
}

/**
 * The reported form of a path relative to the app root, or null: a shipped script exactly as named (no pattern, no
 * hash guessing), or `node_modules/<package>` for a direct dependency, whether the input is the dependency's full path or
 * already that normalized form (so the client's output passes the server's re-check unchanged).
 */
function bundledPath(path: string, files: ReadonlySet<string>): string | null {
  if (path.length > 300 || path.split('/').some((p) => p === '..' || p === '.' || p === '')) return null;
  if (files.has(path)) return path;
  const dep = /^node_modules\/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:\/.*)?$/.exec(path);
  if (dep && packages().has(dep[1]!)) return `node_modules/${dep[1]}`;
  return null;
}

const POS = /^(.*):(\d{1,7}):(\d{1,7})$/;
const RELATIVE_FRAME = /^((?:dist|node_modules)\/[A-Za-z0-9._@\/-]{1,280}):(\d{1,7}):(\d{1,7})$/;

/**
 * One stack frame as `file:line:col` relative to the app root, or "[frame removed]".
 * - `appRoot` is the app's own root as Electron reports it (`app.getAppPath()`, e.g. `C:\...\resources\app.asar`, or
 *   `apps/desktop` in a dev checkout). An absolute frame counts only when its path starts with exactly that root; there
 *   is no substring matching, so `D:\Games\resources\dist\x.js` is never mistaken for the app.
 * - Without `appRoot` (the ingest route re-checking what a client sent) only an already-relative frame is accepted.
 * - The file must be a script the app ships, by its exact name (`files`, default: the generated lists). URLs (http, https,
 *   file, anything with a scheme) never count.
 * - The result is a fixed point: sanitizeFrame(sanitizeFrame(x, root)) === sanitizeFrame(x, root), so the ingest route's
 *   re-check keeps every frame the app kept.
 */
export function sanitizeFrame(frame: unknown, appRoot?: string | null, files: ReadonlySet<string> = shippedFiles()): string {
  if (typeof frame !== 'string' || frame.length > 2000) return FRAME_REMOVED;
  if (frame === FRAME_REMOVED) return FRAME_REMOVED;
  const rel = RELATIVE_FRAME.exec(frame);
  if (rel) {
    const p = bundledPath(rel[1]!, files);
    return p ? `${p}:${rel[2]}:${rel[3]}` : FRAME_REMOVED;
  }
  let loc = frame.trim();
  if (!/^at\s/.test(loc)) return FRAME_REMOVED;
  loc = loc.replace(/^at\s+(?:async\s+)?/, '');
  const paren = /\(([^()]*)\)$/.exec(loc);
  if (paren) loc = paren[1]!;
  const pos = POS.exec(loc);
  if (!pos || !appRoot) return FRAME_REMOVED;
  const file = pos[1]!;
  if (/^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(file) || /^[a-z]+:(?![\\/])/i.test(file)) return FRAME_REMOVED; // URLs, node:internal
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const rootN = norm(appRoot), fileN = norm(file);
  if (!rootN || fileN.toLowerCase().slice(0, rootN.length + 1) !== `${rootN.toLowerCase()}/`) return FRAME_REMOVED;
  const p = bundledPath(fileN.slice(rootN.length + 1), files);
  return p ? `${p}:${pos[2]}:${pos[3]}` : FRAME_REMOVED;
}

/**
 * The frames of a stack, top first, at most 8. Only the stack's own frame lines count: the header (`Name: message`, which
 * may span several lines and may itself contain text that looks like a frame) is cut off first using the error's message.
 */
export function framesFromStack(stack: unknown, appRoot?: string | null, message?: unknown): string[] {
  if (typeof stack !== 'string') return [];
  let body = stack;
  if (typeof message === 'string' && message.length > 0) {
    const i = body.indexOf(message);
    if (i >= 0) body = body.slice(i + message.length);
  }
  const lines = body.split(/\r?\n/);
  const frames: string[] = [];
  // The header is everything before the first frame line; with the message cut, any later non-frame line ends the stack.
  let started = false;
  for (const line of lines) {
    if (/^\s+at\s/.test(line)) { started = true; frames.push(sanitizeFrame(line.trim(), appRoot)); }
    else if (started) break;
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/** Error groups (7.3): sha256(kind, class name, code, template id, first kept frame without column). */
export function errorFingerprint(kind: string, name: string, code: string | null, template: string, frames: readonly string[]): string {
  const first = frames.find((f) => f !== FRAME_REMOVED)?.replace(/:\d+$/, '') ?? '';
  return sha256Hex(`${kind}\n${name}\n${code ?? ''}\n${template}\n${first}`);
}

/**
 * Everything an error report may say about one error, from the live Error object: class, code, template id, bundled
 * frames, fingerprint. Nothing else of the error is read. `appRoot` is `app.getAppPath()`.
 */
export function describeError(kind: ErrorKind, error: unknown, appRoot?: string | null): { name: string; code: string | null; template: string; frames: string[]; fingerprint: string } {
  const e = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const name = reportedErrorName(e.name);
  const code = reportedErrorCode(e.code);
  const { template } = reportedMessage(e.message);
  const frames = framesFromStack(e.stack, appRoot, e.message);
  return { name, code, template, frames, fingerprint: errorFingerprint(kind, name, code, template, frames) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Batch allowlist (7.2, 7.4)

export interface Timing { n: number; p50: number; p95: number; max: number }
export type TelemetryEvent =
  | { type: 'session_start'; at: string; sessionId: string; appVersion: string; engineVersion: string; interfaceVersion: string;
      channel: 'stable' | 'beta'; osBuild: string; firstLaunch: boolean; previousSession: 'clean' | 'crashed' | 'unknown';
      previousCrashKind: string | null; coldStartMs: number }
  | { type: 'presence'; at: string; sessionId: string; area: Area | null; signedIn: boolean; configVersion: number }
  | { type: 'usage'; at: string; sessionId: string; areas: Partial<Record<Area, number>>; features: Record<string, number>; timings: Record<string, Timing> }
  | { type: 'error'; at: string; sessionId: string; kind: ErrorKind; name: string; code: string | null; template: string; frames: string[]; area: Area | null; breadcrumbs: string[]; count: number }
  | { type: 'crash'; at: string; sessionId: string | null; process: typeof CRASH_PROCESSES[number]; reason: typeof CRASH_REASONS[number]; exitCode: number }
  | { type: 'update'; at: string; channel: 'stable' | 'beta'; layer: 'app' | 'engine' | 'interface'; from: string; to: string; outcome: typeof UPDATE_OUTCOMES[number]; code: string | null }
  | { type: 'alert'; at: string; alertId: string; action: 'shown' | 'dismissed' | 'link_opened' }
  | { type: 'session_end'; at: string; sessionId: string; clean: true; durationS: number };
export interface TelemetryBatch { schema: 1; tid: string; sentAt: string; events: TelemetryEvent[] }

export type BatchResult = { ok: true; value: TelemetryBatch } | { ok: false; reason: string };

/** Field names per event type, exactly: any other field rejects the batch. */
export const EVENT_FIELDS: Record<EventType, readonly string[]> = {
  session_start: ['type', 'at', 'sessionId', 'appVersion', 'engineVersion', 'interfaceVersion', 'channel', 'osBuild', 'firstLaunch', 'previousSession', 'previousCrashKind', 'coldStartMs'],
  presence: ['type', 'at', 'sessionId', 'area', 'signedIn', 'configVersion'],
  usage: ['type', 'at', 'sessionId', 'areas', 'features', 'timings'],
  error: ['type', 'at', 'sessionId', 'kind', 'name', 'code', 'template', 'frames', 'area', 'breadcrumbs', 'count'],
  crash: ['type', 'at', 'sessionId', 'process', 'reason', 'exitCode'],
  update: ['type', 'at', 'channel', 'layer', 'from', 'to', 'outcome', 'code'],
  alert: ['type', 'at', 'alertId', 'action'],
  session_end: ['type', 'at', 'sessionId', 'clean', 'durationS'],
};

class Reject extends Error {}
const fail = (reason: string): never => { throw new Reject(reason); };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => ((list as readonly unknown[]).includes(v) ? v as T : fail(what));
const int = (v: unknown, min: number, max: number, what: string): number => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail(what));
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : fail(what));
const uuid = (v: unknown, what: string): string => (typeof v === 'string' && UUID.test(v) ? v : fail(what));
const ISO_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Only the exact shape YYYY-MM-DDTHH:mm:ss[.f]{Z|+hh:mm}; the output is the normalized UTC millisecond form, never the input text. */
const iso = (v: unknown): string => {
  const m = typeof v === 'string' && v.length <= 40 ? ISO_TS.exec(v) : null;
  if (!m || +m[2]! < 1 || +m[2]! > 12 || +m[3]! < 1 || +m[3]! > new Date(Date.UTC(+m[1]!, +m[2]!, 0)).getUTCDate() || +m[4]! > 23 || +m[5]! > 59 || +m[6]! > 59) return fail('at');
  const t = Date.parse(v as string);
  if (Number.isNaN(t)) return fail('at');
  const d = new Date(t);
  return d.getUTCFullYear() >= 1 && d.getUTCFullYear() <= 9999 ? d.toISOString() : fail('at');
};
const version = (v: unknown, what: string): string => (typeof v === 'string' && VERSION.test(v) && isSemver(v) ? v : fail(what));
const area = (v: unknown): Area | null => (v === null ? null : oneOf(v, AREAS, 'area'));
const exactFields = (e: Record<string, unknown>, type: EventType): void => {
  for (const k of Object.keys(e)) if (!EVENT_FIELDS[type].includes(k)) fail('unknown_field');
  for (const k of EVENT_FIELDS[type]) if (!(k in e)) fail('missing_field');
};

function readEvent(raw: unknown): TelemetryEvent {
  if (!isObj(raw)) return fail('event');
  const type = oneOf(raw.type, EVENT_TYPES, 'unknown_event');
  exactFields(raw, type);
  const at = iso(raw.at);
  switch (type) {
    case 'session_start':
      return { type, at, sessionId: uuid(raw.sessionId, 'sessionId'), appVersion: version(raw.appVersion, 'appVersion'),
        engineVersion: version(raw.engineVersion, 'engineVersion'), interfaceVersion: version(raw.interfaceVersion, 'interfaceVersion'),
        channel: oneOf(raw.channel, ['stable', 'beta'] as const, 'channel'),
        osBuild: typeof raw.osBuild === 'string' && OS_BUILD.test(raw.osBuild) ? raw.osBuild : fail('osBuild'),
        firstLaunch: bool(raw.firstLaunch, 'firstLaunch'), previousSession: oneOf(raw.previousSession, ['clean', 'crashed', 'unknown'] as const, 'previousSession'),
        previousCrashKind: raw.previousCrashKind === null ? null : oneOf(raw.previousCrashKind, [...CRASH_REASONS, ...ERROR_KINDS], 'previousCrashKind'),
        coldStartMs: int(raw.coldStartMs, 0, 600_000, 'coldStartMs') };
    case 'presence':
      return { type, at, sessionId: uuid(raw.sessionId, 'sessionId'), area: area(raw.area), signedIn: bool(raw.signedIn, 'signedIn'),
        configVersion: int(raw.configVersion, 0, 2 ** 31 - 1, 'configVersion') };
    case 'usage': {
      if (!isObj(raw.areas) || !isObj(raw.features) || !isObj(raw.timings)) return fail('usage');
      const areas: Partial<Record<Area, number>> = {};
      for (const [k, v] of Object.entries(raw.areas)) {
        const a = oneOf(k, AREAS, 'area');
        const s = int(v, 0, 86_400, 'seconds');
        if (s % 10 !== 0) fail('seconds');
        areas[a] = s;
      }
      const features: Record<string, number> = {};
      const fk = Object.keys(raw.features);
      if (fk.length > 300) fail('features');
      for (const k of fk) { if (!isFeatureKey(k)) fail('feature_key'); features[k] = int(raw.features[k], 0, 1_000_000, 'count'); }
      const timings: Record<string, Timing> = {};
      for (const [k, v] of Object.entries(raw.timings)) {
        const op = oneOf(k, TIMED_OPS, 'timing_op');
        if (!isObj(v) || Object.keys(v).some((x) => !['n', 'p50', 'p95', 'max'].includes(x))) fail('timing');
        const t = v as Record<string, unknown>;
        const n = int(t.n, 1, 1_000_000, 'timing'), p50 = int(t.p50, 0, 3_600_000, 'timing'), p95 = int(t.p95, 0, 3_600_000, 'timing'), max = int(t.max, 0, 3_600_000, 'timing');
        if (!(p50 <= p95 && p95 <= max)) fail('timing');
        timings[op] = { n, p50, p95, max };
      }
      return { type, at, sessionId: uuid(raw.sessionId, 'sessionId'), areas, features, timings };
    }
    case 'error': {
      if (!Array.isArray(raw.frames) || raw.frames.length > 32) return fail('frames');
      if (!Array.isArray(raw.breadcrumbs) || raw.breadcrumbs.length > 50) return fail('breadcrumbs');
      // No message text is accepted at all: only a known template id. Frames are re-filtered on the server.
      const frames = raw.frames.map((f) => sanitizeFrame(f)).slice(0, MAX_FRAMES);
      const breadcrumbs = raw.breadcrumbs.map((b) => (typeof b === 'string' && ((AREAS as readonly string[]).includes(b) || isFeatureKey(b)) ? b : fail('breadcrumb'))).slice(-MAX_BREADCRUMBS);
      if (raw.name !== reportedErrorName(raw.name)) return fail('name');
      if (raw.code !== null && reportedErrorCode(raw.code) === null) return fail('code');
      if (!isMessageTemplateId(raw.template)) return fail('template');
      return { type, at, sessionId: uuid(raw.sessionId, 'sessionId'), kind: oneOf(raw.kind, ERROR_KINDS, 'kind'), name: raw.name as string,
        code: raw.code as string | null, template: raw.template as string, frames, area: area(raw.area), breadcrumbs,
        count: int(raw.count, 1, 100_000, 'count') };
    }
    case 'crash':
      return { type, at, sessionId: raw.sessionId === null ? null : uuid(raw.sessionId, 'sessionId'), process: oneOf(raw.process, CRASH_PROCESSES, 'process'),
        reason: oneOf(raw.reason, CRASH_REASONS, 'reason'), exitCode: int(raw.exitCode, -(2 ** 31), 2 ** 32 - 1, 'exitCode') };
    case 'update':
      return { type, at, channel: oneOf(raw.channel, ['stable', 'beta'] as const, 'channel'), layer: oneOf(raw.layer, ['app', 'engine', 'interface'] as const, 'layer'),
        from: version(raw.from, 'from'), to: version(raw.to, 'to'), outcome: oneOf(raw.outcome, UPDATE_OUTCOMES, 'outcome'),
        code: raw.code === null ? null : reportedErrorCode(raw.code) ?? fail('code') };
    case 'alert':
      return { type, at, alertId: uuid(raw.alertId, 'alertId'), action: oneOf(raw.action, ['shown', 'dismissed', 'link_opened'] as const, 'action') };
    case 'session_end':
      if (raw.clean !== true) return fail('clean');
      return { type, at, sessionId: uuid(raw.sessionId, 'sessionId'), clean: true, durationS: int(raw.durationS, 0, 30 * 86_400, 'durationS') };
  }
}

/**
 * Validates one batch against the closed allowlist. Unknown event types or fields reject the whole batch (the reason is
 * a fixed word, never a value from the input). Error messages and frames come back re-sanitized.
 */
export function validateBatch(input: unknown): BatchResult {
  try {
    let raw = input;
    if (typeof raw === 'string') {
      if (raw.length > TELEMETRY_MAX_BYTES || utf8ByteLength(raw) > TELEMETRY_MAX_BYTES) return { ok: false, reason: 'too_large' };
      try { raw = JSON.parse(raw); } catch { return { ok: false, reason: 'not_json' }; }
    }
    if (!isObj(raw)) return { ok: false, reason: 'not_object' };
    if (Object.keys(raw).some((k) => !['schema', 'tid', 'sentAt', 'events'].includes(k))) return { ok: false, reason: 'unknown_field' };
    if (raw.schema !== TELEMETRY_SCHEMA) return { ok: false, reason: 'schema' };
    const tid = uuid(raw.tid, 'tid');
    const sentAt = iso(raw.sentAt);
    if (!Array.isArray(raw.events) || raw.events.length === 0) return { ok: false, reason: 'events' };
    if (raw.events.length > TELEMETRY_MAX_EVENTS) return { ok: false, reason: 'too_many_events' };
    return { ok: true, value: { schema: 1, tid, sentAt, events: raw.events.map(readEvent) } };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, reason: e.message };
    return { ok: false, reason: 'invalid' };
  }
}
