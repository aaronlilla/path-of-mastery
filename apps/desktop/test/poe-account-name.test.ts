import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountFromPage, accountFromProfile, firstCharacter } from '../src/main/wealth/poeSignIn.js';

test('the account name is read from the profile link of a signed-in page', () => {
  assert.equal(accountFromPage('<a class="profile-link" href="/account/view-profile/Kaelen-1234">Kaelen#1234</a>'), 'Kaelen#1234');
  assert.equal(accountFromPage('<a href="https://www.pathofexile.com/account/view-profile/Some%20Name-0042/characters">x</a>'), 'Some Name#0042');
  assert.equal(accountFromPage('<a href="/account/view-profile/OldName">x</a>'), 'OldName');
});

test('a page with no profile link gives no name', () => {
  assert.equal(accountFromPage('<a href="/login">Log in</a>'), null);
  assert.equal(accountFromPage(''), null);
});

test('profile-style answers give the name from either field, and nothing from anything else', () => {
  assert.equal(accountFromProfile({ name: 'Kaelen#1234' }), 'Kaelen#1234');
  assert.equal(accountFromProfile({ accountName: ' Kaelen#1234 ' }), 'Kaelen#1234');
  assert.equal(accountFromProfile({ error: { code: 8 } }), null);
  assert.equal(accountFromProfile(null), null);
});

test('the first character name comes from the character list', () => {
  assert.equal(firstCharacter([{ name: 'KaelenBoneshatter', league: 'Allflame' }, { name: 'Other' }]), 'KaelenBoneshatter');
  assert.equal(firstCharacter([]), null);
  assert.equal(firstCharacter({ error: 'x' }), null);
});
