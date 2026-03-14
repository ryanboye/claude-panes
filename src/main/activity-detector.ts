/**
 * Activity detection: watches PTY output for meaningful agent actions.
 * Uses phase-based summarization to reduce noise — only emits on phase
 * transitions and high-signal events (errors, test results, completions).
 */

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────

export type NotificationSeverity = 'critical' | 'warn' | 'info' | 'success';

export interface ActivityEvent {
  id: string;
  paneId: string;
  projectId: string;
  role: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  detail?: string;
  timestamp: string;
  acked: boolean;
  snoozedUntil?: string;
}

// ─── Detection Rules ────────────────────────────────────────────

interface DetectionRule {
  pattern: RegExp;
  type: string;
  severity: NotificationSeverity;
  titleExtractor: (match: RegExpMatchArray) => string;
  detailExtractor?: (match: RegExpMatchArray) => string;
}

// Immediate-emit rules: high-signal events that always fire
const IMMEDIATE_RULES: DetectionRule[] = [
  // Errors — highest priority
  {
    pattern: /(?:Error|ERROR|FAIL(?:ED)?|error)\s*[:—]\s*(.{1,80})/,
    type: 'error',
    severity: 'critical',
    titleExtractor: (m) => truncate(`error: ${m[1].trim()}`, 80),
  },
  // Tests passing
  {
    pattern: /(?:tests?\s+pass(?:ing|ed)?|all\s+\d+\s+tests?\s+pass(?:ed)?)/i,
    type: 'tests_pass',
    severity: 'success',
    titleExtractor: () => 'tests passing',
  },
  // Tests failing
  {
    pattern: /(?:\d+\s+tests?\s+fail(?:ed|ing)?|test\s+suite\s+fail)/i,
    type: 'tests_fail',
    severity: 'critical',
    titleExtractor: () => 'tests failing',
  },
  // Warnings
  {
    pattern: /(?:WARN(?:ING)?|warning)\s*[:—]\s*(.{1,80})/i,
    type: 'warning',
    severity: 'warn',
    titleExtractor: (m) => truncate(`warning: ${m[1].trim()}`, 80),
  },
  // Task/step completion markers
  {
    pattern: /(?:✓|✔|Done|Completed|Finished)\s+(.{1,80})/,
    type: 'completion',
    severity: 'success',
    titleExtractor: (m) => truncate(m[1].trim(), 80),
  },
];

// ─── Phase Detection ────────────────────────────────────────────

type Phase = 'researching' | 'editing' | 'running_commands' | 'testing' | 'deploying';

interface PhaseRule {
  pattern: RegExp;
  phase: Phase;
}

const PHASE_RULES: PhaseRule[] = [
  // Testing (check before generic command_run to catch test commands)
  { pattern: /(?:test|jest|vitest|pytest|mocha|karma)/i, phase: 'testing' },
  // Deploying
  { pattern: /(?:git\s+(?:push|merge)|npm\s+publish)/i, phase: 'deploying' },
  // Researching
  { pattern: /(?:Read(?:ing)?)\s+(?:file\s+)?['"]?(\S{1,120})/i, phase: 'researching' },
  { pattern: /(?:Grep(?:ping)?|Glob(?:bing)?|Search(?:ing)?)\s*\(?['"`]?([^\s'"`)\]]{1,40})/i, phase: 'researching' },
  // Editing
  { pattern: /(?:Edit(?:ing)?|Writ(?:e|ing|ten)|Wrote)\s+(?:file\s+)?['"]?(\S{1,120})/i, phase: 'editing' },
  // Running commands (generic — checked after testing/deploying)
  { pattern: /(?:Bash|Running|Executing)\s*\(?['"`]?([^\s'"`)\]]{1,60})/i, phase: 'running_commands' },
  // Package install / git ops → deploying
  { pattern: /(?:npm|pnpm|yarn|bun)\s+(?:install|add|i\b)/i, phase: 'deploying' },
  { pattern: /(?:git\s+(?:commit|rebase|pull))\s*(.*)/i, phase: 'deploying' },
  // PR activity → deploying
  { pattern: /PR\s*#(\d+)\s*(.*)/i, phase: 'deploying' },
];

const PHASE_TITLES: Record<Phase, string> = {
  researching: 'agent is researching',
  editing: 'agent is editing files',
  running_commands: 'agent is running commands',
  testing: 'agent is running tests',
  deploying: 'agent is deploying',
};

// ─── Helpers ────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ─── Dedup State ────────────────────────────────────────────────

interface DedupeEntry {
  type: string;
  title: string;
  ts: number;
}

// ─── Phase State (per pane) ─────────────────────────────────────

interface PanePhaseState {
  currentPhase: Phase | null;
  phaseStartedAt: number;
}

// ─── ActivityDetector Class ─────────────────────────────────────

export class ActivityDetector {
  private onEvent: (event: ActivityEvent) => void;
  private dedup = new Map<string, DedupeEntry[]>(); // paneId → recent events
  private lastEmit = new Map<string, number>();       // paneId → last emit timestamp
  private phaseState = new Map<string, PanePhaseState>(); // paneId → phase state

  private readonly DEDUP_WINDOW_MS = 30000;
  private readonly IMMEDIATE_THROTTLE_MS = 500;
  private readonly PHASE_THROTTLE_MS = 3000;
  private readonly MAX_DEDUP_ENTRIES = 10;

  constructor(onEvent: (event: ActivityEvent) => void) {
    this.onEvent = onEvent;
  }

  /**
   * Feed PTY output through the activity detector.
   * Strips ANSI, runs immediate rules first, then phase detection.
   */
  feed(paneId: string, projectId: string, role: string, data: string): void {
    const clean = stripAnsi(data);
    // Skip very short output (likely cursor moves, prompts)
    if (clean.trim().length < 4) return;

    const now = Date.now();

    // 1. Run immediate rules first (errors, test results, completions)
    //    These use a shorter throttle and always emit
    const lastEmit = this.lastEmit.get(paneId) ?? 0;

    for (const rule of IMMEDIATE_RULES) {
      const match = clean.match(rule.pattern);
      if (!match) continue;

      // Throttle immediate rules at 500ms
      if (now - lastEmit < this.IMMEDIATE_THROTTLE_MS) return;

      // Dedup check
      if (this.isDuplicate(paneId, rule.type, rule.titleExtractor(match), now)) {
        return;
      }

      const event: ActivityEvent = {
        id: randomUUID(),
        paneId,
        projectId,
        role,
        type: rule.type,
        severity: rule.severity,
        title: rule.titleExtractor(match),
        detail: rule.detailExtractor?.(match),
        timestamp: new Date(now).toISOString(),
        acked: false,
      };

      this.recordDedup(paneId, rule.type, event.title, now);
      this.lastEmit.set(paneId, now);
      this.onEvent(event);
      return; // First match wins
    }

    // 2. Run phase rules — determine target phase
    for (const rule of PHASE_RULES) {
      const match = clean.match(rule.pattern);
      if (!match) continue;

      const targetPhase = rule.phase;
      const state = this.phaseState.get(paneId) ?? { currentPhase: null, phaseStartedAt: 0 };

      // If same phase, suppress (this is the noise reduction)
      if (targetPhase === state.currentPhase) return;

      // Phase change — throttle at 3s
      if (now - lastEmit < this.PHASE_THROTTLE_MS) return;

      const title = PHASE_TITLES[targetPhase];

      // Dedup check
      if (this.isDuplicate(paneId, 'phase_change', title, now)) {
        return;
      }

      // Update phase state
      this.phaseState.set(paneId, { currentPhase: targetPhase, phaseStartedAt: now });

      const event: ActivityEvent = {
        id: randomUUID(),
        paneId,
        projectId,
        role,
        type: 'phase_change',
        severity: 'info',
        title,
        timestamp: new Date(now).toISOString(),
        acked: false,
      };

      this.recordDedup(paneId, 'phase_change', title, now);
      this.lastEmit.set(paneId, now);
      this.onEvent(event);
      return; // First match wins
    }
  }

  private isDuplicate(paneId: string, type: string, title: string, now: number): boolean {
    const entries = this.dedup.get(paneId);
    if (!entries) return false;

    return entries.some(
      (e) => e.type === type && e.title === title && now - e.ts < this.DEDUP_WINDOW_MS,
    );
  }

  private recordDedup(paneId: string, type: string, title: string, now: number): void {
    let entries = this.dedup.get(paneId);
    if (!entries) {
      entries = [];
      this.dedup.set(paneId, entries);
    }

    entries.push({ type, title, ts: now });

    // Trim old entries
    const cutoff = now - this.DEDUP_WINDOW_MS;
    while (entries.length > 0 && entries[0].ts < cutoff) {
      entries.shift();
    }
    // Cap size
    if (entries.length > this.MAX_DEDUP_ENTRIES) {
      entries.splice(0, entries.length - this.MAX_DEDUP_ENTRIES);
    }
  }

  /**
   * Clean up dedup and phase state for a pane.
   */
  removePaneState(paneId: string): void {
    this.dedup.delete(paneId);
    this.lastEmit.delete(paneId);
    this.phaseState.delete(paneId);
  }
}
