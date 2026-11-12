/// <reference types="vite/client" />
import type { PomBridge } from '../preload/index.js';

declare global {
  interface Window {
    PomLight?: { mount: (host: HTMLElement) => void };
    pom: PomBridge;
    /** The design system's scripts (public/design/*.js). */
    pomSetTheme?: (theme: string) => void;
    pomSetMode?: (mode: string) => void;
    pomSetTexture?: (v: string) => void;
    pomSetDensity?: (v: string) => void;
    pomGetMode?: () => { pref: string; mode: string };
    pomGlass?: { set(mode: string): void };
    pomIcon?: (name: string, size?: number) => string;
  }
}

// The <pom-icon> element type lives in jsx-env.d.ts (the Node test build reads it too).
export {};
