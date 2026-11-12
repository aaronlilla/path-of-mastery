import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/library.js';
import { setAppSettings } from './appSettings';
import { saveAllForRestart } from './closeGuard';
import { tr } from './i18n';

export const THEMES: { id: AppSettings['theme']; label: string; dark: string[]; light: string[] }[] = [
  { id: 'obsidian', label: tr('h_rA_theme.obsidian'), dark: ['#070605', '#f0c068', '#f6e7c8', '#1f1c19', '#5a78c8'], light: ['#ece5db', '#8e5d1e', '#412706', '#fffdf9', '#e0b491'] },
  { id: 'midnight', label: tr('h_rA_theme.midnight'), dark: ['#020611', '#e6c188', '#f8ebd7', '#0d192a', '#537693'], light: ['#dee7f1', '#8e661e', '#3e2903', '#fafeff', '#a4c2dc'] },
  { id: 'verdigris', label: tr('h_rA_theme.verdigris'), dark: ['#010808', '#e2a078', '#ffe7d9', '#0a1c1c', '#4e7b78'], light: ['#dce9e9', '#9c5c33', '#45240e', '#f9ffff', '#91cbc6'] },
  { id: 'nocturne', label: tr('h_rA_theme.nocturne'), dark: ['#05050f', '#e7a7ac', '#fee6e7', '#161727', '#6a6e94'], light: ['#e5e5f0', '#955259', '#452225', '#fdfdff', '#b5bae4'] },
  { id: 'saffron', label: tr('h_rA_theme.saffron'), dark: ['#0b0408', '#eab76c', '#fbead4', '#21141b', '#876678'], light: ['#ede3e8', '#976213', '#422700', '#fffcfe', '#dbafc7'] },
  { id: 'umber', label: tr('h_rA_theme.umber'), dark: ['#0b0503', '#83c2bc', '#ddf2ef', '#21160f', '#886b54'], light: ['#efe4dc', '#2a706b', '#103532', '#fffdf9', '#dbb597'] },
];

/** Puts every appearance setting on the page. Safe to call again; it only sets attributes and variables. */
export function applyAppearance(s: AppSettings): void {
  const root = document.documentElement;
  window.pomSetTheme?.(s.theme);
  window.pomSetMode?.(s.mode);
  window.pomSetTexture?.(s.texture);
  window.pomSetDensity?.(s.density);
  window.pomGlass?.set(s.glass);
  root.setAttribute('data-reduced-motion', s.animations ? 'off' : 'on');
  // The factory colours are made for dark surfaces (neon green on cream is unreadable), so in a light mode they give way to the
  // theme's own light-mode values; a colour the player picked is always kept.
  const light = root.getAttribute('data-mode') === 'light';
  const put = (name: string, value: string, factory: string) => (light && value.toLowerCase() === factory.toLowerCase() ? root.style.removeProperty(name) : root.style.setProperty(name, value));
  put('--positive', s.positiveColour, DEFAULT_SETTINGS.positiveColour);
  put('--negative', s.negativeColour, DEFAULT_SETTINGS.negativeColour);
  root.style.setProperty('--highlight', s.highlightColour);
  if (s.uiScale === 'system') window.pom.app.setAutoZoom();
  else window.pom.app.setZoom(Number(s.uiScale) / 100);
}

export function useSettings(): { settings: AppSettings; ready: boolean; update: (patch: Partial<AppSettings>) => Promise<{ ok: true } | { ok: false; error: string }>; preview: (patch: Partial<AppSettings>) => void } {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  useEffect(() => setAppSettings(settings), [settings]);
  useEffect(() => {
    let alive = true;
    void window.pom.settings.get().then((r) => {
      if (!alive) return;
      if (r.ok) {
        setSettings(r.value);
        applyAppearance(r.value);
      }
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  /** Saves a change; says whether it reached the disk, so a failed write is never reported as saved. */
  const update = useCallback(async (patch: Partial<AppSettings>): Promise<{ ok: true } | { ok: false; error: string }> => {
    // A new language reloads the window: every open document is saved first, and nothing changes if one cannot be.
    if (patch.language !== undefined && !(await saveAllForRestart())) return { ok: false, error: tr('appearance.a_build_could_not_be_saved') };
    const r = await window.pom.settings.set(patch);
    if (r.ok) {
      setSettings(r.value);
      applyAppearance(r.value);
      if (patch.language !== undefined) window.location.reload(); // strings are read at load, so a new language starts the window over
      return { ok: true };
    }
    return { ok: false, error: r.error };
  }, []);
  /** Shows a change without saving it (the Settings dialog does this until Save). */
  const preview = useCallback((patch: Partial<AppSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      applyAppearance(next);
      return next;
    });
  }, []);
  return { settings, ready, update, preview };
}
