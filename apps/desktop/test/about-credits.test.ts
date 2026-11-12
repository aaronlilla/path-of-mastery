// About lists credits and licences naming NeverSink (MIT) and Path of Building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('About names NeverSink (MIT) and Path of Building in its credits and licences', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/renderer/Dialogs.tsx', import.meta.url)), 'utf8');
  assert.match(src, /name: 'NeverSink'[^}]*licence: 'MIT'/);
  assert.match(src, /name: 'Path of Building'[^}]*licence: 'MIT'/);
  assert.match(src, /<b[^>]*>Credits<\/b>/);
  assert.match(src, /<b[^>]*>Licences<\/b>/);
});

test('Help tells the user to use the breadcrumb to go back up a folder', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/renderer/Dialogs.tsx', import.meta.url)), 'utf8');
  assert.match(src, /use the breadcrumb above the list to go back up/);
  assert.doesNotMatch(src, /click it again to go back up/);
});

test('a new build lives in memory until Save: no lib.create at creation, one at the first Save', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/renderer/App.tsx', import.meta.url)), 'utf8');
  // Every create path (dialog, palette, class pick, Describe it) goes through createBuild -> makeBuild, which makes the blank build in memory.
  const create = src.slice(src.indexOf('const makeBuild = useCallback'), src.indexOf('// ---- library actions'));
  assert.match(create, /const createBuild = useCallback[\s\S]*makeBuild\(className, name\)/);
  assert.doesNotMatch(create, /lib\.create/);
  assert.match(create, /blankBuildXml\(className/);
  const save = src.slice(src.indexOf('const save = useCallback'), src.indexOf('const freshRef'));
  assert.match(save, /freshRef\.current === cur\.id[\s\S]*lib\.create/);
});

test('Sync to cloud reports an unreachable cloud and leaves the build local', () => {
  const host = readFileSync(fileURLToPath(new URL('../../src/main/accounts/host.ts', import.meta.url)), 'utf8');
  assert.match(host, /enroll: async \(id: string\) => \{[\s\S]*?await engine\.syncNow\(\);[\s\S]*?v\.state === 'offline'[\s\S]*?unenroll\(id, false\)[\s\S]*?throw new Error/);
});

test('About shows the engine and interface versions now running, not the app version', () => {
  const dlg = readFileSync(fileURLToPath(new URL('../../src/renderer/Dialogs.tsx', import.meta.url)), 'utf8');
  assert.match(dlg, /Engine v\{layer\(engineVersion\)\} · Interface v\{layer\(interfaceVersion\)\}/);
  const ipc = readFileSync(fileURLToPath(new URL('../../src/main/libraryIpc.ts', import.meta.url)), 'utf8');
  assert.match(ipc, /engineVersion: deps\.versions\(\)\.engine/);
});

test('The share card shows why Sync to cloud failed, e.g. the cloud is down', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/renderer/accounts/SharePopover.tsx', import.meta.url)), 'utf8');
  assert.match(src, /enroll\(localId\)\.then\(\(r\) => \{\s*setBusy\(false\);\s*if \(!r\.ok\) setErr\(r\.error\);/);
});

test('The loot filter Ask panel fills the reply placeholders from the tool results it is sent', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/renderer/lootfilter/advanced/shell/AskChat.tsx', import.meta.url)), 'utf8');
  assert.match(src, /p\.kind === 'result'/);
  assert.match(src, /resolveOnly\(e\.type === 'done'/);
  assert.match(src, /streaming store=\{results\}/);
});
