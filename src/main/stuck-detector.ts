/**
 * Stuck detection: watches PTY output for phrases indicating an agent is stuck.
 * Ported from orchestrator/src/agent-runner.ts phrase matching.
 */

const STUCK_PHRASES = [
  'i am stuck',
  "i'm stuck",
  'i got stuck',
  'cannot proceed',
  'unable to proceed',
  'need help from',
  'i need assistance',
  'blocked on',
  'waiting for input',
  'cannot continue',
  'unable to continue',
];

export interface StuckEvent {
  paneId: string;
  phrase: string;
  timestamp: string;
  context: string; // surrounding text
}

export class StuckDetector {
  private recentOutput = new Map<string, string>(); // paneId → last N chars
  private stuckPanes = new Set<string>();
  private onStuck?: (event: StuckEvent) => void;
  private readonly BUFFER_SIZE = 2000;

  constructor(onStuck?: (event: StuckEvent) => void) {
    this.onStuck = onStuck;
  }

  /**
   * Feed PTY output through the detector.
   * Returns true if stuck was detected in this chunk.
   */
  feed(paneId: string, data: string): boolean {
    // Append to buffer, trim to size
    const existing = this.recentOutput.get(paneId) ?? '';
    const combined = existing + data;
    this.recentOutput.set(paneId, combined.slice(-this.BUFFER_SIZE));

    // Strip ANSI codes for matching
    const clean = stripAnsi(data.toLowerCase());

    for (const phrase of STUCK_PHRASES) {
      if (clean.includes(phrase)) {
        // Don't fire repeatedly for the same pane
        if (this.stuckPanes.has(paneId)) return false;

        this.stuckPanes.add(paneId);
        const event: StuckEvent = {
          paneId,
          phrase,
          timestamp: new Date().toISOString(),
          context: clean.slice(Math.max(0, clean.indexOf(phrase) - 100), clean.indexOf(phrase) + phrase.length + 100),
        };
        this.onStuck?.(event);
        return true;
      }
    }
    return false;
  }

  isStuck(paneId: string): boolean {
    return this.stuckPanes.has(paneId);
  }

  clearStuck(paneId: string): void {
    this.stuckPanes.delete(paneId);
  }

  getStuckPanes(): Set<string> {
    return new Set(this.stuckPanes);
  }

  getStuckContext(paneId: string): string | null {
    if (!this.stuckPanes.has(paneId)) return null;
    const buffer = this.recentOutput.get(paneId) ?? '';
    const clean = stripAnsi(buffer.toLowerCase());
    for (const phrase of STUCK_PHRASES) {
      const idx = clean.lastIndexOf(phrase);
      if (idx !== -1) {
        return clean.slice(Math.max(0, idx - 100), idx + phrase.length + 100).trim();
      }
    }
    return 'Agent is stuck';
  }

  removePaneBuffer(paneId: string): void {
    this.recentOutput.delete(paneId);
    this.stuckPanes.delete(paneId);
  }
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
