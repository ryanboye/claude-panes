/**
 * Home screen dashboard: responsive grid of mini terminal cards on a dot-grid
 * background. Shows live output snippets with inline input. Reflows on resize.
 */

declare const api: import('../preload/index').ClaudePanesAPI;

export interface DashboardPane {
  paneId: string;
  projectId: string;
  projectName: string;
  role: string;
  costUsd: number;
  totalTokens: number;
  isAlive: boolean;
  isStuck: boolean;
  stuckQuestion: string | null;
  lastActivity: string;
  lastSnippet: string[];
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
let canvasEl: HTMLElement | null = null;
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

export function renderHomeScreen(
  el: HTMLElement,
  onNavigate: NavigateCallback,
): void {
  container = el;
  navigateCb = onNavigate;
  el.innerHTML = '';
  el.className = 'home-screen';
  canvasEl = null;
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
    canvasEl = null;
    container.innerHTML = `
      <div class="home-empty">
        <h2>No Active Agents</h2>
        <p>Open a project and spawn panes to see them here</p>
      </div>
    `;
    return;
  }

  // Ensure canvas exists
  if (!canvasEl || !container.contains(canvasEl)) {
    container.innerHTML = '';
    canvasEl = document.createElement('div');
    canvasEl.className = 'home-canvas';
    container.appendChild(canvasEl);
  }

  // Reconcile cards: add new, remove stale, update existing
  const existingCards = new Map<string, HTMLElement>();
  for (const el of Array.from(canvasEl.querySelectorAll('.canvas-card'))) {
    const htmlEl = el as HTMLElement;
    const id = htmlEl.dataset.paneId;
    if (id) existingCards.set(id, htmlEl);
  }

  const currentIds = new Set(panes.map(p => p.paneId));

  // Remove cards for panes that no longer exist
  for (const [id, el] of existingCards) {
    if (!currentIds.has(id)) {
      el.remove();
      existingCards.delete(id);
    }
  }

  // Add or update cards
  for (let i = 0; i < panes.length; i++) {
    const pane = panes[i];
    const existing = existingCards.get(pane.paneId);
    if (existing) {
      updateCard(pane, existing);
    } else {
      canvasEl.appendChild(createCard(pane));
    }
  }
}

function getStatusClass(pane: DashboardPane): string {
  if (pane.isStuck) return 'status-stuck';
  if (!pane.isAlive) return 'status-exited';
  if (pane.activity !== 'idle' || pane.currentTokPerSec > 0) return 'status-working';
  return 'status-idle';
}

function getStatusText(pane: DashboardPane): string {
  if (pane.isStuck) return 'stuck';
  if (!pane.isAlive) return 'exited';
  if (pane.activity !== 'idle' || pane.currentTokPerSec > 0) return pane.activity || 'working';
  return 'idle';
}

function needsInput(pane: DashboardPane): boolean {
  return pane.isStuck || (!pane.isActiveBurn && pane.isAlive);
}

function createCard(pane: DashboardPane): HTMLElement {
  const card = document.createElement('div');
  const status = getStatusClass(pane);
  card.className = `canvas-card ${status}`;
  if (needsInput(pane)) card.classList.add('needs-input');
  card.dataset.paneId = pane.paneId;
  card.dataset.projectId = pane.projectId;

  // ── Titlebar ──
  const titlebar = document.createElement('div');
  titlebar.className = 'canvas-card-titlebar';

  // Decorative macOS dots
  const dots = document.createElement('div');
  dots.className = 'canvas-card-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  titlebar.appendChild(dots);

  // Role badge
  const roleEl = document.createElement('span');
  roleEl.className = 'canvas-card-role';
  roleEl.textContent = pane.role === 'default' ? 'agent' : pane.role;
  roleEl.style.color = ROLE_COLORS[pane.role] ?? ROLE_COLORS.default;
  titlebar.appendChild(roleEl);

  // Project name
  const projectLabel = document.createElement('span');
  projectLabel.className = 'canvas-card-project';
  projectLabel.textContent = pane.projectName;
  titlebar.appendChild(projectLabel);

  // Status text
  const statusEl = document.createElement('span');
  statusEl.className = 'canvas-card-status';
  statusEl.textContent = getStatusText(pane);
  titlebar.appendChild(statusEl);

  // Click titlebar to navigate to pane
  titlebar.addEventListener('click', () => {
    const projectId = card.dataset.projectId;
    if (projectId && navigateCb) {
      navigateCb(projectId, pane.paneId);
    }
  });

  card.appendChild(titlebar);

  // ── Preview (short, 3 lines max) ──
  const preview = document.createElement('pre');
  preview.className = 'canvas-card-preview';
  preview.textContent = formatSnippet(pane);
  card.appendChild(preview);

  // ── Stats (rich, with histogram + colored values) ──
  const stats = document.createElement('div');
  stats.className = 'canvas-card-stats';
  stats.innerHTML = buildStatsHTML(pane);
  card.appendChild(stats);

  // ── Input ──
  const inputEl = document.createElement('input');
  inputEl.className = 'canvas-card-input';
  inputEl.type = 'text';
  inputEl.placeholder = pane.isStuck
    ? 'Respond to agent...'
    : 'Send input...';
  inputEl.addEventListener('click', (e) => e.stopPropagation());
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && inputEl.value.trim()) {
      e.preventDefault();
      const text = inputEl.value.trim();
      api.pty.write(pane.paneId, pane.projectId, text + '\n');
      if (pane.isStuck) {
        api.dashboard.clearStuck(pane.paneId);
      }
      inputEl.value = '';
      card.classList.remove('status-stuck', 'needs-input');
      card.classList.add('status-working');
      const st = card.querySelector('.canvas-card-status');
      if (st) st.textContent = 'working';
    }
  });
  card.appendChild(inputEl);

  return card;
}


function updateCard(pane: DashboardPane, card: HTMLElement): void {
  // Update status classes without touching transform
  const status = getStatusClass(pane);
  const showInput = needsInput(pane);

  // Rebuild class list
  card.className = `canvas-card ${status}`;
  if (showInput) card.classList.add('needs-input');

  // Update status text
  const statusEl = card.querySelector('.canvas-card-status');
  if (statusEl) statusEl.textContent = getStatusText(pane);

  // Update preview
  const preview = card.querySelector('.canvas-card-preview');
  if (preview) preview.textContent = formatSnippet(pane);

  // Update stats
  const stats = card.querySelector('.canvas-card-stats');
  if (stats) stats.innerHTML = buildStatsHTML(pane);

  // Update input placeholder
  const input = card.querySelector('.canvas-card-input') as HTMLInputElement | null;
  if (input) {
    input.placeholder = pane.isStuck ? 'Respond to agent...' : 'Send input...';
  }
}

function formatSnippet(pane: DashboardPane): string {
  if (pane.lastSnippet.length > 0) {
    // Limit to 3 lines for compact cards
    return pane.lastSnippet.slice(-3).join('\n');
  }
  return pane.lastActivity || 'Starting...';
}

function buildStatsHTML(pane: DashboardPane): string {
  const tok = formatTokens(pane.totalTokens);
  const cost = pane.costUsd > 0 ? `$${pane.costUsd.toFixed(2)}` : '';
  const rate = pane.currentTokPerSec > 0 ? `${pane.currentTokPerSec} tok/s` : '';
  const uptime = formatUptime(pane.spawnedAt);
  const rateClass = pane.isActiveBurn ? 'stat-active' : '';

  // Build mini histogram from the pane's histogram data
  let histogramHTML = '';
  if (pane.histogram && pane.histogram.length > 0) {
    const max = Math.max(...pane.histogram, 1);
    const bars = pane.histogram.slice(-20).map(v => {
      const h = Math.max(1, Math.round((v / max) * 20));
      const cls = v === 0 ? 'bar-idle' : '';
      return `<span class="canvas-card-histogram-bar ${cls}" style="height:${h}px"></span>`;
    }).join('');
    histogramHTML = `<div class="canvas-card-histogram">${bars}</div>`;
  }

  // Row 1: tokens, cost, rate
  const statsRow = [
    tok ? `<span class="canvas-card-stat"><span class="canvas-card-stat-value stat-tokens">${tok}</span></span>` : '',
    cost ? `<span class="canvas-card-stat"><span class="canvas-card-stat-value stat-cost">${cost}</span></span>` : '',
    rate ? `<span class="canvas-card-stat"><span class="canvas-card-stat-value ${rateClass}">${rate}</span></span>` : '',
    `<span class="canvas-card-stat"><span class="canvas-card-stat-value">${uptime}</span></span>`,
  ].filter(Boolean).join('');

  return `<div class="canvas-card-stats-row">${statsRow}</div>${histogramHTML}`;
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

export function destroyHomeScreen(): void {
  if (container) {
    container.innerHTML = '';
    container.className = '';
  }
  container = null;
  canvasEl = null;
  navigateCb = null;
  currentPanes = [];
}
