// App language. `tr('group.key', { name })` reads the English source file (locales/en.ts, the typed key list) or the player's
// language file (locales/<code>.ts). Strings are read at load, so a language change reloads the window (see appearance.ts).
// Game names (items, skills, gems, passives, mods) are not in these files: they come from game data and stay English.
// English is ready the moment this file loads (tests and tools use it as is); main.tsx adds the player's language first.
import i18next from 'i18next';
import { LANGUAGE_CODES, type LanguageCode, type LanguageSetting } from '../shared/library.js';
import { en, type Messages } from './locales/en.js';

/** Each language in its own name, so a player can always find theirs. */
export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  ja: '日本語',
  ko: '한국어',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  th: 'ไทย',
};

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: Messages };
  }
}

/** The system language (or the saved one) as one of our codes; anything we do not have falls back to English. */
export function resolveLanguage(setting: LanguageSetting, system: string = typeof navigator === 'undefined' ? 'en' : navigator.language): LanguageCode {
  if (setting !== 'system') return setting;
  const l = system.toLowerCase();
  if (l.startsWith('pt')) return 'pt-BR';
  return LANGUAGE_CODES.find((c) => c !== 'pt-BR' && l.startsWith(c)) ?? 'en';
}

void i18next.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  initAsync: false,
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
});

/** Switches the whole app to a language file that main.tsx loaded (see i18nLoad.ts). */
export async function useLanguage(code: LanguageCode, messages?: Record<string, unknown>): Promise<void> {
  if (messages) i18next.addResourceBundle(code, 'translation', messages, true, true);
  await i18next.changeLanguage(code);
  if (typeof document !== 'undefined') document.documentElement.lang = code;
}

export const tr = ((...a: never[]) => (i18next.t as unknown as (...x: never[]) => string)(...a)) as unknown as typeof i18next.t;

/**
 * A label that comes as English data (a stat name from the engine, a slot name, a filter choice) in the current language.
 * Rule: the game's own official translation where the game has one (names read from the game's data, e.g. Life, Energy Shield,
 * Fire Resistance), the words around them translated by us; with no entry the English shows. A trailing colon and a trailing
 * number ("Weapon 1:") are kept; an all-capital heading stays all capitals.
 */
export function label(english: string): string {
  const t = i18next.t as unknown as (key: string) => string;
  const hit = (s: string): string | null => {
    const k = 'labels.' + s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return i18next.exists(k) ? t(k) : null;
  };
  const colon = english.endsWith(':');
  const base = colon ? english.slice(0, -1) : english;
  let out = hit(base);
  if (out === null) {
    const n = /^(.*\S) (\d+)$/.exec(base);
    const b = n ? hit(n[1]!) : null;
    out = n && b !== null ? `${b} ${n[2]}` : base;
  } else if (base === base.toUpperCase() && /[A-Z]/.test(base)) out = out.toUpperCase();
  return colon ? out + ':' : out;
}

const sentences = new Map<string, Array<{ re: RegExp; key: string; names: string[]; fixed: number }>>();

/**
 * A finished English sentence built in main or shared code (a sidebar warning, an Atlas edit label) in the current language.
 * It is matched against the English templates of `group` ({{name}} stands for any text); the player's file renders the match.
 * A {{label...}} part is a stat or slot name and goes through label(); {{count}} picks the plural form (keys ending _one and
 * _other). No template fits: the English shows.
 */
export function fromMain(group: keyof Messages, english: string): string {
  let list = sentences.get(group);
  if (!list) {
    const g = en[group] as Record<string, string>;
    list = Object.keys(g).map((k) => {
      const names: string[] = [];
      const src = g[k]!.split(/\{\{(\w+)\}\}/).map((part, i) => (i % 2 ? (names.push(part), '([\\s\\S]+?)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
      return { re: new RegExp(`^${src}$`), key: k.replace(/_(one|other)$/, ''), names, fixed: g[k]!.replace(/\{\{\w+\}\}/g, '').length };
    }).sort((a, b) => b.fixed - a.fixed);
    sentences.set(group, list);
  }
  for (const { re, key, names } of list) {
    const m = re.exec(english);
    if (!m) continue;
    const vars: Record<string, string | number> = {};
    names.forEach((n, i) => { vars[n] = n === 'count' ? Number(m[i + 1]) : n.startsWith('sub') ? fromMain(group, m[i + 1]!) : n.startsWith('label') ? label(m[i + 1]!) : m[i + 1]!; });
    return (tr as unknown as (k: string, o: object) => string)(`${group}.${key}`, vars);
  }
  return english;
}

/** For code that holds an English label (a palette result naming a Settings row): the same label in the current language. */
export function inLanguage(group: keyof Messages, english: string): string {
  const g = en[group] as Record<string, string>;
  const k = Object.keys(g).find((x) => g[x] === english);
  return k ? (tr as unknown as (key: string) => string)(`${group}.${k}`) : english;
}
