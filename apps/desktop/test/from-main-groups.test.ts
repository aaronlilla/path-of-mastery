import { test } from 'node:test';
import assert from 'node:assert/strict';
import de from '../src/renderer/locales/de.js';
import { en } from '../src/renderer/locales/en.js';
import { fromMain, label, tr, useLanguage } from '../src/renderer/i18n.js';

// Every ml_* template, filled with sample values, must come back through fromMain as its own German text.
// A template that another one swallows, or that never matches, shows here as a mismatch.
test('every ml_ template round-trips through fromMain in German', async () => {
  await useLanguage('de', de as Record<string, unknown>);
  const bad: string[] = [];
  let n = 0;
  for (const [group, keys] of Object.entries(en as Record<string, Record<string, string>>)) {
    if (!group.startsWith('ml_')) continue;
    for (const [k, text] of Object.entries(keys)) {
      if (k.endsWith('_one') || k.endsWith('_few') || k.endsWith('_many')) continue;
      const key = k.replace(/_other$/, '');
      const vars: Record<string, string | number> = {};
      const english = text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
        const v = name === 'count' ? '2' : name.startsWith('label') ? 'Life' : 'sample-' + name;
        vars[name] = name === 'count' ? 2 : name.startsWith('label') ? label('Life') : name.startsWith('sub') ? fromMain(group as never, v) : v;
        return v;
      });
      const want = (tr as unknown as (k: string, o: object) => string)(`${group}.${key}`, vars);
      const got = fromMain(group as never, english);
      n++;
      if (got !== want) bad.push(`${group}.${k}: "${english}" gave "${got}", wanted "${want}"`);
    }
  }
  assert.ok(n > 100, 'templates found: ' + n);
  assert.deepEqual(bad, []);
});
