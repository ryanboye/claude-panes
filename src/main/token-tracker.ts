/**
 * Per-pane token tracking. Parses Claude CLI output for token data
 * and computes burn rate stats over a rolling 5-minute window.
 */

export type ActivityType = 'reading' | 'editing' | 'thinking' | 'idle';

export interface TokenSample {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  activity: ActivityType;
}

export interface TokenSnapshot {
  paneId: string;
  projectId: string;
  currentTokPerSec: number;
  avgTokPerSec: number;
  peakTokPerSec: number;
  totalTokens: number;
  elapsed: number; // seconds since first sample
  activity: ActivityType;
  /** 2-sec bucket rates for histogram (most recent 120 entries = 4 min) */
  histogram: number[];
  /** Activity timeline segments matching histogram buckets */
  activityTimeline: ActivityType[];
}

interface PaneTokenData {
  paneId: string;
  projectId: string;
  samples: TokenSample[];
  cumulativeInput: number;
  cumulativeOutput: number;
  firstSeen: number;
  lastEmit: number;
  pendingBytes: number;
  lastActivity: ActivityType;
}

// Strip ANSI escape sequences
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

export class TokenTracker {
  private paneData = new Map<string, PaneTokenData>();
  private onUpdate?: (paneId: string, snapshot: TokenSnapshot) => void;

  private static readonly MAX_SAMPLES = 300; // 5 min at 1/sec
  private static readonly EMIT_INTERVAL_MS = 1000;

  constructor(onUpdate?: (paneId: string, snapshot: TokenSnapshot) => void) {
    this.onUpdate = onUpdate;
  }

  parseOutput(paneId: string, projectId: string, data: string): void {
    const now = Date.now();
    let pd = this.paneData.get(paneId);
    if (!pd) {
      pd = {
        paneId,
        projectId,
        samples: [],
        cumulativeInput: 0,
        cumulativeOutput: 0,
        firstSeen: now,
        lastEmit: 0,
        pendingBytes: 0,
        lastActivity: 'idle',
      };
      this.paneData.set(paneId, pd);
    }

    let inputDelta = 0;
    let outputDelta = 0;
    let matched = false;

    // Pattern 1: JSON input_tokens / output_tokens
    const inputMatch = data.match(/"input_tokens"\s*:\s*(\d+)/);
    const outputMatch = data.match(/"output_tokens"\s*:\s*(\d+)/);
    if (inputMatch) {
      const val = parseInt(inputMatch[1], 10);
      if (val > pd.cumulativeInput) {
        inputDelta = val - pd.cumulativeInput;
        pd.cumulativeInput = val;
        matched = true;
      }
    }
    if (outputMatch) {
      const val = parseInt(outputMatch[1], 10);
      if (val > pd.cumulativeOutput) {
        outputDelta = val - pd.cumulativeOutput;
        pd.cumulativeOutput = val;
        matched = true;
      }
    }

    // Pattern 2: "NNN tokens" in plain text
    if (!matched) {
      const textMatch = data.match(/(\d[\d,]*)\s*tokens?/i);
      if (textMatch) {
        const val = parseInt(textMatch[1].replace(/,/g, ''), 10);
        const total = pd.cumulativeInput + pd.cumulativeOutput;
        if (val > total) {
          outputDelta = val - total;
          pd.cumulativeOutput += outputDelta;
          matched = true;
        }
      }
    }

    // Pattern 3: ANSI status bar with token info
    if (!matched) {
      const clean = stripAnsi(data);
      const tokMatch = clean.match(/(\d[\d,]*)\s*(?:tok|tkn)/i);
      if (tokMatch) {
        const val = parseInt(tokMatch[1].replace(/,/g, ''), 10);
        const total = pd.cumulativeInput + pd.cumulativeOutput;
        if (val > total) {
          outputDelta = val - total;
          pd.cumulativeOutput += outputDelta;
          matched = true;
        }
      }
    }

    // Fallback: estimate tokens from output byte count (~4 chars/token)
    if (!matched) {
      pd.pendingBytes += data.length;
      if (pd.pendingBytes >= 40) {
        outputDelta = Math.floor(pd.pendingBytes / 4);
        pd.cumulativeOutput += outputDelta;
        pd.pendingBytes = pd.pendingBytes % 4;
      }
    } else {
      pd.pendingBytes = 0;
    }

    // Detect activity type
    const clean = stripAnsi(data);
    pd.lastActivity = this.detectActivity(clean, pd.lastActivity);

    // Record sample
    const totalTokens = inputDelta + outputDelta;
    if (totalTokens > 0 || pd.samples.length === 0) {
      pd.samples.push({
        timestamp: now,
        inputTokens: inputDelta,
        outputTokens: outputDelta,
        totalTokens,
        activity: pd.lastActivity,
      });

      // Trim to rolling window
      while (pd.samples.length > TokenTracker.MAX_SAMPLES) {
        pd.samples.shift();
      }
    }

    // Throttle emission to 1/sec per pane
    if (now - pd.lastEmit >= TokenTracker.EMIT_INTERVAL_MS) {
      pd.lastEmit = now;
      this.emitSnapshot(pd);
    }
  }

  private detectActivity(text: string, current: ActivityType): ActivityType {
    const lower = text.toLowerCase();
    if (/\b(read|reading|search|grep|glob|find)\b/.test(lower)) return 'reading';
    if (/\b(edit|write|writing|create|insert|replace|delete)\b/.test(lower)) return 'editing';
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|thinking|\.{3,}|\bwait/.test(lower)) return 'thinking';
    if (text.trim().length === 0) return 'idle';
    return current;
  }

  private emitSnapshot(pd: PaneTokenData): void {
    if (!this.onUpdate) return;

    const now = Date.now();
    const windowMs = 5 * 60 * 1000;
    const cutoff = now - windowMs;
    const recent = pd.samples.filter(s => s.timestamp >= cutoff);

    // Current rate: tokens in last 3 seconds
    const last3s = recent.filter(s => s.timestamp >= now - 3000);
    const tokensLast3s = last3s.reduce((sum, s) => sum + s.totalTokens, 0);
    const currentTokPerSec = last3s.length > 0 ? tokensLast3s / 3 : 0;

    // Average rate over the window
    const totalTokensInWindow = recent.reduce((sum, s) => sum + s.totalTokens, 0);
    const windowSec = recent.length > 1
      ? (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000
      : 1;
    const avgTokPerSec = windowSec > 0 ? totalTokensInWindow / windowSec : 0;

    // Build histogram: 2-sec buckets
    const bucketMs = 2000;
    const maxBuckets = 120; // 4 min
    const histogram: number[] = [];
    const activityTimeline: ActivityType[] = [];

    for (let i = 0; i < maxBuckets; i++) {
      const bucketStart = now - (maxBuckets - i) * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      const inBucket = recent.filter(s => s.timestamp >= bucketStart && s.timestamp < bucketEnd);
      const tokInBucket = inBucket.reduce((sum, s) => sum + s.totalTokens, 0);
      histogram.push(tokInBucket / (bucketMs / 1000)); // rate per second

      // Activity for this bucket: most recent sample in bucket, or idle
      const lastInBucket = inBucket.length > 0 ? inBucket[inBucket.length - 1].activity : 'idle';
      activityTimeline.push(lastInBucket);
    }

    // Peak rate from histogram
    const peakTokPerSec = Math.max(0, ...histogram);

    const totalTokens = pd.cumulativeInput + pd.cumulativeOutput;
    const elapsed = (now - pd.firstSeen) / 1000;

    this.onUpdate(pd.paneId, {
      paneId: pd.paneId,
      projectId: pd.projectId,
      currentTokPerSec: Math.round(currentTokPerSec * 10) / 10,
      avgTokPerSec: Math.round(avgTokPerSec * 10) / 10,
      peakTokPerSec: Math.round(peakTokPerSec * 10) / 10,
      totalTokens,
      elapsed: Math.round(elapsed),
      activity: pd.lastActivity,
      histogram,
      activityTimeline,
    });
  }

  getSnapshot(paneId: string): TokenSnapshot | null {
    const pd = this.paneData.get(paneId);
    if (!pd) return null;
    // Force an emit calculation
    const now = Date.now();
    const windowMs = 5 * 60 * 1000;
    const cutoff = now - windowMs;
    const recent = pd.samples.filter(s => s.timestamp >= cutoff);

    const last3s = recent.filter(s => s.timestamp >= now - 3000);
    const tokensLast3s = last3s.reduce((sum, s) => sum + s.totalTokens, 0);
    const currentTokPerSec = last3s.length > 0 ? tokensLast3s / 3 : 0;

    const totalTokensInWindow = recent.reduce((sum, s) => sum + s.totalTokens, 0);
    const windowSec = recent.length > 1
      ? (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000
      : 1;
    const avgTokPerSec = windowSec > 0 ? totalTokensInWindow / windowSec : 0;

    const bucketMs = 2000;
    const maxBuckets = 120;
    const histogram: number[] = [];
    const activityTimeline: ActivityType[] = [];

    for (let i = 0; i < maxBuckets; i++) {
      const bucketStart = now - (maxBuckets - i) * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      const inBucket = recent.filter(s => s.timestamp >= bucketStart && s.timestamp < bucketEnd);
      const tokInBucket = inBucket.reduce((sum, s) => sum + s.totalTokens, 0);
      histogram.push(tokInBucket / (bucketMs / 1000));
      const lastInBucket = inBucket.length > 0 ? inBucket[inBucket.length - 1].activity : 'idle';
      activityTimeline.push(lastInBucket);
    }

    const peakTokPerSec = Math.max(0, ...histogram);
    const totalTokens = pd.cumulativeInput + pd.cumulativeOutput;
    const elapsed = (now - pd.firstSeen) / 1000;

    return {
      paneId: pd.paneId,
      projectId: pd.projectId,
      currentTokPerSec: Math.round(currentTokPerSec * 10) / 10,
      avgTokPerSec: Math.round(avgTokPerSec * 10) / 10,
      peakTokPerSec: Math.round(peakTokPerSec * 10) / 10,
      totalTokens,
      elapsed: Math.round(elapsed),
      activity: pd.lastActivity,
      histogram,
      activityTimeline,
    };
  }

  /**
   * Returns true if the pane has consumed tokens in the last N seconds.
   * Use this to distinguish "actively working" from "alive but idle".
   */
  isActivelyBurning(paneId: string, withinMs = 10_000): boolean {
    const pd = this.paneData.get(paneId);
    if (!pd || pd.samples.length === 0) return false;
    const cutoff = Date.now() - withinMs;
    return pd.samples.some(s => s.timestamp >= cutoff && s.totalTokens > 0);
  }

  getPaneTotal(paneId: string): number {
    const pd = this.paneData.get(paneId);
    return pd ? pd.cumulativeInput + pd.cumulativeOutput : 0;
  }

  removePaneData(paneId: string): void {
    this.paneData.delete(paneId);
  }
}
