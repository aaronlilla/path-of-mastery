import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedJson, utf8Length, type ValidationLimits } from '../src/validation.js';

const encoder = new TextEncoder();
const units = [0x00, 0x41, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfffd, 0xffff];

test('utf8Length equals TextEncoder byte length on edge code units, pairs and lone surrogates', () => {
  const cases = ['', 'ascii', 'é', '€', '😀', 'a😀b', '\ud83d', '\ude00', '\ude00\ud83d', '\ud83d😀', 'x\ud800', '􏿿'];
  for (const a of units) for (const b of units) cases.push(String.fromCharCode(a, b), String.fromCharCode(a) + 'z' + String.fromCharCode(b));
  for (const text of cases) assert.equal(utf8Length(text), encoder.encode(text).length, JSON.stringify(text));
});

test('utf8Length equals TextEncoder byte length on 20,000 random strings', () => {
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let n = 0; n < 20_000; n++) {
    const length = Math.floor(next() * 24);
    let text = '';
    for (let i = 0; i < length; i++) {
      const r = next();
      text += String.fromCharCode(r < 0.4 ? Math.floor(next() * 0x80) : r < 0.6 ? 0x80 + Math.floor(next() * 0x780) : r < 0.75 ? 0xd800 + Math.floor(next() * 0x800) : Math.floor(next() * 0x10000));
    }
    assert.equal(utf8Length(text), encoder.encode(text).length, JSON.stringify(text));
  }
});

test('boundedJson still refuses a payload one byte over maxBytes and accepts it at exactly maxBytes', () => {
  const limits: ValidationLimits = { maxBytes: 1, maxDepth: 8, maxNodes: 100, maxArrayLength: 100, maxStringLength: 100 };
  const value = { k: '😀é\ud800' };
  const exact = encoder.encode(JSON.stringify(value)).length;
  assert.doesNotThrow(() => boundedJson(value, { ...limits, maxBytes: exact }));
  assert.throws(() => boundedJson(value, { ...limits, maxBytes: exact - 1 }), /byte limit/);
  // the running minimum (strings + keys) trips before the final whole-payload check
  const strings = utf8Length('k') + utf8Length('😀é\ud800');
  assert.throws(() => boundedJson(value, { ...limits, maxBytes: strings - 1 }), /byte limit/);
});

test('on the bundled Atlas packs and starter manifest: utf8Length counts the same bytes as TextEncoder, and boundedJson is timed', async () => {
  const { readFileSync, readdirSync, existsSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const repo = [process.cwd(), resolve(process.cwd(), '../..')].find(d => existsSync(join(d, 'resources', 'atlas', 'packs')));
  assert.ok(repo, 'the bundled resources are present');
  const files = readdirSync(join(repo, 'resources', 'atlas', 'packs')).map(f => join(repo, 'resources', 'atlas', 'packs', f));
  files.push(join(repo, 'resources', 'mastery-starters', 'manifest.json'));
  const strings: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) { strings.push(k); collect(c); }
  };
  const inputs = files.map(f => JSON.parse(readFileSync(f, 'utf8')) as unknown);
  inputs.forEach(collect);
  let t = performance.now(), fast = 0;
  for (const s of strings) fast += utf8Length(s);
  const fastMs = performance.now() - t;
  t = performance.now(); let reference = 0;
  for (const s of strings) reference += encoder.encode(s).length;
  const referenceMs = performance.now() - t;
  assert.equal(fast, reference);
  const big: ValidationLimits = { maxBytes: 200_000_000, maxDepth: 64, maxNodes: 5_000_000, maxArrayLength: 200_000, maxStringLength: 1_048_576 };
  t = performance.now();
  for (const input of inputs) boundedJson(input, big);
  console.log(`${files.length} bundled files, ${strings.length} strings and keys, ${fast} UTF-8 bytes: utf8Length ${fastMs.toFixed(0)} ms vs TextEncoder ${referenceMs.toFixed(0)} ms; boundedJson over all ${(performance.now() - t).toFixed(0)} ms`);
});
