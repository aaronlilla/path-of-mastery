import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { compareVersions } from '@pom/protocol/semver';
import type { InstallerLaunch } from './appShellUpdater.js';
import { launcherPid } from '../automation.js';

/** Written by the install helper when the installer exits; read (and removed) at the next start. */
export const INSTALL_RESULT = 'install-result.json';

export interface InstallHelperPlan {
  /** The process the installer must wait for (this app's main process). */
  waitPid: number;
  installerPath: string;
  /** The app exe to start again afterwards, with the switches this run was started with. */
  relaunch: { exe: string; args: string[] } | null;
  resultPath: string;
  version: string;
  /** The process a scripted run (POM_AUTOMATION) watches to end the app when it dies. The relaunched app would otherwise
   *  watch this short-lived helper and exit about 2 s after starting. */
  launcherPid?: number;
}

/** Single-quoted PowerShell literal. */
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The PowerShell the hidden helper runs. It waits for the app to exit (an NSIS update over running files fails), runs
 * the NSIS installer silently as an update (/S --updated: no wizard, shortcuts and user data kept, same install folder),
 * records the exit code, then starts the app again with the same switches and environment as this run. The relaunch
 * happens even when the installer failed, so the player is never left with no app: the next start reads the result and
 * says the update did not install. electron-builder's own --force-run relaunch goes through Explorer, which drops the
 * environment and switches (a portable profile or POM_USER_DATA would be lost), so the helper relaunches instead.
 */
export function installHelperScript(plan: InstallHelperPlan): string {
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Wait-Process -Id ${plan.waitPid} -Timeout 120`,
    'Start-Sleep -Milliseconds 500',
    '$code = -1',
    `try { $p = Start-Process -FilePath ${ps(plan.installerPath)} -ArgumentList '/S','--updated' -PassThru -Wait; $code = $p.ExitCode } catch { $code = -2 }`,
    `$r = @{ version = ${ps(plan.version)}; code = $code; at = (Get-Date).ToString('o') }`,
    `[System.IO.File]::WriteAllText(${ps(plan.resultPath)}, ($r | ConvertTo-Json -Compress))`,
  ];
  if (plan.relaunch) {
    // Start-Process joins -ArgumentList with spaces, so each switch is quoted here.
    const args = plan.relaunch.args.map((a) => `'"${a.replace(/'/g, "''").replace(/"/g, '\\"')}"'`).join(',');
    if (plan.launcherPid) lines.push(`$env:POM_LAUNCHER_PID = '${plan.launcherPid}'`);
    // A failed start is written into the result file (relaunchError) for the next start to report.
    lines.push(
      `try { Start-Process -FilePath ${ps(plan.relaunch.exe)}${args ? ` -ArgumentList ${args}` : ''} -ErrorAction Stop } catch { $r.relaunchError = ${ps(plan.relaunch.exe)} + ': ' + $_.Exception.Message; [System.IO.File]::WriteAllText(${ps(plan.resultPath)}, ($r | ConvertTo-Json -Compress)) }`,
    );
  }
  return lines.join('\n');
}

/** The switches to start the new version with: this run's own `--` switches, minus deep links and update markers. */
export function relaunchArgs(argv: string[]): string[] {
  return argv.filter((a) => a.startsWith('--') && !a.startsWith('--updated') && !/^--(inspect|remote-debugging-pipe)/.test(a));
}

/**
 * Starts the helper hidden; it outlives this process. Through `cmd /c start /b`: PowerShell started directly as a
 * detached process (no console) exits at once without running anything, and a non-detached child dies with its parent.
 * Checked on Windows Server 2025 / PowerShell 5.1 (test/auto-update.test.ts runs it for real).
 */
export function spawnInstallHelper(plan: InstallHelperPlan): void {
  const encoded = Buffer.from(installHelperScript(plan), 'utf16le').toString('base64');
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/** Single-quoted POSIX shell literal. */
const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** What the running app is, to replace it in place: the .app folder on a Mac, the AppImage file on Linux. null when run from source. */
export function posixInstallTarget(platform: NodeJS.Platform, execPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform === 'darwin') return /^(.*\.app)\/Contents\/MacOS\//.exec(execPath)?.[1] ?? null;
  return env.APPIMAGE || null;
}

/**
 * The shell the helper runs on Mac and Linux (there is no silent installer there): wait for the app to exit, put the new
 * build over the running one (Mac: copy the .app out of the .dmg and clear its quarantine flag, since the build is not
 * notarized; Linux: replace the AppImage), record the result like the Windows helper, and start the app again.
 */
export function posixInstallScript(plan: InstallHelperPlan, platform: NodeJS.Platform, target: string): string {
  const t = sh(target);
  const install =
    platform === 'darwin'
      ? [
          'M=$(mktemp -d)',
          `if hdiutil attach -nobrowse -readonly -mountpoint "$M" ${sh(plan.installerPath)} >/dev/null 2>&1; then A=$(ls -d "$M"/*.app | head -1); rm -rf ${t} && ditto "$A" ${t} && xattr -cr ${t} || code=1; hdiutil detach "$M" -force >/dev/null 2>&1; else code=1; fi`,
        ]
      : [`cp -f ${sh(plan.installerPath)} ${t}.new && chmod +x ${t}.new && mv -f ${t}.new ${t} || code=1`];
  const args = plan.relaunch?.args.map(sh).join(' ') ?? '';
  const relaunch = plan.relaunch ? [platform === 'darwin' ? `open -n ${t}${args ? ` --args ${args}` : ''}` : `nohup ${t} ${args} >/dev/null 2>&1 &`] : [];
  return [
    'i=0',
    `while kill -0 ${plan.waitPid} 2>/dev/null && [ $i -lt 240 ]; do sleep 0.5; i=$((i+1)); done`,
    'code=0',
    ...install,
    `printf '{"version":"%s","code":%d,"at":"%s"}' ${sh(plan.version)} "$code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${sh(plan.resultPath)}`,
    ...relaunch,
  ].join('\n');
}

/** Production installer launch: Windows runs the PowerShell helper, Mac and Linux the shell one. */
export function makeSpawnInstaller(o: { execPath: string; argv: string[]; stagingDir: string; pid: number; platform?: NodeJS.Platform }) {
  return async (installerPath: string, launch?: InstallerLaunch): Promise<void> => {
    const platform = o.platform ?? process.platform;
    if (platform !== 'win32') {
      const target = posixInstallTarget(platform, o.execPath);
      if (!target) return; // run from source or an unpacked build: nothing to replace
      const plan: InstallHelperPlan = { waitPid: o.pid, installerPath, relaunch: launch?.relaunch === false ? null : { exe: o.execPath, args: relaunchArgs(o.argv) }, resultPath: join(o.stagingDir, INSTALL_RESULT), version: launch?.version ?? '' };
      spawn('/bin/sh', ['-c', posixInstallScript(plan, platform, target)], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawnInstallHelper({
      waitPid: o.pid,
      installerPath,
      relaunch: launch?.relaunch === false ? null : { exe: o.execPath, args: relaunchArgs(o.argv) },
      resultPath: join(o.stagingDir, INSTALL_RESULT),
      version: launch?.version ?? '',
      launcherPid: launcherPid(process.env, process.ppid),
    });
  };
}

export type InstallNotice = { kind: 'updated'; version: string; relaunchError?: string } | { kind: 'installFailed'; version: string; code: number; relaunchError?: string };

/** What the last install attempt did, judged by the version now running. Removes the record so it is said once. */
export async function readInstallResult(stagingDir: string, runningVersion: string): Promise<InstallNotice | null> {
  const p = join(stagingDir, INSTALL_RESULT);
  let raw: string;
  try {
    raw = (await readFile(p, 'utf8')).replace(/^﻿/, '');
  } catch {
    return null;
  }
  await rm(p, { force: true }).catch(() => {});
  try {
    const r = JSON.parse(raw) as { version?: string; code?: number; relaunchError?: string };
    const relaunchError = typeof r.relaunchError === 'string' ? { relaunchError: r.relaunchError } : {};
    if (typeof r.version !== 'string' || !r.version) return null;
    const cmp = compareVersions(runningVersion, r.version);
    if (runningVersion === r.version || cmp === 0) return { kind: 'updated', version: r.version, ...relaunchError };
    return { kind: 'installFailed', version: r.version, code: typeof r.code === 'number' ? r.code : -1, ...relaunchError };
  } catch {
    return null;
  }
}
