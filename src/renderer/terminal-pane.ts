/**
 * xterm.js wrapper for pane leaf nodes.
 * Manages terminal lifecycle, IPC wiring, and resize observation.
 */

declare const api: import('../preload/index').ClaudePanesAPI;

import { getTerminalTheme, getCurrentThemeId } from './themes';

// xterm.js is loaded via script tags in index.html
declare const Terminal: any;
declare const FitAddon: any;

export interface TerminalPane {
  paneId: string;
  term: any; // Terminal instance
  fitAddon: any; // FitAddon instance
  resizeObserver: ResizeObserver;
  dispose: () => void;
}

const terminals = new Map<string, TerminalPane>();
let resizeDebounceTimers = new Map<string, number>();

// Snapshots of terminal screen content saved at detach time
const detachedSnapshots = new Map<string, string>();

/**
 * Wait until a container has non-zero layout dimensions.
 * Polls via requestAnimationFrame with a safety timeout.
 */
function waitForLayout(container: HTMLElement, timeoutMs = 500): Promise<void> {
  return new Promise((resolve) => {
    function check() {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        resolve();
        return;
      }
      requestAnimationFrame(check);
    }
    // Safety: resolve after timeout even if layout never settles
    setTimeout(resolve, timeoutMs);
    requestAnimationFrame(check);
  });
}

export function createTerminalPane(
  paneId: string,
  container: HTMLElement,
  projectId: string,
  projectPath: string,
  role?: string,
  rawTerminal?: boolean,
): TerminalPane {
  // Dispose existing if any
  disposeTerminalPane(paneId);

  const term = new Terminal({
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.2,
    theme: getTerminalTheme(getCurrentThemeId()),
    allowProposedApi: true,
    scrollback: 10000,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  // Wait for container to have layout dimensions, then fit and spawn PTY
  waitForLayout(container).then(() => {
    fitAddon.fit();
    const { cols, rows } = term;
    api.pty.spawn({ paneId, projectId, cwd: projectPath, cols: cols || 80, rows: rows || 24, role, rawTerminal });
  });

  // Input → PTY
  term.onData((data: string) => {
    api.pty.write(paneId, projectId, data);
  });

  // Suppress resize observer during initial layout to avoid competing fit() calls
  let suppressResize = true;
  waitForLayout(container).then(() => { suppressResize = false; });

  // Resize observer with debounce
  const resizeObserver = new ResizeObserver(() => {
    if (suppressResize) return;
    const existing = resizeDebounceTimers.get(paneId);
    if (existing) clearTimeout(existing);
    resizeDebounceTimers.set(paneId, window.setTimeout(() => {
      resizeDebounceTimers.delete(paneId);
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fitAddon.fit();
        api.pty.resize(paneId, projectId, term.cols, term.rows);
      }
    }, 16) as unknown as number);
  });
  resizeObserver.observe(container);

  const pane: TerminalPane = {
    paneId,
    term,
    fitAddon,
    resizeObserver,
    dispose: () => {
      resizeObserver.disconnect();
      const timer = resizeDebounceTimers.get(paneId);
      if (timer) clearTimeout(timer);
      resizeDebounceTimers.delete(paneId);
      term.dispose();
      api.pty.kill(paneId, projectId);
    },
  };

  terminals.set(paneId, pane);
  return pane;
}

export function disposeTerminalPane(paneId: string): void {
  const existing = terminals.get(paneId);
  if (existing) {
    existing.dispose();
    terminals.delete(paneId);
  }
}

export function getTerminalPane(paneId: string): TerminalPane | undefined {
  return terminals.get(paneId);
}

export function writeToTerminal(paneId: string, data: string): void {
  const pane = terminals.get(paneId);
  pane?.term.write(data);
}

export function focusTerminal(paneId: string): void {
  const pane = terminals.get(paneId);
  pane?.term.focus();
}

export function fitAllTerminals(): void {
  for (const pane of terminals.values()) {
    pane.fitAddon.fit();
    // Force full repaint to fix cursor position and rendering artifacts
    pane.term.refresh(0, pane.term.rows - 1);
    // Scroll to bottom so the viewport isn't stranded mid-buffer
    pane.term.scrollToBottom();
  }
}

export function disposeAllTerminals(): void {
  for (const [id, pane] of terminals) {
    pane.dispose();
  }
  terminals.clear();
}

/**
 * Detach terminal UI without killing the PTY backend.
 * Captures terminal screen content before disposing so reattach
 * can restore a clean view instead of replaying raw PTY output.
 */
export function detachTerminalPane(paneId: string): void {
  const existing = terminals.get(paneId);
  if (existing) {
    // Capture screen content from xterm buffer before disposing
    const snapshot = extractTerminalContent(existing.term);
    detachedSnapshots.set(paneId, snapshot);

    existing.resizeObserver.disconnect();
    const timer = resizeDebounceTimers.get(paneId);
    if (timer) clearTimeout(timer);
    resizeDebounceTimers.delete(paneId);
    existing.term.dispose();
    // Do NOT call api.pty.kill — PTY keeps running
    terminals.delete(paneId);
  }
}

/**
 * Extract readable text content from an xterm Terminal's buffer.
 * Walks the active buffer from scrollback through viewport, producing
 * clean text that can be written to a new terminal without garbling.
 */
function extractTerminalContent(term: any): string {
  const buffer = term.buffer?.active;
  if (!buffer) return '';

  const lines: string[] = [];
  const totalRows = buffer.length;

  // Walk all lines in the buffer (scrollback + viewport)
  for (let i = 0; i < totalRows; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    lines.push(line.translateToString(true));
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return lines.join('\r\n') + '\r\n';
}

export function detachAllTerminals(): void {
  for (const [id] of terminals) {
    detachTerminalPane(id);
  }
}

/**
 * Reattach a terminal to a new container (for project switching).
 * Fetches the raw output buffer from the main process (preserves ANSI
 * colors) instead of using stripped text snapshots.
 */
export async function reattachTerminal(
  paneId: string,
  container: HTMLElement,
  projectId: string,
  projectPath: string,
  role?: string,
  rawTerminal?: boolean,
): Promise<TerminalPane> {
  // Check if PTY is still alive
  const alive = await api.pty.isAlive(paneId, projectId);

  if (alive) {
    // Discard the local plain-text snapshot — use main process buffer instead
    // which preserves ANSI escape codes (colors, cursor positioning, etc.)
    detachedSnapshots.delete(paneId);
    const buffer = await api.pty.getBuffer(paneId, projectId);

    const pane = createTerminalPaneWithoutSpawn(paneId, container, projectId, buffer || undefined);
    return pane;
  }

  // PTY died — create fresh
  detachedSnapshots.delete(paneId);
  return createTerminalPane(paneId, container, projectId, projectPath, role, rawTerminal);
}

export function updateAllTerminalThemes(themeId: string): void {
  const theme = getTerminalTheme(themeId);
  for (const pane of terminals.values()) {
    pane.term.options.theme = theme;
  }
}

function createTerminalPaneWithoutSpawn(
  paneId: string,
  container: HTMLElement,
  projectId: string,
  bufferContent?: string,
): TerminalPane {
  disposeTerminalPane(paneId);

  const term = new Terminal({
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.2,
    theme: getTerminalTheme(getCurrentThemeId()),
    allowProposedApi: true,
    scrollback: 10000,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  // Wait for container layout, then fit, resize PTY, and replay buffer content
  waitForLayout(container).then(() => {
    fitAddon.fit();
    api.pty.resize(paneId, projectId, term.cols || 80, term.rows || 24);
    if (bufferContent) {
      term.write(bufferContent, () => {
        term.scrollToBottom();
      });
    }
  });

  term.onData((data: string) => {
    api.pty.write(paneId, projectId, data);
  });

  // Suppress resize observer during initial layout to avoid competing fit() calls
  let suppressResize = true;
  waitForLayout(container).then(() => { suppressResize = false; });

  const resizeObserver = new ResizeObserver(() => {
    if (suppressResize) return;
    const existing = resizeDebounceTimers.get(paneId);
    if (existing) clearTimeout(existing);
    resizeDebounceTimers.set(paneId, window.setTimeout(() => {
      resizeDebounceTimers.delete(paneId);
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fitAddon.fit();
        api.pty.resize(paneId, projectId, term.cols, term.rows);
      }
    }, 16) as unknown as number);
  });
  resizeObserver.observe(container);

  const pane: TerminalPane = {
    paneId,
    term,
    fitAddon,
    resizeObserver,
    dispose: () => {
      resizeObserver.disconnect();
      term.dispose();
    },
  };

  terminals.set(paneId, pane);
  return pane;
}
