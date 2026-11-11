import { ACTIONS, CONDITIONS } from '../../../../shared/lootfilter/syntax.js';

export interface Tok {
  s: string;
  c: string;
}

const COND = new Set(Object.keys(CONDITIONS));
const ACT = new Set<string>(ACTIONS);

/** Splits one filter line into coloured pieces, the way the design colours code. Colours are theme tokens. */
export function highlight(line: string): Tok[] {
  const ci = line.indexOf('#');
  const code = ci >= 0 ? line.slice(0, ci) : line;
  const cm = ci >= 0 ? line.slice(ci) : '';
  const out: Tok[] = [];
  for (const w of code.split(/(\s+|"[^"]*")/)) {
    if (w === '') continue;
    let c = 'var(--text-2)';
    if (/^\s+$/.test(w)) c = 'inherit';
    else if (w === 'Hide') c = 'var(--negative-text)';
    else if (w === 'Show' || w === 'Minimal') c = 'var(--gold-text)';
    else if (COND.has(w)) c = 'var(--info)';
    else if (ACT.has(w)) c = 'var(--mod-crafted)';
    else if (w[0] === '"') c = 'var(--positive-text)';
    else if (/^-?[0-9]+$/.test(w)) c = 'var(--text-strong)';
    else if (/^(==|>=|<=|<|>|=|!=|!)$/.test(w)) c = 'var(--text-muted)';
    out.push({ s: w, c });
  }
  if (cm) out.push({ s: cm, c: 'var(--text-faint)' });
  if (!out.length) out.push({ s: ' ', c: 'inherit' });
  return out;
}
