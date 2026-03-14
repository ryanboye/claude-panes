/**
 * Token Burn Rate Panel — popup histogram + activity timeline.
 * Toggled by clicking the token stats in the status bar.
 */

declare const api: import('../preload/index').ClaudePanesAPI;

interface TokenSnapshot {
  paneId: string;
  projectId: string;
  currentTokPerSec: number;
  avgTokPerSec: number;
  peakTokPerSec: number;
  totalTokens: number;
  elapsed: number;
  activity: string;
  histogram: number[];
  activityTimeline: string[];
}

// ─── State ────────────────────────────────────────────────────

let popupEl: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let activePaneId: string | null = null;
let latestSnapshot: TokenSnapshot | null = null;
let popupVisible = false;
let needsRedraw = false;
let resizeObserver: ResizeObserver | null = null;

// ─── Colors ───────────────────────────────────────────────────

const COLORS = {
  barNormal: '#4ade80',
  barHigh: '#fbbf24',
  barPeak: '#ff6b6b',
  reading: '#60a5fa',
  editing: '#fbbf24',
  thinking: '#c084fc',
  idle: '#2a2a4a',
};

// ─── Init ─────────────────────────────────────────────────────

export function initBurnRatePanel(): void {
  // Create drawer (hidden by default), inserted into #app before status bar
  popupEl = document.createElement('div');
  popupEl.id = 'burn-rate-drawer';
  popupEl.className = 'burn-rate-drawer';

  // Stats row
  const statsRow = document.createElement('div');
  statsRow.className = 'burn-rate-stats';
  statsRow.id = 'burn-rate-stats';
  popupEl.appendChild(statsRow);

  // Canvas container
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'burn-rate-canvas-wrap';

  canvas = document.createElement('canvas');
  canvas.className = 'burn-rate-canvas';
  canvas.height = 48;
  canvasWrap.appendChild(canvas);

  ctx = canvas.getContext('2d');
  popupEl.appendChild(canvasWrap);

  // Time axis
  const timeAxis = document.createElement('div');
  timeAxis.className = 'burn-rate-time-axis';
  timeAxis.innerHTML = '<span>4m ago</span><span>now</span>';
  popupEl.appendChild(timeAxis);

  // Activity timeline
  const activityRow = document.createElement('div');
  activityRow.className = 'burn-rate-activity';
  activityRow.id = 'burn-rate-activity';
  popupEl.appendChild(activityRow);

  // Insert into #app layout, just before the status bar
  const statusBar = document.getElementById('status-bar');
  const app = document.getElementById('app');
  if (app && statusBar) {
    app.insertBefore(popupEl, statusBar);
  } else {
    document.body.appendChild(popupEl);
  }

  // ResizeObserver for canvas width
  resizeObserver = new ResizeObserver(() => {
    if (canvas && canvasWrap) {
      const w = canvasWrap.clientWidth;
      if (w > 0 && canvas.width !== w * window.devicePixelRatio) {
        canvas.width = w * window.devicePixelRatio;
        canvas.style.width = `${w}px`;
        needsRedraw = true;
      }
    }
  });
  resizeObserver.observe(canvasWrap);

  // Render loop
  requestAnimationFrame(renderLoop);
}

// ─── Public API ───────────────────────────────────────────────

export function setBurnRatePaneId(paneId: string | null): void {
  activePaneId = paneId;
  if (!paneId) {
    latestSnapshot = null;
  }
  needsRedraw = true;
}

export function updateBurnRate(paneId: string, snapshot: TokenSnapshot): void {
  if (paneId !== activePaneId) return;
  latestSnapshot = snapshot;
  needsRedraw = true;
}

export function toggleBurnRatePopup(): void {
  popupVisible = !popupVisible;
  if (popupEl) {
    popupEl.classList.toggle('open', popupVisible);
  }
  if (popupVisible) {
    needsRedraw = true;
  }
}

// ─── Render Loop ──────────────────────────────────────────────

function renderLoop(): void {
  if (needsRedraw && popupVisible) {
    needsRedraw = false;
    drawHistogram();
    drawActivityTimeline();
    updateStatsRow();
  }
  requestAnimationFrame(renderLoop);
}

function updateStatsRow(): void {
  const el = document.getElementById('burn-rate-stats');
  if (!el) return;
  if (!latestSnapshot) {
    el.textContent = 'No data yet';
    return;
  }
  const s = latestSnapshot;
  el.innerHTML = `
    <span>${s.currentTokPerSec} tok/s</span>
    <span class="burn-rate-stat-sep">&middot;</span>
    <span>avg ${s.avgTokPerSec} tok/s</span>
    <span class="burn-rate-stat-sep">&middot;</span>
    <span>peak ${s.peakTokPerSec} tok/s</span>
    <span class="burn-rate-stat-sep">&middot;</span>
    <span>${formatElapsed(s.elapsed)}</span>
  `;
}

function drawHistogram(): void {
  if (!ctx || !canvas) return;
  const w = canvas.width;
  const h = canvas.height * window.devicePixelRatio;
  canvas.height = 48 * window.devicePixelRatio;
  canvas.style.height = '48px';

  ctx.clearRect(0, 0, w, h);

  if (!latestSnapshot || latestSnapshot.histogram.length === 0) return;

  const hist = latestSnapshot.histogram;
  const peak = latestSnapshot.peakTokPerSec || 1;
  const barCount = hist.length;
  const barWidth = w / barCount;
  const gap = Math.max(0.5, barWidth * 0.1);

  for (let i = 0; i < barCount; i++) {
    const rate = hist[i];
    if (rate <= 0) continue;

    const ratio = rate / peak;
    const barH = Math.max(1, ratio * (h - 2));

    let color: string;
    if (ratio > 0.85) color = COLORS.barPeak;
    else if (ratio > 0.5) color = COLORS.barHigh;
    else color = COLORS.barNormal;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(
      i * barWidth + gap / 2,
      h - barH,
      barWidth - gap,
      barH,
    );
  }

  ctx.globalAlpha = 1;
}

function drawActivityTimeline(): void {
  const el = document.getElementById('burn-rate-activity');
  if (!el || !latestSnapshot) {
    if (el) el.innerHTML = '';
    return;
  }

  const timeline = latestSnapshot.activityTimeline;
  if (timeline.length === 0) return;

  const segments: Array<{ activity: string; count: number }> = [];
  for (const act of timeline) {
    const last = segments[segments.length - 1];
    if (last && last.activity === act) {
      last.count++;
    } else {
      segments.push({ activity: act, count: 1 });
    }
  }

  const totalBuckets = timeline.length;
  el.innerHTML = '';

  for (const seg of segments) {
    const div = document.createElement('div');
    div.className = `burn-rate-seg burn-rate-seg-${seg.activity}`;
    div.style.flex = String(seg.count / totalBuckets);
    el.appendChild(div);
  }
}

// ─── Status bar helpers ───────────────────────────────────────

export function formatTokenStats(snapshot: TokenSnapshot | null): string {
  if (!snapshot || snapshot.totalTokens <= 0) return '';
  const tokK = snapshot.totalTokens > 999
    ? `${(snapshot.totalTokens / 1000).toFixed(1)}k`
    : String(snapshot.totalTokens);
  return `${tokK} tok`;
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
