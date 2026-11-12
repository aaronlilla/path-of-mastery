/**
 * Adds or replaces one entry under `mcpServers` in a JSON settings file by editing the text, so every other byte of
 * the file (comments-free JSON, key order, spacing, other servers, line endings) stays exactly as it was.
 */

interface Member {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

class JsonScanError extends Error {}

function skipWs(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i]!)) i++;
  return i;
}

function skipString(t: string, i: number): number {
  if (t[i] !== '"') throw new JsonScanError('expected a string');
  i++;
  while (i < t.length) {
    if (t[i] === '\\') i += 2;
    else if (t[i] === '"') return i + 1;
    else i++;
  }
  throw new JsonScanError('unterminated string');
}

function skipValue(t: string, i: number): number {
  i = skipWs(t, i);
  const c = t[i];
  if (c === '"') return skipString(t, i);
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    i++;
    for (;;) {
      i = skipWs(t, i);
      if (t[i] === close) return i + 1;
      if (c === '{') {
        i = skipString(t, i);
        i = skipWs(t, i);
        if (t[i] !== ':') throw new JsonScanError('expected a colon');
        i++;
      }
      i = skipValue(t, i);
      i = skipWs(t, i);
      if (t[i] === ',') i++;
      else if (t[i] !== close) throw new JsonScanError('expected a comma');
    }
  }
  const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(t.slice(i, i + 40));
  if (!m) throw new JsonScanError('unexpected character');
  return i + m[0].length;
}

/** Members of the object whose `{` is at `start`, and the index of its closing brace. */
function scanObject(t: string, start: number): { members: Member[]; close: number } {
  if (t[start] !== '{') throw new JsonScanError('expected an object');
  const members: Member[] = [];
  let i = start + 1;
  for (;;) {
    i = skipWs(t, i);
    if (t[i] === '}') return { members, close: i };
    const keyStart = i;
    const keyEnd = skipString(t, i);
    const key = JSON.parse(t.slice(keyStart, keyEnd)) as string;
    i = skipWs(t, keyEnd);
    if (t[i] !== ':') throw new JsonScanError('expected a colon');
    const valueStart = skipWs(t, i + 1);
    const valueEnd = skipValue(t, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd });
    i = skipWs(t, valueEnd);
    if (t[i] === ',') i++;
    else if (t[i] !== '}') throw new JsonScanError('expected a comma');
  }
}

function lineIndent(t: string, at: number): string {
  const ls = t.lastIndexOf('\n', at - 1) + 1;
  const m = /^[ \t]*/.exec(t.slice(ls, at));
  return m ? m[0] : '';
}

function render(value: unknown, unit: string, base: string, nl: string): string {
  return JSON.stringify(value, null, unit)
    .split('\n')
    .map((l, i) => (i === 0 ? l : base + l))
    .join(nl);
}

/** Inserts an entry as the last member of the object at `objStart`, or replaces the existing one. */
function upsert(t: string, objStart: number, key: string, value: unknown, parentIndent: string, nl: string): string {
  const { members, close } = scanObject(t, objStart);
  const existing = members.find((m) => m.key === key);
  const last = members[members.length - 1];
  let unit = '  ';
  let childIndent = parentIndent + unit;
  if (last) {
    const li = lineIndent(t, last.keyStart);
    if (li.startsWith(parentIndent) && li.length > parentIndent.length) {
      childIndent = li;
      unit = li.slice(parentIndent.length);
    }
  }
  if (existing) {
    return t.slice(0, existing.valueStart) + render(value, unit, lineIndent(t, existing.keyStart), nl) + t.slice(existing.valueEnd);
  }
  const entry = `${JSON.stringify(key)}: ${render(value, unit, childIndent, nl)}`;
  if (!last) {
    return t.slice(0, objStart + 1) + nl + childIndent + entry + nl + parentIndent + t.slice(close);
  }
  return t.slice(0, last.valueEnd) + ',' + nl + childIndent + entry + t.slice(last.valueEnd);
}

/**
 * Returns the file text with `servers[name] = value` set under the top-level `mcpServers`, creating `mcpServers` when
 * the file has none. Throws when the text is not a JSON object.
 */
export function setMcpServer(text: string, name: string, value: unknown): string {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const start = skipWs(text, bom);
  if (text[start] !== '{') throw new JsonScanError('the file is not a JSON object');
  const { members } = scanObject(text, start);
  const servers = members.find((m) => m.key === 'mcpServers');
  if (servers) {
    if (text[servers.valueStart] !== '{') throw new JsonScanError('mcpServers is not an object');
    return upsert(text, servers.valueStart, name, value, lineIndent(text, servers.keyStart), nl);
  }
  return upsert(text, start, 'mcpServers', { [name]: value }, '', nl);
}

export { JsonScanError };
