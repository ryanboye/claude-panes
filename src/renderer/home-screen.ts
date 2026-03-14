/**
 * Home screen dashboard: shows all active agents across all projects.
 * Stuck agents surface their question and allow inline response.
 */

declare const api: import('../preload/index').ClaudePanesAPI;

export interface DashboardPane {
  paneId: string;
  projectId: string;
  projectName: string;
  role: string;
  costUsd: number; // kept for interface compat, not displayed
  totalTokens: number;
  isAlive: boolean;
  isStuck: boolean;
  stuckQuestion: string | null;
  lastActivity: string;
  spawnedAt: number;
  currentTokPerSec: number;
  avgTokPerSec: number;
  peakTokPerSec: number;
  elapsed: number;
  activity: string;
  isActiveBurn: boolean;
  histogram: number[];
  activityTimeline: string[];
}

type NavigateCallback = (projectId: string, paneId: string) => void;

let container: HTMLElement | null = null;
let navigateCb: NavigateCallback | null = null;
let currentPanes: DashboardPane[] = [];

const ROLE_COLORS: Record<string, string> = {
  researcher: 'var(--role-researcher)',
  architect: 'var(--role-architect)',
  builder: 'var(--role-builder)',
  reviewer: 'var(--role-reviewer)',
  designer: 'var(--role-designer)',
  default: 'var(--text-muted)',
};

const HIST_COLORS = {
  barNormal: '#4ade80',
  barHigh: '#fbbf24',
  barPeak: '#ff6b6b',
};

const ACTIVITY_COLORS: Record<string, string> = {
  reading: '#60a5fa',
  editing: '#fbbf24',
  thinking: '#c084fc',
  idle: '#2a2a4a',
};

export function renderHomeScreen(
  el: HTMLElement,
  onNavigate: NavigateCallback,
): void {
  container = el;
  navigateCb = onNavigate;
  el.innerHTML = '';
  el.className = 'home-screen';

  // Initial load
  refreshDashboard();
}

export async function refreshDashboard(): Promise<void> {
  if (!container) return;
  const panes: DashboardPane[] = await api.dashboard.getSnapshot();
  updateHomeScreen(panes);
}

export function updateHomeScreen(panes: DashboardPane[]): void {
  if (!container) return;
  currentPanes = panes;

  if (panes.length === 0) {
    container.innerHTML = `
      <div class="home-empty">
        <h2>No Active Agents</h2>
        <p>Open a project and spawn panes to see them here</p>
      </div>
    `;
    return;
  }

  // Group by project
  const byProject = new Map<string, DashboardPane[]>();
  for (const pane of panes) {
    const group = byProject.get(pane.projectId) ?? [];
    group.push(pane);
    byProject.set(pane.projectId, group);
  }

  // Diff update: only rebuild if pane count changed or IDs changed
  const existingIds = new Set(
    Array.from(container.querySelectorAll('.home-card')).map(
      (el) => (el as HTMLElement).dataset.paneId,
    ),
  );
  const newIds = new Set(panes.map((p) => p.paneId));
  const needsRebuild =
    existingIds.size !== newIds.size ||
    [...newIds].some((id) => !existingIds.has(id));

  if (needsRebuild) {
    rebuildGrid(byProject);
  } else {
    // Update existing cards in-place
    for (const pane of panes) {
      updateCard(pane);
    }
  }
}

function rebuildGrid(byProject: Map<string, DashboardPane[]>): void {
  if (!container) return;
  container.innerHTML = '';

  const section = document.createElement('div');
  section.className = 'home-project-section';

  const grid = document.createElement('div');
  grid.className = 'home-grid';

  for (const [projectId, panes] of byProject) {
    for (const pane of panes) {
      grid.appendChild(createCard(pane));
    }
  }

  section.appendChild(grid);
  container.appendChild(section);
}

function createCard(pane: DashboardPane): HTMLElement {
  const card = document.createElement('div');
  card.className = 'home-card' + (pane.isStuck ? ' stuck' : '') + (!pane.isAlive ? ' exited' : '');
  card.dataset.paneId = pane.paneId;
  card.style.borderLeftColor = ROLE_COLORS[pane.role] ?? ROLE_COLORS.default;

  // Header (clickable to navigate)
  const headerEl = document.createElement('div');
  headerEl.className = 'home-card-header';
  headerEl.addEventListener('click', () => {
    navigateCb?.(pane.projectId, pane.paneId);
  });

  const roleEl = document.createElement('span');
  roleEl.className = 'home-card-role';
  roleEl.textContent = pane.role === 'default' ? 'agent' : pane.role;
  roleEl.style.color = ROLE_COLORS[pane.role] ?? ROLE_COLORS.default;
  headerEl.appendChild(roleEl);

  const projectLabel = document.createElement('span');
  projectLabel.className = 'home-card-project';
  projectLabel.textContent = pane.projectName;
  headerEl.appendChild(projectLabel);

  const statusEl = document.createElement('span');
  statusEl.className = 'home-card-status';
  if (pane.isStuck) {
    statusEl.classList.add('status-stuck');
    statusEl.textContent = 'stuck';
  } else if (!pane.isAlive) {
    statusEl.classList.add('status-exited');
    statusEl.textContent = 'exited';
  } else if (!pane.isActiveBurn) {
    statusEl.classList.add('status-idle');
    statusEl.textContent = 'idle';
  } else {
    statusEl.classList.add('status-running');
    statusEl.textContent = 'running';
  }
  headerEl.appendChild(statusEl);

  card.appendChild(headerEl);

  // Activity line
  const activityEl = document.createElement('div');
  activityEl.className = 'home-card-activity';
  activityEl.textContent = pane.lastActivity
    ? truncate(pane.lastActivity, 120)
    : 'Starting...';
  card.appendChild(activityEl);

  // Stats row (current rate, avg, peak)
  const statsEl = document.createElement('div');
  statsEl.className = 'home-card-stats';
  statsEl.innerHTML = `
    <span class="home-card-stat-current">${pane.currentTokPerSec} tok/s</span>
    <span class="home-card-stat-sep">&middot;</span>
    <span>avg ${pane.avgTokPerSec}</span>
    <span class="home-card-stat-sep">&middot;</span>
    <span>peak ${pane.peakTokPerSec}</span>
  `;
  card.appendChild(statsEl);

  // Histogram canvas
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'home-card-chart-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'home-card-chart';
  canvas.height = 24 * window.devicePixelRatio;
  canvas.style.height = '24px';
  canvasWrap.appendChild(canvas);
  card.appendChild(canvasWrap);

  // Activity timeline bar
  const timelineEl = document.createElement('div');
  timelineEl.className = 'home-card-timeline';
  card.appendChild(timelineEl);

  // Draw chart after append (needs width)
  requestAnimationFrame(() => {
    const w = canvasWrap.clientWidth;
    if (w > 0) {
      canvas.width = w * window.devicePixelRatio;
      canvas.style.width = `${w}px`;
      drawCardHistogram(canvas, pane.histogram, pane.peakTokPerSec);
    }
    drawCardTimeline(timelineEl, pane.activityTimeline);
  });

  // Meta row (tokens + uptime + activity label)
  const metaEl = document.createElement('div');
  metaEl.className = 'home-card-meta';

  const tokensEl = document.createElement('span');
  tokensEl.className = 'home-card-tokens';
  tokensEl.textContent = formatTokens(pane.totalTokens ?? 0);
  metaEl.appendChild(tokensEl);

  const actLabel = document.createElement('span');
  actLabel.className = 'home-card-activity-label';
  actLabel.textContent = pane.activity !== 'idle' ? pane.activity : '';
  metaEl.appendChild(actLabel);

  const uptimeEl = document.createElement('span');
  uptimeEl.className = 'home-card-uptime';
  uptimeEl.textContent = formatUptime(pane.spawnedAt);
  metaEl.appendChild(uptimeEl);
  card.appendChild(metaEl);

  // Stuck question + input
  if (pane.isStuck && pane.stuckQuestion) {
    const questionEl = document.createElement('div');
    questionEl.className = 'home-card-question';
    questionEl.textContent = pane.stuckQuestion;
    card.appendChild(questionEl);

    const inputEl = document.createElement('input');
    inputEl.className = 'home-card-input';
    inputEl.type = 'text';
    inputEl.placeholder = 'Type a response and press Enter...';
    inputEl.addEventListener('click', (e) => e.stopPropagation());
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && inputEl.value.trim()) {
        e.preventDefault();
        const text = inputEl.value.trim();
        api.pty.write(pane.paneId, pane.projectId, text + '\n');
        api.dashboard.clearStuck(pane.paneId);
        inputEl.value = '';
        card.classList.remove('stuck');
        const qEl = card.querySelector('.home-card-question');
        if (qEl) qEl.remove();
        inputEl.remove();
        const st = card.querySelector('.home-card-status');
        if (st) {
          st.className = 'home-card-status status-running';
          st.textContent = 'running';
        }
      }
    });
    card.appendChild(inputEl);
  }

  // Click non-stuck card to navigate
  if (!pane.isStuck) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      navigateCb?.(pane.projectId, pane.paneId);
    });
  }

  return card;
}

function drawCardHistogram(canvas: HTMLCanvasElement, histogram: number[], peak: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || histogram.length === 0) return;

  const w = canvas.width;
  const h = canvas.height;
  const peakVal = peak || 1;
  const barCount = histogram.length;
  const barWidth = w / barCount;
  const gap = Math.max(0.5, barWidth * 0.1);

  ctx.clearRect(0, 0, w, h);

  for (let i = 0; i < barCount; i++) {
    const rate = histogram[i];
    if (rate <= 0) continue;

    const ratio = rate / peakVal;
    const barH = Math.max(1, ratio * (h - 2));

    let color: string;
    if (ratio > 0.85) color = HIST_COLORS.barPeak;
    else if (ratio > 0.5) color = HIST_COLORS.barHigh;
    else color = HIST_COLORS.barNormal;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(i * barWidth + gap / 2, h - barH, barWidth - gap, barH);
  }
  ctx.globalAlpha = 1;
}

function drawCardTimeline(el: HTMLElement, timeline: string[]): void {
  el.innerHTML = '';
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

  const total = timeline.length;
  for (const seg of segments) {
    const div = document.createElement('div');
    div.className = 'home-card-timeline-seg';
    div.style.flex = String(seg.count / total);
    div.style.backgroundColor = ACTIVITY_COLORS[seg.activity] ?? ACTIVITY_COLORS.idle;
    el.appendChild(div);
  }
}

function updateCard(pane: DashboardPane): void {
  const card = document.querySelector(`.home-card[data-pane-id="${pane.paneId}"]`) as HTMLElement | null;
  if (!card) return;

  // Update stuck/exited state
  card.classList.toggle('stuck', pane.isStuck);
  card.classList.toggle('exited', !pane.isAlive);

  // Update status
  const statusEl = card.querySelector('.home-card-status');
  if (statusEl) {
    statusEl.className = 'home-card-status';
    if (pane.isStuck) {
      statusEl.classList.add('status-stuck');
      statusEl.textContent = 'stuck';
    } else if (!pane.isAlive) {
      statusEl.classList.add('status-exited');
      statusEl.textContent = 'exited';
    } else {
      statusEl.classList.add('status-running');
      statusEl.textContent = 'running';
    }
  }

  // Update activity
  const activityEl = card.querySelector('.home-card-activity');
  if (activityEl && pane.lastActivity) {
    activityEl.textContent = truncate(pane.lastActivity, 120);
  }

  // Update stats row
  const statsEl = card.querySelector('.home-card-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <span class="home-card-stat-current">${pane.currentTokPerSec} tok/s</span>
      <span class="home-card-stat-sep">&middot;</span>
      <span>avg ${pane.avgTokPerSec}</span>
      <span class="home-card-stat-sep">&middot;</span>
      <span>peak ${pane.peakTokPerSec}</span>
    `;
  }

  // Update histogram chart
  const canvas = card.querySelector('.home-card-chart') as HTMLCanvasElement | null;
  if (canvas) {
    drawCardHistogram(canvas, pane.histogram, pane.peakTokPerSec);
  }

  // Update activity timeline
  const timelineEl = card.querySelector('.home-card-timeline') as HTMLElement | null;
  if (timelineEl) {
    drawCardTimeline(timelineEl, pane.activityTimeline);
  }

  // Update tokens
  const tokensEl = card.querySelector('.home-card-tokens');
  if (tokensEl) {
    tokensEl.textContent = formatTokens(pane.totalTokens ?? 0);
  }

  // Update activity label
  const actLabel = card.querySelector('.home-card-activity-label');
  if (actLabel) {
    actLabel.textContent = pane.activity !== 'idle' ? pane.activity : '';
  }

  // Update uptime
  const uptimeEl = card.querySelector('.home-card-uptime');
  if (uptimeEl) {
    uptimeEl.textContent = formatUptime(pane.spawnedAt);
  }
}

function formatUptime(spawnedAt: number): string {
  const seconds = Math.floor((Date.now() - spawnedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(tokens: number): string {
  if (tokens <= 0) return '';
  if (tokens < 1000) return `${tokens} tok`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k tok`;
  return `${(tokens / 1_000_000).toFixed(1)}M tok`;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '\u2026' : str;
}

export function destroyHomeScreen(): void {
  if (container) {
    container.innerHTML = '';
    container.className = '';
  }
  container = null;
  navigateCb = null;
  currentPanes = [];
}
