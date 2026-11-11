import { deflateSync, inflateSync, inflateRawSync } from 'node:zlib';
import { looksLikeCodeText } from '../../shared/buildSites.js';

/**
 * Build codes: the build XML, zlib-deflated, then base64 with "-" and "_" in place of "+" and "/".
 * Decoding also accepts plain base64, stray whitespace and missing padding.
 */

export class BuildCodeError extends Error {}

export function encodeBuildCode(xml: string): string {
  const deflated = deflateSync(Buffer.from(xml, 'utf8'), { level: 9 });
  return deflated.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function decodeBuildCode(code: string): string {
  // As in upstream: whatever is not part of the code's alphabet (spaces, line breaks, stray marks) is ignored.
  const clean = code.replace(/[^A-Za-z0-9+/_=-]/g, '');
  if (!clean) throw new BuildCodeError('There is no code to read.');
  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Buffer.from(b64, 'base64');
  let raw: Buffer;
  try {
    raw = inflateSync(bytes);
  } catch {
    try {
      raw = inflateRawSync(bytes);
    } catch {
      throw new BuildCodeError('That code could not be unpacked. It may be cut off or not from Path of Building.');
    }
  }
  const xml = raw.toString('utf8').replace(/^﻿/, '');
  if (/<PathOfBuilding2[\s>]/.test(xml)) throw new BuildCodeError('That is a Path of Exile 2 build. This app plans Path of Exile 1 builds.');
  if (!/<PathOfBuilding[\s>]/.test(xml)) throw new BuildCodeError('That code unpacked, but it is not a Path of Building build.');
  return xml;
}

/** True when the text looks like a build code and is not a link or XML. */
export function looksLikeCode(text: string): boolean {
  return looksLikeCodeText(text);
}
