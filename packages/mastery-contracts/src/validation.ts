import type { FailureCode } from './gate.js';

export type ValidationLimits = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxArrayLength: number;
  maxStringLength: number;
};
export type ValidationIssue = { code: FailureCode; path: string; message: string };
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };
export type ParseOptions = { unknownFields?: 'reject' | 'strip'; includeNotes?: boolean; includeHistory?: boolean };
type Context = { options: ParseOptions; limits: ValidationLimits };
export type Node<T> = { read(value: unknown, path: string, context: Context): T };

class Invalid extends Error {
  constructor(readonly issue: ValidationIssue) { super(issue.message); }
}
export function fail(path: string, message: string, code: FailureCode = 'VALIDATION_FAILED'): never {
  throw new Invalid({ code, path, message });
}
export function check(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) fail(path, message);
}
/**
 * UTF-8 byte length of a string, exactly what `new TextEncoder().encode(text).length` returns (a lone surrogate is encoded as
 * U+FFFD, 3 bytes), without allocating the encoded bytes. boundedJson counts every string and key of a payload; encoding each
 * one took most of its time on the multi-megabyte Atlas and starter packs (about 5 s of every app start when profiled).
 */
export function utf8Length(text: string): number {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) continue;
    if (code < 0x800) { bytes += 1; continue; }
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 2; i++; continue; } // a pair: 2 UTF-16 units, 4 bytes
    }
    bytes += 2; // the rest of the BMP, and a lone surrogate as U+FFFD
  }
  return bytes;
}
export function boundedJson(input: unknown, limits: ValidationLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    check(Number.isSafeInteger(value) && value > 0, `$.limits.${key}`, 'Validation limits must be positive safe integers.');
  }
  for (const key of ['maxBytes', 'maxDepth', 'maxNodes', 'maxArrayLength', 'maxStringLength'] as const) {
    check(Number.isSafeInteger(limits[key]) && limits[key] > 0, `$.limits.${key}`, 'A validation limit is missing.');
  }
  const ancestors = new Set<object>();
  const stack: { value: unknown; path: string; depth: number; exit?: boolean }[] = [{ value: input, path: '$', depth: 0 }];
  let nodes = 0;
  let minimumBytes = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    const { value, path, depth } = entry;
    if (entry.exit) { ancestors.delete(value as object); continue; }
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) fail(path, 'Payload exceeds the configured structure limit.', 'LIMIT_EXCEEDED');
    if (typeof value === 'string') {
      if (value.length > limits.maxStringLength) fail(path, 'Text exceeds the configured length limit.', 'LIMIT_EXCEEDED');
      minimumBytes += utf8Length(value);
    } else if (typeof value === 'number') {
      check(Number.isFinite(value), path, 'Numbers must be finite.');
      minimumBytes += String(value).length;
    } else if (value === null || typeof value === 'boolean') {
      minimumBytes += value === null ? 4 : value ? 4 : 5;
    } else {
      check(typeof value === 'object', path, 'Payload must contain JSON data only.');
      const objectValue = value as object;
      if (ancestors.has(objectValue)) fail(path, 'Payload contains a cycle.', 'CYCLIC_PAYLOAD');
      const array = Array.isArray(value);
      check(array || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, path, 'Payload objects must be plain records.');
      if (array && value.length > limits.maxArrayLength) fail(path, 'Array exceeds the configured length limit.', 'LIMIT_EXCEEDED');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      check(Object.getOwnPropertySymbols(value).length === 0, path, 'Symbol fields are not supported.');
      ancestors.add(objectValue);
      stack.push({ value, path, depth, exit: true });
      const children: { value: unknown; path: string; depth: number }[] = [];
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        check(descriptor.enumerable && 'value' in descriptor, path, 'Accessors and hidden fields are not supported.');
        check(!['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key), path, 'Reserved fields are not supported.');
        if (array) check(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length, path, 'Array fields must be indexes.');
        if (key.length > limits.maxStringLength) fail(path, 'Field name exceeds the configured limit.', 'LIMIT_EXCEEDED');
        if (!array) minimumBytes += utf8Length(key);
        children.push({ value: descriptor.value, path: `${path}.${key}`, depth: depth + 1 });
      }
      if (array) check(children.length === value.length, path, 'Sparse arrays are not supported.');
      if (nodes + stack.length + children.length > limits.maxNodes * 2) fail(path, 'Payload exceeds the configured structure limit.', 'LIMIT_EXCEEDED');
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
    }
    if (minimumBytes > limits.maxBytes) fail(path, 'Payload exceeds the configured byte limit.', 'LIMIT_EXCEEDED');
  }
  if (utf8Length(JSON.stringify(input)) > limits.maxBytes) fail('$', 'Payload exceeds the configured byte limit.', 'LIMIT_EXCEEDED');
}

export function parse<T>(node: Node<T>, input: unknown, limits: ValidationLimits, options: ParseOptions = {}): ValidationResult<T> {
  try {
    boundedJson(input, limits);
    return { ok: true, value: node.read(input, '$', { options, limits }) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, issues: [error.issue] };
    return { ok: false, issues: [{ code: 'VALIDATION_FAILED', path: '$', message: 'Payload could not be read.' }] };
  }
}
export type Schema<T> = { parse(input: unknown, limits: ValidationLimits): ValidationResult<T> };
export function schema<T>(node: Node<T>): Schema<T> { return { parse: (input, limits) => parse(node, input, limits) }; }
export function string(max?: number, nonempty = true): Node<string> {
  return { read(value, path) {
    check(typeof value === 'string', path, 'Expected text.');
    check(!nonempty || value.trim().length > 0, path, 'Text must not be empty.');
    check(max === undefined || [...value].length <= max, path, 'Text exceeds the contract length limit.');
    return value;
  } };
}
export const text = string(undefined, false);
export const boolean: Node<boolean> = { read(value, path) { check(typeof value === 'boolean', path, 'Expected a boolean.'); return value; } };
export function number(min = -Infinity, max = Infinity, integer = false): Node<number> {
  return { read(value, path) {
    check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value)), path, 'Number is outside the permitted range.');
    return value;
  } };
}
export function enumeration<T extends string | number>(...values: T[]): Node<T> {
  return { read(value, path) { check(values.includes(value as T), path, 'Unsupported value.'); return value as T; } };
}
export const version: Node<1> = { read(value, path) { if (value !== 1) fail(path, 'This schema version is not supported.', 'UNSUPPORTED_VERSION'); return 1; } };
export function nullable<T>(node: Node<T>): Node<T | null> { return { read: (value, path, ctx) => value === null ? null : node.read(value, path, ctx) }; }
export function optional<T>(node: Node<T>): Node<T | undefined> { return { read: (value, path, ctx) => value === undefined ? undefined : node.read(value, path, ctx) }; }
export function array<T>(node: Node<T>, min = 0): Node<T[]> {
  return { read(value, path, ctx) { check(Array.isArray(value) && value.length >= min, path, 'Expected an array with the required entries.'); return value.map((item, i) => node.read(item, `${path}.${i}`, ctx)); } };
}
export function record<T>(node: Node<T>): Node<Record<string, T>> {
  return { read(value, path, ctx) {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), path, 'Expected a record.');
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => ctx.options.unknownFields !== 'strip' || !isPrivateField(key))
      .map(([key, item]) => [key, node.read(item, `${path}.${key}`, ctx)]));
  } };
}
function isPrivateField(key: string): boolean {
  return /^(privatenotes|privateannotations|email|accountemail|charactername|characterbinding|logpath|filepath|localpath|rawlog|rawlogs|logs|credentials|accesstoken|refreshtoken|bearertoken|sharetoken|sharecapability|password|secret|token|history)$/.test(key.replace(/[_-]/g, '').toLowerCase());
}
export function object<T>(shape: { [K in keyof T]-?: Node<T[K]> }): Node<T> {
  return { read(value, path, ctx) {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), path, 'Expected an object.');
    const input = value as Record<string, unknown>;
    if (ctx.options.unknownFields !== 'strip') {
      check(Object.keys(input).every(key => Object.hasOwn(shape, key)), path, 'Object contains an unsupported field.');
    }
    const output: Record<string, unknown> = {};
    for (const [key, node] of Object.entries(shape) as [string, Node<unknown>][]) {
      if (key === 'notes' && ctx.options.includeNotes === false) continue;
      if (key === 'history' && ctx.options.includeHistory === false) continue;
      const parsed = node.read(Object.hasOwn(input, key) ? input[key] : undefined, `${path}.${key}`, ctx);
      if (parsed !== undefined) output[key] = parsed;
    }
    return output as T;
  } };
}
export function tagged<T>(key: string, cases: Record<string, Node<unknown>>): Node<T> {
  return { read(value, path, ctx) {
    check(value !== null && typeof value === 'object', path, 'Expected a tagged object.');
    const tag = (value as Record<string, unknown>)[key];
    check(typeof tag === 'string' && Object.hasOwn(cases, tag), `${path}.${key}`, 'Unsupported object kind.');
    return cases[tag]!.read(value, path, ctx) as T;
  } };
}
export function refine<T>(node: Node<T>, validate: (value: T, path: string) => void): Node<T> {
  return { read(value, path, ctx) { const result = node.read(value, path, ctx); validate(result, path); return result; } };
}
export function unique<T>(values: T[], path: string): void { check(new Set(values).size === values.length, path, 'Duplicate identities are not permitted.'); }
