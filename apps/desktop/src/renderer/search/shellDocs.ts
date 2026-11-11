// Palette documents that exist without an open build: the Library's builds and the app's own settings.
import type { BuildEntry } from '../../shared/library.js';
import type { SearchDoc } from './searchIndex.js';
import { tr, inLanguage } from '../i18n';
import { levelLabel } from '../format.js';
import { AREA_LABEL, NAV_AREAS, type AppAreaId } from '../areaGate.js';

export type SettingsSection = 'general' | 'appearance' | 'build-defaults' | 'numbers' | 'network' | 'account' | 'advanced';

/** Every row of the Settings dialog, with the words that should also find it. */
export const SETTINGS_INDEX: { title: string; section: SettingsSection; extra?: string }[] = [
  { title: 'Build name in window title', section: 'general', extra: 'title bar' },
  { title: 'Early updates', section: 'general', extra: 'early access updates' },
  { title: 'Community builds on the Build List', section: 'general', extra: 'poe.ninja pobb.in library' },
  { title: 'Updates', section: 'general', extra: 'check for update version upgrade new release' },
  { title: 'Theme', section: 'appearance', extra: 'colour scheme obsidian midnight verdigris nocturne saffron umber look' },
  { title: 'Mode', section: 'appearance', extra: 'light dark system theme' },
  { title: 'Glass', section: 'appearance', extra: 'liquid clear frosted panels look' },
  { title: 'Texture', section: 'appearance', extra: 'stone subtle background look' },
  { title: 'Density', section: 'appearance', extra: 'comfortable compact rows spacing' },
  { title: 'UI scaling override', section: 'appearance', extra: 'zoom size dpi display scale' },
  { title: 'Animations', section: 'appearance', extra: 'motion reduce' },
  { title: 'Styled tooltips with flavour text', section: 'appearance', extra: 'tooltip' },
  { title: 'Node Power colours', section: 'appearance', extra: 'colour ramp tree red blue green' },
  { title: 'Positive values', section: 'appearance', extra: 'colour green increase' },
  { title: 'Negative values', section: 'appearance', extra: 'colour red decrease' },
  { title: 'Highlighted nodes', section: 'appearance', extra: 'colour search tree' },
  { title: 'Off-screen search markers', section: 'appearance', extra: 'tree arrows' },
  { title: 'Default character level', section: 'build-defaults', extra: 'new builds' },
  { title: 'Default gem quality', section: 'build-defaults', extra: 'new gem' },
  { title: 'Default item affix quality', section: 'build-defaults', extra: 'roll crafted slider' },
  { title: 'Build warnings', section: 'build-defaults', extra: 'sidebar points sockets requirements' },
  { title: 'Build save path', section: 'build-defaults', extra: 'folder directory where builds are saved' },
  { title: 'Thousands separators', section: 'numbers', extra: 'comma format numbers' },
  { title: 'Compact large numbers', section: 'numbers', extra: 'shorten abbreviate format numbers' },
  { title: 'Thousands separator', section: 'numbers', extra: 'comma character format numbers' },
  { title: 'Decimal separator', section: 'numbers', extra: 'point comma character format numbers' },
  { title: 'Connection protocol', section: 'network', extra: 'ipv4 ipv6 auto internet' },
  { title: 'Proxy server', section: 'network', extra: 'http socks5 host port internet' },
  { title: 'Assistant and account', section: 'account', extra: 'claude desktop connect mcp sign in discord account ai' },
  { title: 'All affix sliders', section: 'advanced', extra: 'roll' },
  { title: 'Tooltips only for affected slots', section: 'advanced', extra: 'tooltip items' },
  { title: 'Copy Eldritch implicits onto the display item', section: 'advanced', extra: 'searing tangled' },
  { title: 'Tooltips for unsupported mods', section: 'advanced', extra: 'tooltip calculator' },
  { title: 'Ignore mouse wheel on controls', section: 'advanced', extra: 'scroll dropdown' },
  { title: 'Invert slider scroll', section: 'advanced', extra: 'mouse wheel' },
];

const SECTION_LABEL: Record<SettingsSection, string> = {
  general: 'General',
  appearance: 'Appearance',
  'build-defaults': 'Build defaults',
  numbers: 'Numbers',
  network: 'Network',
  account: 'Assistant and account',
  advanced: 'Advanced',
};

/** Palette rows for every setting; running one opens Settings at its section with that row in view. */
export function settingsDocs(open: (section: SettingsSection, row: string) => void): SearchDoc[] {
  return SETTINGS_INDEX.map((s) => ({ kind: 'Option', title: inLanguage('SettingsDialog', s.title), meta: tr('h_search_shellDocs.settings_meta') + ' · ' + inLanguage('SettingsDialog', SECTION_LABEL[s.section]), extra: s.title + ' ' + (s.extra ?? '') + ' settings options preferences', run: () => open(s.section, s.title) }));
}

/** One row per Library build: every word of the name, its class, ascendancy and main skill find it. */
export function buildDocs(builds: BuildEntry[], open: (b: BuildEntry) => void): SearchDoc[] {
  return builds.map((b) => ({
    kind: 'Build',
    title: b.name,
    meta: levelLabel(b.info),
    extra: `${b.info.className} ${b.info.ascendClassName} ${b.info.mainSkill} ${b.folder}`,
    run: () => open(b),
  }));
}

/** One row per area on the area bar, in bar order (switched-off areas are not on it); Enter opens it, like Ctrl 1-N. */
export function areaDocs(open: (a: AppAreaId) => void): SearchDoc[] {
  return NAV_AREAS.map((a, i) => ({ kind: 'Area', title: AREA_LABEL[a], meta: `Ctrl ${i + 1}`, extra: 'area', run: () => open(a) }));
}
