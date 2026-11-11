// Loads the player's language file before the first screen. Vite-only (import.meta.glob), so tests never import it.
import type { LanguageSetting } from '../shared/library.js';
import { resolveLanguage, useLanguage } from './i18n';

const files = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*.ts');

export async function initI18n(setting: LanguageSetting): Promise<void> {
  const lng = resolveLanguage(setting);
  if (lng === 'en') return;
  const load = files[`./locales/${lng}.ts`];
  await useLanguage(lng, load ? (await load()).default : undefined); // no file yet for this language: English shows
}
