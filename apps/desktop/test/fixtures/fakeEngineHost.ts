/**
 * Stand-in "engine host" for the hot-swap tests, forked with plain
 * `child_process.fork` (no Electron runtime needed). Its behavior is picked
 * with the FAKE_ENGINE_MODE env var so the same script can play the
 * well-behaved new engine, one that rejects the handoff, one that fails to
 * recalculate, one that never responds (timeout path), or one that crashes
 * outright (early-exit path).
 */
import type { HostControlMessage, HostControlResponse } from '../../src/engine-host/controlProtocol.js';

type Mode = 'ok' | 'fail-load' | 'fail-recalc' | 'silent' | 'crash' | 'slow';

const mode = (process.env.FAKE_ENGINE_MODE as Mode | undefined) ?? 'ok';

if (mode === 'crash') {
  process.exit(1);
}

function reply(response: HostControlResponse): void {
  process.send?.({ kind: 'control-response', response });
}

// 'slow' is a cold start: it listens (and announces itself) only after a pause, the way a freshly forked engine on a busy machine does (longer than the handoff deadline).
const startDelayMs = mode === 'slow' ? 3200 : 0;

function listen(): void {
process.on('message', (message: HostControlMessage) => {
  if (!message || message.kind !== 'control') return;
  if (mode === 'silent') return;

  switch (message.type) {
    case 'loadBuildState':
      if (mode === 'fail-load') {
        reply({ type: 'loadBuildStateAck', ok: false, error: 'fake engine rejected build state' });
      } else {
        reply({ type: 'loadBuildStateAck', ok: true });
      }
      return;
    case 'recalculate':
      if (mode === 'fail-recalc') {
        reply({ type: 'recalculateResult', ok: false, error: 'fake engine failed to recalculate' });
      } else {
        reply({ type: 'recalculateResult', ok: true });
      }
      return;
    case 'ping':
      reply({ type: 'pong' });
      return;
  }
});

process.send?.({ type: 'status', status: { state: 'ready', engineVersion: 'fake' } });
}

setTimeout(listen, startDelayMs);
