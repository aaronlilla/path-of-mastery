import type { PublicInline, PublicItemPayload, PublicRichText, PublicTextBlock } from './marketplace.js';
import { isSafeHttpsUrl } from './links.js';
import { publicItemPayloadNode, publicRichTextNode } from './schemas.js';
import { parse, text, type ValidationLimits, type ValidationResult } from './validation.js';

export type PublicPayloadOptions = { includeNotes?: boolean; includeHistory?: boolean };
export function sanitizePublicPayload(input: unknown, limits: ValidationLimits, options: PublicPayloadOptions = {}): ValidationResult<PublicItemPayload> {
  return parse(publicItemPayloadNode, input, limits, {
    unknownFields: 'strip', includeNotes: options.includeNotes === true, includeHistory: options.includeHistory === true,
  });
}

function inline(source: string): PublicInline[] {
  const result: PublicInline[] = [];
  const pattern = /\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > offset) result.push({ kind: 'text', text: source.slice(offset, match.index) });
    if (match[1] !== undefined) {
      result.push(isSafeHttpsUrl(match[2]!) ? { kind: 'link', text: match[1], href: match[2]! } : { kind: 'text', text: match[1] });
    } else if (match[3] !== undefined) result.push({ kind: 'strong', text: match[3] });
    else if (match[4] !== undefined) result.push({ kind: 'emphasis', text: match[4] });
    else result.push({ kind: 'code', text: match[5]! });
    offset = match.index + match[0].length;
  }
  if (offset < source.length) result.push({ kind: 'text', text: source.slice(offset) });
  return result;
}

export function publicTextFromMarkdown(input: unknown, limits: ValidationLimits): ValidationResult<PublicRichText> {
  const validated = parse(text, input, limits);
  if (!validated.ok) return validated;
  const blocks: PublicTextBlock[] = [];
  for (const line of validated.value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    const list = /^[-*] (.*)$/.exec(line);
    if (heading) blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, content: inline(heading[2]!) });
    else if (list) blocks.push({ kind: 'list_item', content: inline(list[1]!) });
    else blocks.push({ kind: 'paragraph', content: inline(line) });
  }
  return parse(publicRichTextNode, blocks, limits);
}

