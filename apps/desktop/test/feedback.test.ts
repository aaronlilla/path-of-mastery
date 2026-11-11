// The feedback route opens a new GitHub issue with the app version and OS prefilled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackUrl } from '../src/shared/feedback.js';

test('feedback opens a new issue with version and OS in the body', () => {
  const u = feedbackUrl('0.1.0', 'win32');
  assert.match(u, /^https:\/\/github\.com\/aaronlilla\/path-of-mastery\/issues\/new\?/);
  const body = decodeURIComponent(/body=([^&]*)/.exec(u)![1]!);
  assert.match(body, /App version: 0\.1\.0/);
  assert.match(body, /Operating system: Windows/);
});
