import { execSync } from 'child_process';

/**
 * Fix PATH for GUI-launched Mac apps.
 * When launched from Finder, Electron doesn't inherit the user's shell PATH,
 * so `claude` CLI won't be found. Spawn a login shell to get the real env.
 */
export function loadShellEnv(): Record<string, string> {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    // Use `env -0` (POSIX) or fall back to line-based `env` on macOS
    let raw: string;
    let separator: string;
    try {
      raw = execSync(`${shell} -ilc "env -0"`, {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env },
      });
      separator = '\0';
    } catch {
      // env -0 not supported — fall back to newline-separated (may break on multi-line values)
      raw = execSync(`${shell} -ilc env`, {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env },
      });
      separator = '\n';
    }

    const env: Record<string, string> = {};
    for (const entry of raw.split(separator)) {
      const idx = entry.indexOf('=');
      if (idx > 0) {
        env[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
    }
    return env;
  } catch (err) {
    console.error('[shell-env] Failed to load shell environment:', err);
    return {};
  }
}

/**
 * Merge shell env into process.env. Call once at startup.
 */
export function fixProcessEnv(): void {
  const shellEnv = loadShellEnv();
  // Only override PATH-related vars and keep Electron's own vars
  const keysToMerge = ['PATH', 'MANPATH', 'GOPATH', 'GOROOT', 'CARGO_HOME',
    'RUSTUP_HOME', 'NVM_DIR', 'PYENV_ROOT', 'VOLTA_HOME', 'BUN_INSTALL',
    'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY'];

  for (const key of keysToMerge) {
    if (shellEnv[key]) {
      process.env[key] = shellEnv[key];
    }
  }
}
