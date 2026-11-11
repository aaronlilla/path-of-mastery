import { randomUUID } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import { basename } from 'node:path';
import type { RunLogCall, RunLogState } from '../../shared/run/log.js';
import type { JourneyTelemetry } from '../journey/telemetry.js';
import type { RunService } from './service.js';

export class RunLogHost {
  private path: string | null = null;
  private reading = false;
  constructor(private readonly telemetry: JourneyTelemetry, private readonly service: RunService,
    private readonly chooseFile: () => Promise<string | null>,
    private readonly detect: () => string | null = () => null) {}
  /** A Client.txt found at a known install location (file name only; the path stays in main). */
  detected(): { filename: string } | null { const p = this.detect(); return p ? { filename: basename(p) } : null; }
  state(): RunLogState { return { telemetry: this.telemetry.state(), reading: this.reading, filename: this.path ? basename(this.path) : null }; }
  async call(input: unknown): Promise<RunLogState> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Run log request.');
    const c = input as Record<string, unknown>;
    const fields: Record<RunLogCall['kind'], string[]> = { chooseFile: [], useDetected: [], useNextCharacter: [], stopReading: [], continueManually: [], declareAtMaps: [],
      selectCharacter: ['name'], resolveCharacter: ['choice'], setBaseline: ['count'], autoFollow: ['enabled'] };
    if (typeof c.kind !== 'string' || !Object.hasOwn(fields, c.kind) || Object.keys(c).some(k => !['kind', ...fields[c.kind as RunLogCall['kind']]].includes(k)))
      throw new Error('Invalid Run log request.');
    if (!this.service.view()) throw new Error('No active Run.');
    switch (c.kind) {
      case 'chooseFile': {
        const selected = await this.chooseFile();
        // A missing or unreadable file must say so: never show it as "Reading".
        if (selected) { await access(selected, constants.R_OK).catch(() => { throw new Error('Could not read this file.'); }); await this.telemetry.startReading(selected); this.path = selected; this.reading = true; }
        break;
      }
      case 'useDetected': {
        const found = this.detect();
        if (!found) throw new Error('No Client.txt was found.');
        await this.telemetry.startReading(found); this.path = found; this.reading = true; break;
      }
      case 'selectCharacter':
        if (typeof c.name !== 'string' || !c.name.trim()) throw new Error('Select a character.');
        this.telemetry.selectCharacter(c.name); break;
      case 'useNextCharacter': this.telemetry.useNextDetectedCharacter(); break;
      case 'resolveCharacter':
        if (c.choice !== 'keep' && c.choice !== 'switch') throw new Error('Invalid character choice.');
        this.telemetry.resolveCharacter(c.choice); break;
      case 'setBaseline':
        if (!Number.isSafeInteger(c.count) || (c.count as number) < 0) throw new Error('Invalid Atlas baseline.');
        this.telemetry.setManualBaseline(c.count as number, new Date().toISOString()); break;
      case 'declareAtMaps': {
        const anchor = this.service.firstMapAnchor();
        if (!anchor) throw new Error('This timeline has no First-map instruction anchor.');
        this.telemetry.declareAtMaps(anchor, new Date().toISOString()); break;
      }
      case 'stopReading': this.telemetry.stopReading(); this.reading = false; break;
      case 'continueManually': await this.service.command({ commandId: randomUUID(), kind: 'manual' }); break;
      case 'autoFollow':
        if (typeof c.enabled !== 'boolean') throw new Error('Invalid auto-follow setting.');
        if (c.enabled && (!this.reading || !this.telemetry.canFollow())) throw new Error('Character not confirmed.');
        await this.service.command({ commandId: randomUUID(), kind: c.enabled ? 'follow' : 'manual' }); break;
    }
    await this.service.acceptTelemetry(this.telemetry.state()); await this.telemetry.flush();
    return this.state();
  }
}
