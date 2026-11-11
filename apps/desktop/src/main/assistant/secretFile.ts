import { execFile } from 'node:child_process';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` }));
  });
}

/** The account name icacls needs: DOMAIN\user. */
function me(): string {
  const u = userInfo().username;
  const d = process.env.USERDOMAIN;
  return d ? `${d}\\${u}` : u;
}

/**
 * Writes a file only the current user can read. The file is created empty and locked first, then filled, so the
 * secret never sits in a file other accounts could open. On Windows the inherited permissions are removed and only
 * this user is granted access (mode bits do nothing there); elsewhere mode 600 does it. Throws if the lock fails,
 * after deleting the file, so a secret is never left readable.
 */
export async function writePrivateFile(file: string, content: string): Promise<void> {
  await writeFile(file, '', { mode: 0o600 });
  try {
    if (process.platform === 'win32') {
      const r = await run('icacls', [file, '/inheritance:r', '/grant:r', `${me()}:(R,W,D)`]);
      if (!r.ok) throw new Error(`Could not restrict ${file}: ${r.out.trim().slice(0, 200)}`);
    } else await chmod(file, 0o600);
    await writeFile(file, content);
  } catch (e) {
    await rm(file, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Who can open the file, as the OS reports it. Windows: the account names from icacls. Elsewhere: the mode bits. */
export async function fileAccess(file: string): Promise<string[]> {
  if (process.platform !== 'win32') {
    const { stat } = await import('node:fs/promises');
    const m = (await stat(file)).mode & 0o777;
    return m & 0o077 ? ['group/other'] : ['owner'];
  }
  const r = await run('icacls', [file]);
  const names = r.out
    .split(file)
    .join('')
    .split(file.split('/').join('\\'))
    .join('')
    .split(/\r?\n/)
    .map((l) => /^(.+?):\(/.exec(l.trim())?.[1]?.trim())
    .filter((x): x is string => !!x);
  return names;
}
