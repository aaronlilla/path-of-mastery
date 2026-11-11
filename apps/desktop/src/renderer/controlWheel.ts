// The two wheel switches in Settings. A slider that has the keyboard focus moves one step per wheel notch (Invert slider
// scroll flips the direction); with "Ignore mouse wheel on controls" on, the wheel never changes a slider, a number box or
// a dropdown, so scrolling past them is safe.
import { steppedValue, wheelStep } from '../shared/settingsEffects';
import { getAppSettings } from './appSettings';

function setNativeValue(el: HTMLInputElement, v: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function installControlWheel(): () => void {
  const onWheel = (e: WheelEvent) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
    const s = getAppSettings();
    const focused = document.activeElement === t;
    if (t instanceof HTMLInputElement && t.type === 'range') {
      if (s.ignoreWheelOnControls || !focused) return;
      e.preventDefault();
      const next = steppedValue(Number(t.value), Number(t.min || 0), Number(t.max || 100), Number(t.step) || 1, wheelStep(e.deltaY, s.invertSliderScroll));
      setNativeValue(t, String(next));
    } else if (s.ignoreWheelOnControls && focused) {
      // A focused number box or dropdown would take the wheel as a change.
      e.preventDefault();
    }
  };
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return () => window.removeEventListener('wheel', onWheel, { capture: true });
}
