// The app settings for code that is not a component (tooltip text, roll defaults, wheel handling). `useSettings` keeps it
// current, including while the Settings dialog previews a change.
import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/library.js';

let current: AppSettings = DEFAULT_SETTINGS;
const listeners = new Set<() => void>();

export function setAppSettings(s: AppSettings): void {
  if (s === current) return;
  current = s;
  for (const l of listeners) l();
}

export function getAppSettings(): AppSettings {
  return current;
}

export function useAppSettings(): AppSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
