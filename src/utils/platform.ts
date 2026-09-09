/**
 * Cross-platform helpers for spawning processes on Windows vs Unix.
 *
 * On Windows, npm-installed CLIs are `.cmd` shim files that require
 * `shell: true` to execute. The `which` binary doesn't exist — use
 * `where.exe` instead.
 */
import { spawn, spawnSync } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';

/** `'where'` on Windows, `'which'` on Unix */
export const WHICH_CMD = IS_WINDOWS ? 'where' : 'which';

/** Spread into `spawn`/`spawnSync` options to enable shell on Windows */
export const SHELL_OPTION: { shell: boolean } | Record<string, never> = IS_WINDOWS ? { shell: true } : {};

/**
 * Launch a GUI app by name (detached, best effort). `open -a` on macOS,
 * `start` via cmd on Windows, direct spawn elsewhere. Returns whether the
 * spawn was issued — not a guarantee the app actually started.
 */
export function launchGuiApp(appName: string): boolean {
  try {
    const child = IS_WINDOWS
      ? spawn('cmd', ['/c', 'start', '', appName], { stdio: 'ignore', detached: true })
      : process.platform === 'darwin'
        ? spawn('open', ['-a', appName], { stdio: 'ignore', detached: true })
        : spawn(appName, [], { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
      /* listener attached so spawn errors never crash the process */
      void err;
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a URL or URI scheme (e.g. a `qoder-work://` deeplink) with the
 * platform's default handler. Best effort.
 */
export function openExternalUrl(url: string): boolean {
  try {
    const child = IS_WINDOWS
      ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
      : process.platform === 'darwin'
        ? spawn('open', [url], { stdio: 'ignore', detached: true })
        : spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
      void err;
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a process whose image name matches is running. `pgrep -x` on
 * Unix; `tasklist` on Windows (which exits 0 even with no match, so the
 * output itself is checked).
 */
export function isProcessRunning(imageName: string): boolean {
  try {
    const out = IS_WINDOWS
      ? spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          timeout: 5000,
        })
      : spawnSync('pgrep', ['-x', imageName], { encoding: 'utf8', timeout: 5000 });
    if (out.status !== 0) return false;
    return IS_WINDOWS
      ? out.stdout.toLowerCase().includes(`${imageName.toLowerCase()}.exe`) ||
          out.stdout.toLowerCase().includes(imageName.toLowerCase())
      : out.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
