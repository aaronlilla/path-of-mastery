import { test } from 'node:test';
import assert from 'node:assert/strict';
import de from '../src/renderer/locales/de.js';
import { fromMain, useLanguage } from '../src/renderer/i18n.js';

test('a main-built English sentence comes out in the player language, unknown text stays English', async () => {
  await useLanguage('de', de as Record<string, unknown>);
  assert.equal(fromMain('sidebar_warnings', 'You do not have enough Mana to use: Boneshatter'), 'Du hast nicht genug Mana, um Folgendes zu verwenden: Boneshatter');
  assert.equal(fromMain('sidebar_warnings', 'Something we never wrote'), 'Something we never wrote');
});
