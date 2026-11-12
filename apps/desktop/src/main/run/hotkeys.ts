import { randomUUID } from 'node:crypto';
import type { RunService } from './service.js';

type Shortcuts = { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void; isRegistered(accelerator: string): boolean };
export class RunHotkeys {
  private bindings: string[] = [];
  constructor(private readonly shortcuts: Shortcuts, private readonly service: RunService, private readonly onError: (error: unknown) => void) {}
  get enabled(): boolean { return this.bindings.length === 2; }
  configure(next: string, back: string): void {
    if (!next.trim() || !back.trim() || next.toLowerCase() === back.toLowerCase() || [next, back].some(key =>
      /^(?:Control|Ctrl|Command|Cmd|CommandOrControl)\+[1-6]$/i.test(key) || this.shortcuts.isRegistered(key) && !this.bindings.includes(key)))
      throw new Error('Choose two available Run shortcuts.');
    this.disable();
    for (const [key, kind] of [[next, 'next'], [back, 'back']] as const) {
      if (!this.shortcuts.register(key, () => {
        const view = this.service.view();
        if (!view) return;
        void this.service.command({ kind, commandId: randomUUID(), ...(kind === 'next' ? {
          bundleId: view.displayed.bundleId, presentationVersion: view.presentationVersion } : {}) }).catch(this.onError);
      })) { this.disable(); throw new Error('This Run shortcut is already in use.'); }
      this.bindings.push(key);
    }
  }
  disable(): void { for (const key of this.bindings) this.shortcuts.unregister(key); this.bindings = []; }
}
