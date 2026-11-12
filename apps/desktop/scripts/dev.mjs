// Development run: the renderer from Vite's dev server (hot reload), the main process
// from its build. `npm run dev` builds main, preload and bridge first. Closing the window stops the dev server.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import electron from 'electron';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ configFile: path.join(app, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`renderer dev server ${url}`);

const child = spawn(electron, ['.'], {
  cwd: app,
  stdio: 'inherit',
  env: {
    ...process.env,
    POM_RENDERER_DEV_SERVER_URL: url,
    POM_NATIVE_ENGINE_PATH: process.env.POM_NATIVE_ENGINE_PATH ?? path.join(app, 'resources/engine/pom_napi.node'),
  },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
