// Regenerates the telemetry allowlists (message templates, error classes and codes, starter ids, shipped bundle files)
// from the current sources. Run by the protocol, desktop and site builds so the lists cannot go stale; a stale list
// would only remove more from error reports, never let anything through.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const script of ['gen-message-templates.mjs', 'gen-bundle-files.mjs']) {
  execFileSync(process.execPath, [join(here, script), ...process.argv.slice(2)], { stdio: 'inherit' });
}
