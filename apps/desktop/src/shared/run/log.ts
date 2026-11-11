import type { TelemetryState } from '../journey/telemetry.js';

export type RunLogState = { telemetry: TelemetryState; reading: boolean; filename: string | null };
export type RunLogCall =
  | { kind: 'chooseFile' | 'useDetected' | 'useNextCharacter' | 'stopReading' | 'continueManually' | 'declareAtMaps' }
  | { kind: 'selectCharacter'; name: string }
  | { kind: 'resolveCharacter'; choice: 'keep' | 'switch' }
  | { kind: 'setBaseline'; count: number }
  | { kind: 'autoFollow'; enabled: boolean };
