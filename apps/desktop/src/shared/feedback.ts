/** The feedback route: a new GitHub issue with the app version and the operating system already in the body. */
export const FEEDBACK_URL = 'https://github.com/aaronlilla/path-of-mastery/issues/new';

export function feedbackUrl(version: string, platform: string): string {
  const os = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
  const body = `

---
App version: ${version}
Operating system: ${os}
`;
  return `${FEEDBACK_URL}?title=${encodeURIComponent('Feedback')}&body=${encodeURIComponent(body)}`;
}
