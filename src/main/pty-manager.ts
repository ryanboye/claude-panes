/**
 * PTY lifecycle manager. Spawns and manages Claude CLI processes.
 * Adapted from orchestrator/src/chat.ts TerminalSession interface.
 */

import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { buildClaudeArgs, type ContextSources } from './context-builder';

export interface PtySession {
  id: string;           // projectId:paneId
  paneId: string;
  projectId: string;
  pty: IPty;
  alive: boolean;
  outputBuffer: string[];  // raw chunk ring buffer for reattach (preserves ANSI)
  outputBufferBytes: number; // track total byte size
  spawnedAt: number;       // Date.now() at spawn time
  role: string;            // agent role (or 'default')
  onData?: (data: string) => void;
  onExit?: (code: number) => void;
}

// Cap buffer at ~2MB of raw output — enough for a full terminal session
// while preventing unbounded memory growth
const OUTPUT_BUFFER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Render a single terminal line into plain text by interpreting cursor movement.
 * Instead of stripping escape codes (which loses all spacing from cursor-positioned
 * content like tables), this builds a character buffer honoring cursor column moves.
 */
function stripAnsi(str: string): string {
  const chars: string[] = [];
  let col = 0;
  let i = 0;

  while (i < str.length) {
    const ch = str.charCodeAt(i);

    if (ch === 0x1b) { // ESC
      if (str[i + 1] === '[') {
        // CSI sequence — parse params + command
        let j = i + 2;
        let params = '';
        while (j < str.length && str.charCodeAt(j) >= 0x30 && str.charCodeAt(j) <= 0x3f) {
          params += str[j]; j++;
        }
        // Skip intermediate bytes (0x20-0x2F)
        while (j < str.length && str.charCodeAt(j) >= 0x20 && str.charCodeAt(j) <= 0x2f) j++;
        const cmd = j < str.length ? str[j] : '';
        j++;

        const cleanParams = params.replace(/^[\?>=]/, '');
        const n = parseInt(cleanParams) || 1;

        switch (cmd) {
          case 'C': col += n; break;                          // cursor forward
          case 'D': col = Math.max(0, col - n); break;       // cursor back
          case 'G': col = Math.max(0, n - 1); break;         // absolute column (1-based)
          case 'K':                                           // erase in line
            if (cleanParams === '' || cleanParams === '0') {
              chars.length = Math.min(chars.length, col);
            } else if (cleanParams === '2') {
              chars.length = 0; col = 0;
            }
            break;
          // All other CSI (colors, modes, cursor visibility, etc.): skip
        }
        i = j;
      } else if (str[i + 1] === ']') {
        // OSC sequence — skip to BEL or ST
        let j = i + 2;
        while (j < str.length && str[j] !== '\x07' && !(str[j] === '\x1b' && str[j + 1] === '\\')) j++;
        if (j < str.length && str[j] === '\x07') j++;
        else if (j + 1 < str.length && str[j] === '\x1b' && str[j + 1] === '\\') j += 2;
        i = j;
      } else if (str[i + 1] === '(' || str[i + 1] === ')' || str[i + 1] === '#') {
        i += 3; // charset / line attrs
      } else {
        i += 2; // ESC + single char
      }
    } else if (ch === 0x0d) { // \r — carriage return overwrites from col 0
      col = 0;
      i++;
    } else if (ch < 0x20 || ch === 0x7f) {
      i++; // skip other control chars
    } else {
      // Printable character — write at current column
      while (chars.length <= col) chars.push(' ');
      chars[col] = str[i];
      col++;
      i++;
    }
  }

  return chars.join('');
}

/** Filter out lines that are mostly box-drawing or decoration junk */
function isDecorationLine(line: string): boolean {
  if (line.length === 0) return false;
  let decorCount = 0;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    // U+2500-257F Box Drawing, U+2580-259F Block Elements, U+25A0-25FF Geometric Shapes
    if (code >= 0x2500 && code <= 0x25FF) decorCount++;
  }
  return decorCount / line.length > 0.5;
}

/** Filter out Claude CLI UI chrome lines that shouldn't appear in previews */
function isChromeLine(line: string): boolean {
  const l = line.toLowerCase();
  return l.includes('esc to interrupt')
    || l.includes('image in clipboard')
    || l.includes('ctrl+v to paste')
    || l.includes('? for shortcuts')
    || /^[›>]\s*$/.test(line.trim())
    // Thinking status lines (with optional leading spinner char)
    || /^.{0,2}\(thinking\b/i.test(line)
    // Very short lines that are spinner residue
    || (line.length <= 2 && !/\w{2}/.test(line));
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private shellEnv: Record<string, string> = {};
  private batchTimers = new Map<string, NodeJS.Timeout>();
  private batchBuffers = new Map<string, string>();

  setShellEnv(env: Record<string, string>): void {
    this.shellEnv = env;
  }

  private makeKey(projectId: string, paneId: string): string {
    return `${projectId}:${paneId}`;
  }

  spawn(opts: {
    paneId: string;
    projectId: string;
    cwd: string;
    cols: number;
    rows: number;
    role?: string;
    rawTerminal?: boolean;
    contextSources?: ContextSources;
  }): PtySession | undefined {
    const key = this.makeKey(opts.projectId, opts.paneId);

    // Kill existing session for this key
    this.kill(opts.projectId, opts.paneId);

    // Raw terminal: spawn user's shell; otherwise spawn Claude CLI
    const command = opts.rawTerminal
      ? (process.env.SHELL || '/bin/zsh')
      : 'claude';
    const args = opts.rawTerminal
      ? []
      : (opts.contextSources ? buildClaudeArgs(opts.contextSources) : []);

    try {
      const term = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: { ...process.env, ...this.shellEnv },
      });

      const session: PtySession = {
        id: key,
        paneId: opts.paneId,
        projectId: opts.projectId,
        pty: term,
        alive: true,
        outputBuffer: [],
        outputBufferBytes: 0,
        spawnedAt: Date.now(),
        role: opts.role ?? 'default',
      };

      // Wire output with 16ms batching to prevent IPC flood
      term.onData((data: string) => {
        // Store raw chunks (preserving ANSI escape codes intact)
        session.outputBuffer.push(data);
        session.outputBufferBytes += data.length;
        // Evict oldest chunks when over byte limit
        while (session.outputBufferBytes > OUTPUT_BUFFER_MAX_BYTES && session.outputBuffer.length > 1) {
          const removed = session.outputBuffer.shift()!;
          session.outputBufferBytes -= removed.length;
        }

        // Batch output
        const existing = this.batchBuffers.get(key) ?? '';
        this.batchBuffers.set(key, existing + data);

        if (!this.batchTimers.has(key)) {
          this.batchTimers.set(key, setTimeout(() => {
            const buffered = this.batchBuffers.get(key) ?? '';
            this.batchBuffers.delete(key);
            this.batchTimers.delete(key);
            session.onData?.(buffered);
          }, 16));
        }
      });

      term.onExit(({ exitCode }) => {
        session.alive = false;
        // Clear any pending batch
        const timer = this.batchTimers.get(key);
        if (timer) {
          clearTimeout(timer);
          this.batchTimers.delete(key);
          const remaining = this.batchBuffers.get(key);
          if (remaining) session.onData?.(remaining);
          this.batchBuffers.delete(key);
        }
        session.onExit?.(exitCode);
      });

      this.sessions.set(key, session);
      console.log(`[pty] Spawned ${key} (cwd: ${opts.cwd}, ${opts.cols}x${opts.rows})`);
      return session;
    } catch (err) {
      console.error(`[pty] Failed to spawn ${key}:`, err);
      return undefined;
    }
  }

  write(projectId: string, paneId: string, data: string): void {
    const session = this.sessions.get(this.makeKey(projectId, paneId));
    if (session?.alive) {
      session.pty.write(data);
    }
  }

  resize(projectId: string, paneId: string, cols: number, rows: number): void {
    const session = this.sessions.get(this.makeKey(projectId, paneId));
    if (session?.alive) {
      session.pty.resize(cols, rows);
    }
  }

  kill(projectId: string, paneId: string): void {
    const key = this.makeKey(projectId, paneId);
    const session = this.sessions.get(key);
    if (session?.alive) {
      session.pty.kill();
      session.alive = false;
    }
    this.sessions.delete(key);
    // Clean up batch state
    const timer = this.batchTimers.get(key);
    if (timer) clearTimeout(timer);
    this.batchTimers.delete(key);
    this.batchBuffers.delete(key);
  }

  getSession(projectId: string, paneId: string): PtySession | undefined {
    return this.sessions.get(this.makeKey(projectId, paneId));
  }

  getProjectSessions(projectId: string): PtySession[] {
    const result: PtySession[] = [];
    for (const [key, session] of this.sessions) {
      if (key.startsWith(projectId + ':')) {
        result.push(session);
      }
    }
    return result;
  }

  /**
   * Get buffered output for reattach after project switch.
   * Returns raw concatenated chunks with ANSI codes preserved.
   */
  getOutputBuffer(projectId: string, paneId: string): string {
    const session = this.sessions.get(this.makeKey(projectId, paneId));
    return session?.outputBuffer.join('') ?? '';
  }

  getAllSessions(): Map<string, PtySession> {
    return this.sessions;
  }

  getLastSnippet(key: string, lineCount: number = 5): string[] {
    const session = this.sessions.get(key);
    if (!session) return [];
    const recentChunks = session.outputBuffer.slice(-80).join('');
    const lines = recentChunks.split('\n')
      .map(l => stripAnsi(l).trim())
      .filter(l => l.length > 0 && !isDecorationLine(l) && !isChromeLine(l));
    // Deduplicate consecutive identical lines
    const deduped: string[] = [];
    for (const line of lines) {
      if (deduped.length === 0 || line !== deduped[deduped.length - 1]) {
        deduped.push(line);
      }
    }
    return deduped.slice(-lineCount).map(l => l.length > 120 ? l.slice(0, 119) + '\u2026' : l);
  }

  getLastOutputLine(key: string): string {
    const session = this.sessions.get(key);
    if (!session) return '';
    // Concatenate recent chunks and split by newline to find last non-empty line
    // Only check last few chunks to avoid processing the entire buffer
    const recentChunks = session.outputBuffer.slice(-20).join('');
    const lines = recentChunks.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = stripAnsi(lines[i]).trim();
      if (line.length > 0 && !isDecorationLine(line) && !isChromeLine(line)) return line;
    }
    return '';
  }

  killAll(): void {
    for (const [key, session] of this.sessions) {
      if (session.alive) {
        session.pty.kill();
        session.alive = false;
      }
      const timer = this.batchTimers.get(key);
      if (timer) clearTimeout(timer);
    }
    this.sessions.clear();
    this.batchTimers.clear();
    this.batchBuffers.clear();
  }

  killProject(projectId: string): void {
    for (const [key, session] of this.sessions) {
      if (key.startsWith(projectId + ':')) {
        if (session.alive) {
          session.pty.kill();
          session.alive = false;
        }
        this.sessions.delete(key);
        const timer = this.batchTimers.get(key);
        if (timer) clearTimeout(timer);
        this.batchTimers.delete(key);
        this.batchBuffers.delete(key);
      }
    }
  }
}
