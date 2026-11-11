export type Bounds = { x: number; y: number; width: number; height: number };
export type Monitor = { id: string; name: string; workArea: Bounds; primary: boolean };
export type WindowPreferences = {
  bounds: Bounds; monitorId: string; alwaysOnTop: boolean; size: 'compact' | 'standard' | 'large';
  orientation: 'auto' | 'horizontal' | 'vertical'; textSize: 26 | 32; opacity: number; sound: boolean;
};
