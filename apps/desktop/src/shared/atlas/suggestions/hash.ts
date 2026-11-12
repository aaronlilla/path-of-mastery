// Browser and Node both have Web Crypto. Used for rule and AI proposal identity; solver hashes come from main.
export async function sha256Hex(value: unknown): Promise<string> {
  const text = JSON.stringify(value, (_k, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
