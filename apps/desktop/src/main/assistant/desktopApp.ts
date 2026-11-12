// Restarts the Claude Desktop app so it reads its new settings. The Claude Code command line is also called claude.exe,
// so the app is told apart by where it is installed, never by name alone.
import { execFile, spawn } from 'node:child_process';

export interface Proc {
  pid: number;
  path: string;
  cmd: string;
}

const INSTALL = /[\\/](AnthropicClaude|Programs[\\/]Claude|WindowsApps[\\/][^\\/]*Claude[^\\/]*)[\\/]/i;
const CLI = /[\\/]\.local[\\/]bin[\\/]/i;

/** The processes of the Claude Desktop app, from a list of claude.exe processes. */
export function desktopProcs(all: Proc[]): Proc[] {
  return all.filter((p) => INSTALL.test(p.path) && !CLI.test(p.path));
}

/** The app's main process (the others are helpers started with --type=). */
export function mainProc(procs: Proc[]): Proc | undefined {
  return procs.find((p) => !/--type=/.test(p.cmd)) ?? procs[0];
}

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 20000 }, (e, out) => (e ? reject(e) : resolve(out))));

const LIST = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }";

async function listWindows(): Promise<Proc[]> {
  const out = await run('powershell.exe', ['-NoProfile', '-Command', LIST]);
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, path, ...cmd] = l.split('\t');
    return { pid: Number(pid), path: path ?? '', cmd: cmd.join('\t') };
  });
}

/** Closes Claude Desktop and starts it again. Returns false when it is not running (nothing to restart). */
export async function restartClaudeDesktop(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'darwin') {
    try {
      await run('pgrep', ['-x', 'Claude']);
    } catch {
      return false;
    }
    await run('osascript', ['-e', 'tell application "Claude" to quit']);
    await new Promise((r) => setTimeout(r, 2500));
    await run('open', ['-a', 'Claude']);
    return true;
  }
  if (platform !== 'win32') throw new Error('Claude Desktop is not available on this system.');
  const procs = desktopProcs(await listWindows());
  const main = mainProc(procs);
  if (!main) return false;
  for (const p of procs) await run('taskkill', ['/PID', String(p.pid), '/T', '/F']).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  spawn(main.path, [], { detached: true, stdio: 'ignore' }).unref();
  return true;
}
