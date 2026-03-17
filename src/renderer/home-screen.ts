/**
 * Home screen dashboard: canvas-style view with draggable mini terminal cards
 * on a dot-grid background. Shows live output snippets with inline input.
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
let draggingPaneId: string | null = null;

const ROLE_COLORS: Record<string, string> = {
  researcher: 'var(--role-researcher)',
  architect: 'var(--role-architect)',
  builder: 'var(--role-builder)',
  reviewer: 'var(--role-reviewer)',
  designer: 'var(--role-designer)',
  default: 'var(--text-muted)',
};

// Card positions persisted to localStorage
const POSITIONS_KEY = 'claude-panes-canvas-positions';
const cardPositions = new Map<string, { x: number; y: number }>();

// Auto-layout constants
const CARD_W = 300;
const CARD_H = 360;
const GAP = 20;
const COLS = 3;

function loadPositions(): void {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, { x: number; y: number }>;
      for (const [k, v] of Object.entries(obj)) {
        cardPositions.set(k, v);
      }
    }
  } catch { /* ignore */ }
}

function savePositions(): void {
  const obj: Record<string, { x: number; y: number }> = {};
  for (const [k, v] of cardPositions) {
    obj[k] = v;
  }
  localStorage.setItem(POSITIONS_KEY, JSON.stringify(obj));
}

function autoLayoutPosition(index: number): { x: number; y: number } {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    x: GAP + col * (CARD_W + GAP),
    y: GAP + row * (CARD_H + GAP),
  };
}

export function renderHomeScreen(
  el: HTMLElement,
  onNavigate: NavigateCallback,
): void {
  container = el;
  navigateCb = onNavigate;
  el.innerHTML = '';
  el.className = 'home-screen';
  canvasEl = null;
  loadPositions();
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
  let newIndex = panes.length; // for auto-layout of brand new cards
  for (let i = 0; i < panes.length; i++) {
    const pane = panes[i];
    const existing = existingCards.get(pane.paneId);
    if (existing) {
      updateCard(pane, existing);
    } else {
      // Assign position for new card if not already stored
      if (!cardPositions.has(pane.paneId)) {
        cardPositions.set(pane.paneId, autoLayoutPosition(i));
        savePositions();
      }
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

  applyPosition(card, pane.paneId);

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

  // Drag via pointer events on titlebar
  setupDrag(titlebar, card, pane.paneId);

  card.appendChild(titlebar);

  // ── Preview ──
  const preview = document.createElement('pre');
  preview.className = 'canvas-card-preview';
  preview.textContent = formatSnippet(pane);
  card.appendChild(preview);

  // ── Stats ──
  const stats = document.createElement('div');
  stats.className = 'canvas-card-stats';
  stats.textContent = formatCompactStats(pane);
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

function applyPosition(card: HTMLElement, paneId: string): void {
  const pos = cardPositions.get(paneId) ?? { x: 20, y: 20 };
  card.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
}

function setupDrag(titlebar: HTMLElement, card: HTMLElement, paneId: string): void {
  let startX = 0;
  let startY = 0;
  let origX = 0;
  let origY = 0;
  let dragging = false;
  const CLICK_THRESHOLD = 3;

  titlebar.addEventListener('pointerdown', (e: PointerEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    titlebar.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startY = e.clientY;
    const pos = cardPositions.get(paneId) ?? { x: 0, y: 0 };
    origX = pos.x;
    origY = pos.y;
    dragging = false;
    draggingPaneId = paneId;
  });

  titlebar.addEventListener('pointermove', (e: PointerEvent) => {
    if (!titlebar.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging && Math.abs(dx) + Math.abs(dy) < CLICK_THRESHOLD) return;
    dragging = true;
    const newX = Math.max(0, origX + dx);
    const newY = Math.max(0, origY + dy);
    card.style.transform = `translate(${newX}px, ${newY}px)`;
    cardPositions.set(paneId, { x: newX, y: newY });
  });

  titlebar.addEventListener('pointerup', (e: PointerEvent) => {
    if (titlebar.hasPointerCapture(e.pointerId)) {
      titlebar.releasePointerCapture(e.pointerId);
    }
    draggingPaneId = null;
    if (dragging) {
      savePositions();
    } else {
      // Click — navigate to pane
      const projectId = card.dataset.projectId;
      if (projectId && navigateCb) {
        navigateCb(projectId, paneId);
      }
    }
  });
}

function updateCard(pane: DashboardPane, card: HTMLElement): void {
  // Update status classes without touching transform
  const status = getStatusClass(pane);
  const showInput = needsInput(pane);

  // Rebuild class list preserving nothing else
  card.className = `canvas-card ${status}`;
  if (showInput) card.classList.add('needs-input');

  // Re-apply position unless this card is actively being dragged
  if (pane.paneId !== draggingPaneId) {
    applyPosition(card, pane.paneId);
  }

  // Update status text
  const statusEl = card.querySelector('.canvas-card-status');
  if (statusEl) statusEl.textContent = getStatusText(pane);

  // Update preview
  const preview = card.querySelector('.canvas-card-preview');
  if (preview) preview.textContent = formatSnippet(pane);

  // Update stats
  const stats = card.querySelector('.canvas-card-stats');
  if (stats) stats.textContent = formatCompactStats(pane);

  // Update input placeholder
  const input = card.querySelector('.canvas-card-input') as HTMLInputElement | null;
  if (input) {
    input.placeholder = pane.isStuck ? 'Respond to agent...' : 'Send input...';
  }
}

function formatSnippet(pane: DashboardPane): string {
  if (pane.lastSnippet.length > 0) {
    return pane.lastSnippet.join('\n');
  }
  return pane.lastActivity || 'Starting...';
}

function formatCompactStats(pane: DashboardPane): string {
  const tok = formatTokens(pane.totalTokens);
  const rate = pane.currentTokPerSec > 0 ? `${pane.currentTokPerSec} tok/s` : '';
  const uptime = formatUptime(pane.spawnedAt);
  return [tok, rate, uptime].filter(Boolean).join(' | ');
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
