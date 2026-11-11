import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex, bucketOf, utf8ByteLength } from '../src/sha256.js';
import { prng } from './prng.js';

test('sha256 matches the FIPS 180-4 test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256 equals node:crypto on 2,000 random inputs (lengths 0-300, unicode included)', () => {
  const r = prng(20261017);
  const alphabet = 'abcXYZ019 :./\\-_ée€😀\n';
  for (let i = 0; i < 2000; i++) {
    const len = r.int(0, 300);
    let s = '';
    for (let j = 0; j < len; j++) s += r.pick([...alphabet]);
    assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), `case ${i}`);
  }
});

test('bucketOf is the first two bytes mod 100 and spreads evenly', () => {
  const d = createHash('sha256').update('seed:area.atlas').digest();
  assert.equal(bucketOf('seed:area.atlas'), ((d[0]! << 8) | d[1]!) % 100);
  const counts = new Array(100).fill(0);
  for (let i = 0; i < 20000; i++) counts[bucketOf(`s${i}:k`)]++;
  // 200 expected per bucket; a fair hash stays well inside 120-280.
  assert.ok(Math.min(...counts) > 120 && Math.max(...counts) < 280, `min ${Math.min(...counts)} max ${Math.max(...counts)}`);
});

test('utf8ByteLength equals Buffer.byteLength on 5,000 random strings (ASCII, 2-, 3- and 4-byte, lone surrogates)', () => {
  const r = prng(31337);
  const chars = ['a', 'Z', '0', ' ', '\u00e9', '\u00df', '\u20ac', '\u4e2d', '\ud83d\ude00', '\ud800', '\udc00', '\n'];
  for (let i = 0; i < 5000; i++) {
    let s = '';
    for (let j = r.int(0, 200); j > 0; j--) s += r.pick(chars);
    assert.equal(utf8ByteLength(s), Buffer.byteLength(s, 'utf8'), JSON.stringify(s));
  }
});
