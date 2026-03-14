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
  outputBuffer: string[];  // ring buffer for reattach
  spawnedAt: number;       // Date.now() at spawn time
  role: string;            // agent role (or 'default')
  onData?: (data: string) => void;
  onExit?: (code: number) => void;
}

const OUTPUT_BUFFER_MAX_LINES = 10000;

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
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
        spawnedAt: Date.now(),
        role: opts.role ?? 'default',
      };

      // Wire output with 16ms batching to prevent IPC flood
      term.onData((data: string) => {
        // Add to ring buffer
        const lines = data.split('\n');
        session.outputBuffer.push(...lines);
        if (session.outputBuffer.length > OUTPUT_BUFFER_MAX_LINES) {
          session.outputBuffer.splice(0, session.outputBuffer.length - OUTPUT_BUFFER_MAX_LINES);
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
   */
  getOutputBuffer(projectId: string, paneId: string): string {
    const session = this.sessions.get(this.makeKey(projectId, paneId));
    return session?.outputBuffer.join('\n') ?? '';
  }

  getAllSessions(): Map<string, PtySession> {
    return this.sessions;
  }

  getLastOutputLine(key: string): string {
    const session = this.sessions.get(key);
    if (!session) return '';
    // Walk buffer backwards to find last non-empty line
    for (let i = session.outputBuffer.length - 1; i >= 0; i--) {
      const line = stripAnsi(session.outputBuffer[i]).trim();
      if (line.length > 0) return line;
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
