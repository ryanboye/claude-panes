/**
 * Main renderer entry point.
 * Wires together sidebar, pane layout, terminal management, and IPC events.
 */

declare const api: import('../preload/index').ClaudePanesAPI;

import {
  type SplitNode,
  createLeaf,
  splitPane,
  splitPaneRaw,
  closePane,
  resizePane,
  getLeafIds,
  setLeafRole,
  serializeTree,
  deserializeTree,
  countLeaves,
} from './pane-tree';
import { renderPaneTree } from './pane-layout';
import {
  createTerminalPane,
  disposeTerminalPane,
  getTerminalPane,
  writeToTerminal,
  focusTerminal,
  disposeAllTerminals,
  detachAllTerminals,
  reattachTerminal,
} from './terminal-pane';
import { initSidebar, setActiveProject, setHomeActive, refreshProjects, updateDetachedState, updateProjectActivity } from './project-sidebar';
import { initCostTracking, updatePaneTokens, setPaneStatus } from './cost-overlay';
import { renderHomeScreen, refreshDashboard, destroyHomeScreen } from './home-screen';
import { initBurnRatePanel, setBurnRatePaneId, updateBurnRate, formatTokenStats, toggleBurnRatePopup } from './burn-rate-panel';
import { applyTheme, getThemes, getCurrentThemeId } from './themes';
import { updateAllTerminalThemes, fitAllTerminals } from './terminal-pane';

// ─── State ───────────────────────────────────────────────────

let tree: SplitNode = createLeaf();
let activePaneId: string = (tree as any).id;
let currentProjectPath: string | null = null;
let panelVisible = true;
let panelBottom = false;
let homeScreenActive = true;
let projectSwitchGeneration = 0;
let roles: Array<{ name: string; label: string; color: string }> = [];

// Detached window mode
const windowMode = api.window.getMode();
const isDetachedWindow = windowMode.detached;
const detachedProjectPath = windowMode.projectPath;

// ─── DOM Refs ────────────────────────────────────────────────

const sidebarEl = document.getElementById('sidebar')!;
const sidebarHandle = document.getElementById('sidebar-handle')!;
const workspaceEl = document.getElementById('workspace')!;
const panelHandle = document.getElementById('panel-handle')!;
const panelEl = document.getElementById('context-panel')!;
const statusBar = document.getElementById('status-bar')!;
const mainContainer = document.getElementById('main-container')!;
const contextMenuEl = document.getElementById('context-menu')!;
const emptyState = document.getElementById('empty-state')!;

// ─── Init ────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Apply saved theme early before any rendering
  const prefs = await api.prefs.load();
  applyTheme(prefs.theme || 'midnight');

  roles = await api.roles.list();
  initResizeHandles();

  // Refit all terminals when window is resized
  let resizeTimer: number | undefined;
  globalThis.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = undefined;
      fitAllTerminals();
    }, 50);
  });
  initCostTracking();
  initBurnRatePanel();
  initActivityFeed();
  renderThemeButton();

  // Listen for dev server status changes
  api.devServer.onStatus((projectPath, status, url) => {
    if (projectPath !== currentProjectPath) return;
    if (status === 'running') {
      devServerRunning = true;
      devServerUrl = url;
      updateDevServerButtonState();
    } else if (status === 'stopped') {
      devServerRunning = false;
      devServerUrl = null;
      updateDevServerButtonState();
    }
  });

  // Wire token updates
  let latestTokenSnapshot: any = null;
  // Track which panes are actively burning tokens, keyed by projectId → Set<paneId>
  const activePanesPerProject = new Map<string, Set<string>>();

  api.tokens.onUpdate((paneId: string, snapshot: unknown) => {
    const snap = snapshot as any;
    updateBurnRate(paneId, snap);
    updatePaneTokens(paneId, snap?.totalTokens ?? 0);
    if (paneId === activePaneId) {
      latestTokenSnapshot = snap;
      updateStatusBarTokens(snap);
    }

    // Update pane status dot: idle vs running based on token burn
    const isActive = (snap?.currentTokPerSec ?? 0) > 0;
    const statusEl = document.getElementById(`status-${paneId}`);
    if (statusEl && !statusEl.classList.contains('pane-status-stuck') && !statusEl.classList.contains('pane-status-exited')) {
      setPaneStatus(paneId, isActive ? 'running' : 'idle');
    }

    // Update sidebar icon opacity: fade when NO panes in the project are burning
    if (snap?.projectId) {
      let activeSet = activePanesPerProject.get(snap.projectId);
      if (!activeSet) {
        activeSet = new Set();
        activePanesPerProject.set(snap.projectId, activeSet);
      }
      if (isActive) {
        activeSet.add(paneId);
      } else {
        activeSet.delete(paneId);
      }
      updateProjectActivity(snap.projectId, activeSet.size > 0);
    }
  });

  if (isDetachedWindow) {
    // Detached window: hide sidebar, add dock button, auto-open the project
    sidebarEl.style.display = 'none';
    sidebarHandle.style.display = 'none';
    homeScreenActive = false;

    // Add "dock back" button in the title bar drag area
    const titleBar = document.querySelector('.title-bar-drag');
    if (titleBar) {
      const dockBtn = document.createElement('button');
      dockBtn.className = 'dock-back-btn';
      dockBtn.textContent = '\u2190 dock';
      dockBtn.title = 'Return this project to the main window';
      dockBtn.addEventListener('click', () => window.close());
      titleBar.appendChild(dockBtn);
    }
  } else {
    await initSidebar(sidebarEl, {
      onSelectProject: openProject,
      onAddProject: addProject,
      onCreateProject: createProject,
      onHomeClick: showHomeScreen,
    });

    // Listen for project reattach events
    api.window.onProjectReattached(() => {
      updateDetachedState();
    });

    // When a project is detached into its own window, stop showing it here
    api.on('project:detached', (projectPath: unknown) => {
      updateDetachedState();
      if (currentProjectPath === projectPath) {
        // The active project was just detached — go to home screen
        showHomeScreen();
      }
    });
  }

  // Wire PTY data to terminals
  api.pty.onData((paneId, data) => {
    writeToTerminal(paneId, data);
  });

  api.pty.onExit((paneId, code) => {
    setPaneStatus(paneId, 'exited');
  });

  // Wire app events from main process
  api.on('app:newProject', () => addProject());
  api.on('pane:splitVertical', () => splitActivePaneVertical());
  api.on('pane:splitHorizontal', () => splitActivePaneHorizontal());
  api.on('pane:splitVerticalRaw', () => splitActivePaneVerticalRaw());
  api.on('pane:splitHorizontalRaw', () => splitActivePaneHorizontalRaw());
  api.on('pane:close', () => closeActivePane());
  api.on('pane:prev', () => navigatePanes(-1));
  api.on('pane:next', () => navigatePanes(1));
  api.on('pane:focus', (index: unknown) => focusPaneByIndex(index as number));
  api.on('pane:focusById', (id: unknown) => setActivePaneAndRender(id as string));
  api.on('panel:toggle', () => togglePanel());
  api.on('panel:flipPosition', () => flipPanelPosition());
  api.on('action:saveToResearch', () => saveSelectionToResearch());
  api.on('action:toggleDevServer', () => toggleDevServer());
  api.on('stuck:detected', (paneId: unknown) => {
    setPaneStatus(paneId as string, 'stuck');
    if (homeScreenActive) refreshDashboard();
  });

  // Dashboard events — refresh home screen when active
  api.dashboard.onPaneActivity(() => {
    if (homeScreenActive) refreshDashboard();
  });
  api.cost.onUpdate(() => {
    if (homeScreenActive) refreshDashboard();
  });
  api.pty.onExit(() => {
    if (homeScreenActive) refreshDashboard();
  });
  api.on('app:error', (err: unknown) => {
    const { title, message } = err as { title: string; message: string };
    showError(title, message);
  });
  api.on('app:showPreferences', () => showPreferences());

  // Close context menu on click elsewhere
  document.addEventListener('click', () => {
    contextMenuEl.style.display = 'none';
  });

  // Detached window: auto-open the project with reattach
  if (isDetachedWindow && detachedProjectPath) {
    await openProjectDetached(detachedProjectPath);
  } else {
    // Show empty state / home screen initially
    showEmptyState();
  }
  updateStatusBar();
}

// ─── Detached Window Project Open ─────────────────────────────

async function openProjectDetached(projectPath: string): Promise<void> {
  currentProjectPath = projectPath;

  // Load project config
  const config = await api.project.open(projectPath);

  // Restore layout or create default
  if (config?.layout) {
    tree = deserializeTree(config.layout);
  } else {
    tree = createLeaf();
  }

  activePaneId = getLeafIds(tree)[0];
  emptyState.style.display = 'none';
  workspaceEl.style.display = '';
  panelEl.style.display = panelVisible ? '' : 'none';
  panelHandle.style.display = panelVisible ? '' : 'none';

  // Render workspace using reattach (PTYs are already running from main window)
  renderWorkspaceDetached();
  await loadContextPanel();
}

function renderWorkspaceDetached(): void {
  if (!currentProjectPath) return;
  const projectPath = currentProjectPath;
  const projectId = currentProjectPath;

  renderPaneTree(tree, workspaceEl, {
    onPaneMount: async (paneId, container) => {
      const existing = getTerminalPane(paneId);
      if (existing) {
        existing.fitAddon.fit();
      } else {
        // Reattach to existing PTY running in main process
        const leaf = findLeaf(tree, paneId);
        await reattachTerminal(paneId, container, projectId, projectPath, leaf?.role, leaf?.rawTerminal);
        setPaneStatus(paneId, 'running');
      }
    },
    onPaneUnmount: (paneId) => {
      disposeTerminalPane(paneId);
    },
    onResizeStart: () => {
      document.querySelectorAll('.pane-terminal').forEach(el => {
        (el as HTMLElement).style.pointerEvents = 'none';
      });
    },
    onResizeEnd: (paneId, newRatio) => {
      document.querySelectorAll('.pane-terminal').forEach(el => {
        (el as HTMLElement).style.pointerEvents = '';
      });
      tree = resizePane(tree, paneId, newRatio);
    },
    onPaneClick: (paneId) => {
      setActivePane(paneId);
    },
    onPaneContextMenu: (paneId, x, y) => {
      showContextMenu(paneId, x, y);
    },
  }, activePaneId);
}

// ─── Project Management ──────────────────────────────────────

async function addProject(): Promise<void> {
  const entry = await api.project.add();
  if (entry) {
    await refreshSidebarAndOpen(entry.path);
  }
}

async function createProject(): Promise<void> {
  const entry = await api.project.create();
  if (entry) {
    await refreshSidebarAndOpen(entry.path);
  }
}

async function refreshSidebarAndOpen(projectPath: string): Promise<void> {
  await refreshProjects(sidebarEl, {
    onSelectProject: openProject,
    onAddProject: addProject,
    onCreateProject: createProject,
    onHomeClick: showHomeScreen,
  });
  openProject(projectPath);
}

async function openProject(projectPath: string): Promise<void> {
  // Skip if already on this project
  if (projectPath === currentProjectPath) return;

  const thisGeneration = ++projectSwitchGeneration;

  // Save current project state
  if (currentProjectPath) {
    await saveProjectState();
    if (projectSwitchGeneration !== thisGeneration) return;
    detachAllTerminals();
  }

  // Clear workspace DOM immediately so dead terminals don't linger
  workspaceEl.innerHTML = '';

  currentProjectPath = projectPath;
  setActiveProject(projectPath);

  // Load project config with error handling
  let config;
  try {
    config = await api.project.open(projectPath);
  } catch (err) {
    console.error('[app] Failed to open project:', err);
    if (projectSwitchGeneration !== thisGeneration) return;
    showError('Failed to open project', String(err));
    currentProjectPath = null;
    showHomeScreen();
    return;
  }

  // Bail if another switch happened during the await
  if (projectSwitchGeneration !== thisGeneration) return;

  // Restore layout or create default
  if (config?.layout) {
    try {
      tree = deserializeTree(config.layout);
    } catch (err) {
      console.error('[app] Failed to deserialize layout:', err);
      tree = createLeaf();
    }
  } else {
    tree = createLeaf();
  }

  activePaneId = getLeafIds(tree)[0];
  hideEmptyState();
  renderWorkspace();
  await loadContextPanel();
  updateStatusBar();
}

async function saveProjectState(): Promise<void> {
  if (!currentProjectPath) return;
  const config = {
    layout: serializeTree(tree),
    paneRoles: getPaneRoles(),
  };
  await api.project.saveConfig(currentProjectPath, config);
}

function getPaneRoles(): Record<string, string> {
  const roles: Record<string, string> = {};
  function walk(node: SplitNode) {
    if (node.type === 'leaf' && node.role) {
      roles[node.id] = node.role;
    } else if (node.type === 'split') {
      walk(node.children[0]);
      walk(node.children[1]);
    }
  }
  walk(tree);
  return roles;
}

// ─── Pane Operations ─────────────────────────────────────────

function renderWorkspace(): void {
  if (!currentProjectPath) return;
  const projectPath = currentProjectPath;
  const projectId = currentProjectPath;

  renderPaneTree(tree, workspaceEl, {
    onPaneMount: (paneId, container) => {
      const existing = getTerminalPane(paneId);
      if (existing) {
        // Terminal already exists — refit, repaint, and scroll to bottom after reparenting
        existing.fitAddon.fit();
        existing.term.refresh(0, existing.term.rows - 1);
        existing.term.scrollToBottom();
      } else {
        // Try to reattach to an existing PTY (e.g. after project switch), or spawn fresh
        const leaf = findLeaf(tree, paneId);
        reattachTerminal(paneId, container, projectId, projectPath, leaf?.role, leaf?.rawTerminal).then(() => {
          setPaneStatus(paneId, 'running');
        });
      }
    },
    onPaneUnmount: (paneId) => {
      disposeTerminalPane(paneId);
    },
    onResizeStart: () => {
      // Disable pointer events on terminals during resize
      document.querySelectorAll('.pane-terminal').forEach(el => {
        (el as HTMLElement).style.pointerEvents = 'none';
      });
    },
    onResizeEnd: (paneId, newRatio) => {
      document.querySelectorAll('.pane-terminal').forEach(el => {
        (el as HTMLElement).style.pointerEvents = '';
      });
      tree = resizePane(tree, paneId, newRatio);
    },
    onPaneClick: (paneId) => {
      setActivePane(paneId);
    },
    onPaneContextMenu: (paneId, x, y) => {
      showContextMenu(paneId, x, y);
    },
  }, activePaneId);
}

function splitActivePaneVertical(): void {
  if (!currentProjectPath) return;
  tree = splitPane(tree, activePaneId, 'vertical');
  renderWorkspace();
}

function splitActivePaneHorizontal(): void {
  if (!currentProjectPath) return;
  tree = splitPane(tree, activePaneId, 'horizontal');
  renderWorkspace();
}

function splitActivePaneVerticalRaw(): void {
  if (!currentProjectPath) return;
  tree = splitPaneRaw(tree, activePaneId, 'vertical');
  renderWorkspace();
}

function splitActivePaneHorizontalRaw(): void {
  if (!currentProjectPath) return;
  tree = splitPaneRaw(tree, activePaneId, 'horizontal');
  renderWorkspace();
}

function closeActivePane(): void {
  if (!currentProjectPath) return;
  if (countLeaves(tree) <= 1) return; // Don't close last pane

  disposeTerminalPane(activePaneId);
  const newTree = closePane(tree, activePaneId);
  if (newTree) {
    tree = newTree;
    activePaneId = getLeafIds(tree)[0];
    renderWorkspace();
  }
}

function setActivePane(paneId: string): void {
  activePaneId = paneId;
  updateActiveState();
  focusTerminal(paneId);
  setBurnRatePaneId(paneId);
}

function setActivePaneAndRender(paneId: string): void {
  activePaneId = paneId;
  updateActiveState();
  focusTerminal(paneId);
}

function updateActiveState(): void {
  document.querySelectorAll('.pane-leaf').forEach(el => {
    const id = (el as HTMLElement).dataset.paneId;
    el.classList.toggle('pane-active', id === activePaneId);
  });
}

function navigatePanes(delta: number): void {
  const ids = getLeafIds(tree);
  const idx = ids.indexOf(activePaneId);
  const next = (idx + delta + ids.length) % ids.length;
  setActivePane(ids[next]);
}

function focusPaneByIndex(index: number): void {
  const ids = getLeafIds(tree);
  if (index >= 0 && index < ids.length) {
    setActivePane(ids[index]);
  }
}

// ─── Context Menu (right-click on pane title) ────────────────

function showContextMenu(paneId: string, x: number, y: number): void {
  contextMenuEl.innerHTML = '';
  contextMenuEl.style.display = 'block';
  contextMenuEl.style.left = `${x}px`;
  contextMenuEl.style.top = `${y}px`;

  const leaf = findLeaf(tree, paneId);
  const isRaw = leaf?.rawTerminal;

  // Role assignment (only for Claude panes)
  if (!isRaw) {
    const header = document.createElement('div');
    header.className = 'context-menu-header';
    header.textContent = 'Assign Role';
    contextMenuEl.appendChild(header);

    // No role option
    addMenuItem('None (default)', () => {
      tree = setLeafRole(tree, paneId, undefined);
      renderWorkspace();
    });

    for (const role of roles) {
      addMenuItem(role.label, () => {
        tree = setLeafRole(tree, paneId, role.name);
        // Re-render will respawn with new role
        renderWorkspace();
      }, role.color);
    }

    // Separator
    const sep = document.createElement('div');
    sep.className = 'context-menu-separator';
    contextMenuEl.appendChild(sep);
  }

  addMenuItem('Split Vertical', () => {
    tree = splitPane(tree, paneId, 'vertical');
    renderWorkspace();
  });

  addMenuItem('Split Horizontal', () => {
    tree = splitPane(tree, paneId, 'horizontal');
    renderWorkspace();
  });

  addMenuItem('Split Vertical (Terminal)', () => {
    tree = splitPaneRaw(tree, paneId, 'vertical');
    renderWorkspace();
  });

  addMenuItem('Split Horizontal (Terminal)', () => {
    tree = splitPaneRaw(tree, paneId, 'horizontal');
    renderWorkspace();
  });

  if (countLeaves(tree) > 1) {
    addMenuItem('Close Pane', () => {
      disposeTerminalPane(paneId);
      const newTree = closePane(tree, paneId);
      if (newTree) {
        tree = newTree;
        if (activePaneId === paneId) {
          activePaneId = getLeafIds(tree)[0];
        }
        renderWorkspace();
      }
    });
  }
}

function addMenuItem(label: string, onClick: () => void, color?: string): void {
  const item = document.createElement('div');
  item.className = 'context-menu-item';
  if (color) {
    const dot = document.createElement('span');
    dot.className = 'context-menu-dot';
    dot.style.backgroundColor = color;
    item.appendChild(dot);
  }
  const text = document.createElement('span');
  text.textContent = label;
  item.appendChild(text);
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    contextMenuEl.style.display = 'none';
    onClick();
  });
  contextMenuEl.appendChild(item);
}

// ─── Context Panel ───────────────────────────────────────────

async function loadContextPanel(): Promise<void> {
  if (!currentProjectPath) return;

  const tasksEl = document.getElementById('tasks-list')!;
  const researchEl = document.getElementById('research-content')!;
  const artifactsEl = document.getElementById('artifacts-list')!;

  // Load tasks
  const tasks = await api.tasks.load(currentProjectPath);
  tasksEl.innerHTML = '';
  if (tasks.length === 0) {
    tasksEl.innerHTML = '<div class="panel-empty">No tasks yet</div>';
  } else {
    for (const task of tasks) {
      const item = document.createElement('div');
      item.className = `task-item task-${task.status}`;
      item.innerHTML = `<span class="task-status">${task.status === 'done' ? '&#10003;' : '&#9675;'}</span> ${task.title}`;
      tasksEl.appendChild(item);
    }
  }

  // Load research
  const research = await api.research.load(currentProjectPath);
  researchEl.textContent = research || 'No research notes yet';

  // Load artifacts
  const artifacts = await api.artifacts.list(currentProjectPath);
  artifactsEl.innerHTML = '';
  if (artifacts.length === 0) {
    artifactsEl.innerHTML = '<div class="panel-empty">No artifacts yet</div>';
  } else {
    for (const name of artifacts) {
      const item = document.createElement('div');
      item.className = 'artifact-item';
      item.textContent = name;
      artifactsEl.appendChild(item);
    }
  }

  // Load activity feed
  await loadActivityFeed();

  // Detect dev server script
  await detectDevServer();
}

// ─── Dev Server ───────────────────────────────────────────────

let devServerScript: string | null = null;
let devServerRunning = false;
let devServerUrl: string | null = null;

function renderDevServerButton(): void {
  // Remove existing button if any
  const existing = document.getElementById('dev-server-btn');
  if (existing) existing.remove();

  if (!devServerScript) return;

  const feedSection = document.querySelector('.panel-section-feed');
  if (!feedSection) return;

  const btn = document.createElement('button');
  btn.id = 'dev-server-btn';
  btn.className = 'feed-action-btn dev-server-btn';

  updateDevServerButtonState(btn);

  btn.addEventListener('click', async () => {
    if (!currentProjectPath) return;
    if (devServerRunning && devServerUrl) {
      // Open in browser
      await api.devServer.openUrl(devServerUrl);
    } else if (devServerRunning) {
      // Stop it
      await api.devServer.stop(currentProjectPath);
    } else {
      // Start it
      await api.devServer.start(currentProjectPath, devServerScript!);
      devServerRunning = true;
      updateDevServerButtonState(btn);
    }
  });

  feedSection.appendChild(btn);
}

function updateDevServerButtonState(btn?: HTMLElement): void {
  const el = btn ?? document.getElementById('dev-server-btn');
  if (!el) return;

  if (devServerRunning && devServerUrl) {
    el.textContent = `[dev server · ${devServerUrl.replace('http://', '')}]`;
    el.title = `Open ${devServerUrl} in browser (⇧⌘D)`;
    el.classList.add('dev-server-running');
  } else if (devServerRunning) {
    el.textContent = '[dev server starting…]';
    el.title = 'Dev server is starting…';
    el.classList.add('dev-server-running');
  } else {
    el.textContent = '[start dev server]';
    el.title = `Run npm run ${devServerScript} (⇧⌘D)`;
    el.classList.remove('dev-server-running');
  }
}

async function detectDevServer(): Promise<void> {
  if (!currentProjectPath) {
    devServerScript = null;
    devServerRunning = false;
    devServerUrl = null;
    renderDevServerButton();
    return;
  }

  // Check if already running
  const status = await api.devServer.status(currentProjectPath);
  if (status.running) {
    devServerRunning = true;
    devServerUrl = status.url;
    devServerScript = status.script;
    renderDevServerButton();
    return;
  }

  // Detect available script
  const detected = await api.devServer.detect(currentProjectPath);
  devServerScript = detected?.script ?? null;
  devServerRunning = false;
  devServerUrl = null;
  renderDevServerButton();
}

async function toggleDevServer(): Promise<void> {
  if (!currentProjectPath || !devServerScript) return;

  if (devServerRunning) {
    await api.devServer.stop(currentProjectPath);
    devServerRunning = false;
    devServerUrl = null;
    updateDevServerButtonState();
  } else {
    await api.devServer.start(currentProjectPath, devServerScript);
    devServerRunning = true;
    updateDevServerButtonState();
  }
}

// ─── Activity Feed ────────────────────────────────────────────

const FEED_MAX_VISIBLE = 50;
let feedFilters: Set<string> = new Set(['critical', 'warn', 'info', 'success']);
let feedUnackedCount = 0;

interface FeedNotification {
  id: string;
  paneId: string;
  projectId: string;
  role: string;
  type: string;
  severity: 'critical' | 'warn' | 'info' | 'success';
  title: string;
  detail?: string;
  timestamp: string;
  acked: boolean;
  snoozedUntil?: string;
}

function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function renderFeedItem(notif: FeedNotification): HTMLElement {
  const item = document.createElement('div');
  item.className = 'feed-item';
  item.dataset.id = notif.id;
  item.dataset.severity = notif.severity;
  if (notif.acked) item.classList.add('feed-acked');
  if (!feedFilters.has(notif.severity)) item.classList.add('feed-hidden');

  // Severity dot
  const dot = document.createElement('span');
  dot.className = `feed-dot feed-dot-${notif.severity}`;
  item.appendChild(dot);

  // Body
  const body = document.createElement('div');
  body.className = 'feed-body';

  // Title
  const title = document.createElement('div');
  title.className = 'feed-title';
  title.textContent = notif.title;
  body.appendChild(title);

  // Meta line
  const meta = document.createElement('div');
  meta.className = 'feed-meta';

  // Role
  if (notif.role && notif.role !== 'default' && notif.role !== 'system') {
    const roleSpan = document.createElement('span');
    roleSpan.className = 'feed-role';
    roleSpan.dataset.role = notif.role;
    roleSpan.textContent = notif.role;
    meta.appendChild(roleSpan);
    meta.appendChild(createSeparator());
  }

  // Severity label
  const sevSpan = document.createElement('span');
  sevSpan.className = `feed-severity feed-severity-${notif.severity}`;
  sevSpan.textContent = notif.severity.toUpperCase();
  meta.appendChild(sevSpan);

  meta.appendChild(createSeparator());

  // Relative time
  const timeSpan = document.createElement('span');
  timeSpan.className = 'feed-time';
  timeSpan.dataset.timestamp = notif.timestamp;
  timeSpan.textContent = relativeTime(notif.timestamp);
  meta.appendChild(timeSpan);

  // Detail
  if (notif.detail) {
    meta.appendChild(createSeparator());
    const detailSpan = document.createElement('span');
    detailSpan.textContent = notif.detail;
    detailSpan.style.overflow = 'hidden';
    detailSpan.style.textOverflow = 'ellipsis';
    detailSpan.style.whiteSpace = 'nowrap';
    meta.appendChild(detailSpan);
  }

  body.appendChild(meta);
  item.appendChild(body);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'feed-actions';

  if (!notif.acked) {
    const ackBtn = document.createElement('button');
    ackBtn.className = 'feed-action-btn';
    ackBtn.textContent = '[ack]';
    ackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentProjectPath) {
        api.notifications.ack(notif.id, currentProjectPath);
        item.classList.add('feed-acked');
        ackBtn.remove();
        if (notif.severity === 'critical') {
          feedUnackedCount = Math.max(0, feedUnackedCount - 1);
          updateFeedBadge();
        }
      }
    });
    actions.appendChild(ackBtn);
  }

  if (notif.severity === 'critical' || notif.severity === 'warn') {
    const snoozeBtn = document.createElement('button');
    snoozeBtn.className = 'feed-action-btn';
    const snoozeDuration = notif.severity === 'critical' ? '[snooze 1h]' : '[snooze]';
    const snoozeMs = notif.severity === 'critical' ? 3600000 : 1800000;
    snoozeBtn.textContent = snoozeDuration;
    snoozeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentProjectPath) {
        api.notifications.snooze(notif.id, currentProjectPath, snoozeMs);
        item.style.animation = 'none';
        item.style.opacity = '0';
        item.style.transform = 'translateY(-6px)';
        item.style.transition = 'all 0.2s ease-out';
        setTimeout(() => item.remove(), 200);
        if (notif.severity === 'critical') {
          feedUnackedCount = Math.max(0, feedUnackedCount - 1);
          updateFeedBadge();
        }
      }
    });
    actions.appendChild(snoozeBtn);
  }

  item.appendChild(actions);
  return item;
}

function createSeparator(): HTMLElement {
  const sep = document.createElement('span');
  sep.className = 'feed-separator';
  sep.textContent = '\u00b7';
  return sep;
}

function updateFeedBadge(): void {
  const badge = document.getElementById('feed-badge')!;
  if (feedUnackedCount > 0) {
    badge.textContent = String(feedUnackedCount);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

async function loadActivityFeed(): Promise<void> {
  if (!currentProjectPath) return;
  const feedEl = document.getElementById('activity-feed')!;
  feedEl.innerHTML = '';

  try {
    const snapshot = await api.notifications.getSnapshot(currentProjectPath);
    feedUnackedCount = snapshot.unackedCount;
    updateFeedBadge();

    const items = snapshot.notifications.slice(0, FEED_MAX_VISIBLE);
    for (const notif of items) {
      feedEl.appendChild(renderFeedItem(notif as FeedNotification));
    }

    if (items.length === 0) {
      feedEl.innerHTML = '<div class="panel-empty">No activity yet</div>';
    }
  } catch {
    feedEl.innerHTML = '<div class="panel-empty">No activity yet</div>';
  }
}

function initActivityFeed(): void {
  // Subscribe to real-time notifications
  api.notifications.onNew((event) => {
    const feedEl = document.getElementById('activity-feed');
    if (!feedEl) return;

    // Remove empty placeholder
    const empty = feedEl.querySelector('.panel-empty');
    if (empty) empty.remove();

    const item = renderFeedItem(event as FeedNotification);
    feedEl.prepend(item);

    // Trim to max visible
    while (feedEl.children.length > FEED_MAX_VISIBLE) {
      feedEl.removeChild(feedEl.lastChild!);
    }

    // Only show badge for critical/severe errors
    if ((event as FeedNotification).severity === 'critical') {
      feedUnackedCount++;
      updateFeedBadge();
    }
  });

  // Filter buttons
  const filterBtns = document.querySelectorAll('.feed-filter-btn');
  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const severity = (btn as HTMLElement).dataset.severity!;

      if (severity === 'all') {
        // Toggle all
        const allActive = feedFilters.size === 4;
        if (allActive) {
          feedFilters.clear();
          filterBtns.forEach((b) => b.classList.remove('feed-filter-active'));
        } else {
          feedFilters = new Set(['critical', 'warn', 'info', 'success']);
          filterBtns.forEach((b) => b.classList.add('feed-filter-active'));
        }
      } else {
        if (feedFilters.has(severity)) {
          feedFilters.delete(severity);
          btn.classList.remove('feed-filter-active');
        } else {
          feedFilters.add(severity);
          btn.classList.add('feed-filter-active');
        }
        // Update "all" button state
        const allBtn = document.querySelector('.feed-filter-btn[data-severity="all"]');
        if (allBtn) {
          allBtn.classList.toggle('feed-filter-active', feedFilters.size === 4);
        }
      }

      // Apply filters to visible items
      applyFeedFilters();
    });
  });

  // Bulk action buttons
  document.getElementById('feed-ack-all-crit')?.addEventListener('click', () => {
    if (!currentProjectPath) return;
    api.notifications.ackAllCritical(currentProjectPath);
    document.querySelectorAll('.feed-item[data-severity="critical"]').forEach((el) => {
      el.classList.add('feed-acked');
      el.querySelector('.feed-action-btn')?.remove();
    });
    loadActivityFeed(); // Refresh count
  });

  document.getElementById('feed-ack-all')?.addEventListener('click', () => {
    if (!currentProjectPath) return;
    api.notifications.ackAll(currentProjectPath);
    document.querySelectorAll('.feed-item').forEach((el) => {
      el.classList.add('feed-acked');
      const ackBtn = el.querySelector('.feed-action-btn');
      if (ackBtn?.textContent === '[ack]') ackBtn.remove();
    });
    feedUnackedCount = 0;
    updateFeedBadge();
  });

  document.getElementById('feed-clear')?.addEventListener('click', () => {
    if (!currentProjectPath) return;
    api.notifications.clear(currentProjectPath);
    const feedEl = document.getElementById('activity-feed')!;
    feedEl.innerHTML = '<div class="panel-empty">No activity yet</div>';
    feedUnackedCount = 0;
    updateFeedBadge();
  });

  // Collapse toggle — click the "Activity" text
  const feedSection = document.querySelector('.panel-section-feed');
  const headerText = feedSection?.querySelector('.feed-header > span:first-child');
  headerText?.addEventListener('click', () => {
    feedSection?.classList.toggle('feed-section-collapsed');
  });

  // Relative time updater — refresh every 60s
  setInterval(() => {
    document.querySelectorAll('.feed-time').forEach((el) => {
      const ts = (el as HTMLElement).dataset.timestamp;
      if (ts) (el as HTMLElement).textContent = relativeTime(ts);
    });
  }, 60000);
}

function applyFeedFilters(): void {
  document.querySelectorAll('.feed-item').forEach((el) => {
    const severity = (el as HTMLElement).dataset.severity;
    if (severity && !feedFilters.has(severity)) {
      el.classList.add('feed-hidden');
    } else {
      el.classList.remove('feed-hidden');
    }
  });
}

function togglePanel(): void {
  panelVisible = !panelVisible;
  panelEl.style.display = panelVisible ? '' : 'none';
  panelHandle.style.display = panelVisible ? '' : 'none';
  // Update toggle button state in status bar
  const btn = document.getElementById('status-panel-toggle');
  if (btn) btn.classList.toggle('panel-hidden', !panelVisible);
}

function flipPanelPosition(): void {
  panelBottom = !panelBottom;
  mainContainer.classList.toggle('panel-bottom', panelBottom);
}

// ─── Status Bar ──────────────────────────────────────────────

function updateStatusBar(): void {
  const projectName = currentProjectPath ? currentProjectPath.split('/').pop() : 'No project';
  const paneCount = currentProjectPath ? countLeaves(tree) : 0;
  statusBar.innerHTML = `
    <span class="status-project">${projectName}</span>
    <span class="status-panes">${paneCount} pane${paneCount !== 1 ? 's' : ''}</span>
    <span class="status-tokens" id="status-tokens"></span>
    <span id="status-panel-toggle" class="status-panel-toggle${panelVisible ? '' : ' panel-hidden'}" title="Toggle panel (Cmd+B)">panel</span>
  `;
  // Click token stats to toggle burn rate popup
  const tokensEl = document.getElementById('status-tokens');
  if (tokensEl) {
    tokensEl.addEventListener('click', () => toggleBurnRatePopup());
  }
  const panelToggle = document.getElementById('status-panel-toggle');
  if (panelToggle) {
    panelToggle.addEventListener('click', () => togglePanel());
  }
}

function updateStatusBarTokens(snapshot: any): void {
  const el = document.getElementById('status-tokens');
  if (!el || !snapshot) return;
  el.textContent = formatTokenStats(snapshot);
}

// ─── Research ────────────────────────────────────────────────

async function saveSelectionToResearch(): Promise<void> {
  if (!currentProjectPath) return;
  const selection = window.getSelection()?.toString();
  if (selection) {
    await api.research.append(currentProjectPath, selection);
    await loadContextPanel();
  }
}

// ─── Preferences ─────────────────────────────────────────────

async function showPreferences(): Promise<void> {
  const prefs = await api.prefs.load();
  const themes = getThemes();
  const themeOptions = themes.map(t =>
    `<option value="${t.id}" ${prefs.theme === t.id ? 'selected' : ''}>${t.name}</option>`
  ).join('');

  const overlay = document.createElement('div');
  overlay.className = 'prefs-overlay';
  overlay.innerHTML = `
    <div class="prefs-dialog">
      <h2>Preferences</h2>
      <label>Font Size<input type="number" id="pref-font" value="${prefs.fontSize}" min="8" max="24"></label>
      <label>Theme
        <select id="pref-theme">${themeOptions}</select>
      </label>
      <div class="prefs-actions">
        <button id="pref-cancel">Cancel</button>
        <button id="pref-save">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('pref-cancel')!.addEventListener('click', () => overlay.remove());
  document.getElementById('pref-save')!.addEventListener('click', async () => {
    const themeId = (document.getElementById('pref-theme') as HTMLSelectElement).value;
    const newPrefs = {
      ...prefs,
      fontSize: parseInt((document.getElementById('pref-font') as HTMLInputElement).value),
      theme: themeId,
    };
    applyTheme(themeId);
    updateAllTerminalThemes(themeId);
    await api.prefs.save(newPrefs);
    overlay.remove();
  });
}

// ─── Theme Button ────────────────────────────────────────

function renderThemeButton(): void {
  const titleBar = document.querySelector('.title-bar-drag');
  if (!titleBar) return;

  const btn = document.createElement('button');
  btn.className = 'theme-btn';
  btn.textContent = '[theme]';
  btn.title = 'Switch theme';

  // Insert before dock-back button if present, otherwise append
  const dockBtn = titleBar.querySelector('.dock-back-btn');
  if (dockBtn) {
    titleBar.insertBefore(btn, dockBtn);
  } else {
    titleBar.appendChild(btn);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleThemeDropdown(btn);
  });
}

function toggleThemeDropdown(anchorBtn: HTMLElement): void {
  const existing = document.getElementById('theme-dropdown');
  if (existing) {
    existing.remove();
    return;
  }

  const dropdown = document.createElement('div');
  dropdown.id = 'theme-dropdown';
  dropdown.className = 'theme-dropdown';

  const themes = getThemes();
  const currentId = getCurrentThemeId();

  for (const theme of themes) {
    const item = document.createElement('div');
    item.className = 'theme-dropdown-item';
    if (theme.id === currentId) item.classList.add('theme-dropdown-active');

    // Color swatch bar
    const swatch = document.createElement('div');
    swatch.className = 'theme-swatch';
    const colors = [theme.preview.bg, theme.preview.surface, theme.preview.accent, theme.preview.text];
    for (const color of colors) {
      const bar = document.createElement('div');
      bar.className = 'theme-swatch-bar';
      bar.style.background = color;
      swatch.appendChild(bar);
    }
    item.appendChild(swatch);

    const name = document.createElement('span');
    name.className = 'theme-dropdown-name';
    name.textContent = theme.name;
    item.appendChild(name);

    if (theme.id === currentId) {
      const check = document.createElement('span');
      check.className = 'theme-dropdown-check';
      check.textContent = '\u2713';
      item.appendChild(check);
    }

    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      applyTheme(theme.id);
      updateAllTerminalThemes(theme.id);
      const prefs = await api.prefs.load();
      await api.prefs.save({ ...prefs, theme: theme.id });
      dropdown.remove();
    });

    dropdown.appendChild(item);
  }

  // Position dropdown below the button
  const rect = anchorBtn.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.right = `${window.innerWidth - rect.right}px`;

  document.body.appendChild(dropdown);

  // Dismiss on click outside
  const dismiss = (e: MouseEvent) => {
    if (!dropdown.contains(e.target as Node) && e.target !== anchorBtn) {
      dropdown.remove();
      document.removeEventListener('click', dismiss);
    }
  };
  // Use setTimeout to avoid the current click event triggering dismiss
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

// ─── Home Screen ──────────────────────────────────────────

function showHomeScreen(): void {
  homeScreenActive = true;
  setBurnRatePaneId(null);
  // Save project state but do NOT dispose terminals — they keep running
  if (currentProjectPath) {
    saveProjectState();
  }
  setActiveProject(null);
  setHomeActive(true);
  workspaceEl.style.display = 'none';
  panelEl.style.display = 'none';
  panelHandle.style.display = 'none';
  emptyState.style.display = 'none';

  renderHomeScreen(emptyState, navigateToPane);
  emptyState.style.display = 'flex';
  updateStatusBar();
}

function navigateToPane(projectId: string, paneId: string): void {
  homeScreenActive = false;
  setHomeActive(false);
  destroyHomeScreen();

  if (projectId === currentProjectPath) {
    // Same project — just restore the view without re-opening
    hideEmptyState();
    setActiveProject(projectId);
    renderWorkspace();
    loadContextPanel();
    updateStatusBar();
    setActivePaneAndRender(paneId);
    // Single delayed refit after layout fully settles — the workspace was
    // display:none and the browser needs time to recalculate dimensions.
    // Using setTimeout instead of double-RAF to avoid competing with
    // the per-pane fit() calls that fire from onPaneMount/ResizeObserver.
    setTimeout(() => {
      fitAllTerminals();
    }, 50);
  } else {
    // Different project — full open (this will dispose current terminals)
    openProject(projectId).then(() => {
      setActivePaneAndRender(paneId);
    });
  }
}

// ─── Empty State ─────────────────────────────────────────────

function showEmptyState(): void {
  showHomeScreen();
}

function hideEmptyState(): void {
  homeScreenActive = false;
  setHomeActive(false);
  destroyHomeScreen();
  emptyState.style.display = 'none';
  workspaceEl.style.display = '';
  panelEl.style.display = panelVisible ? '' : 'none';
  panelHandle.style.display = panelVisible ? '' : 'none';
}

function showError(title: string, message: string): void {
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.innerHTML = `<strong>${title}</strong><p>${message}</p>`;
  document.body.prepend(banner);
  setTimeout(() => banner.remove(), 10000);
}

// ─── Helpers ─────────────────────────────────────────────────

function findLeaf(node: SplitNode, id: string): (SplitNode & { type: 'leaf' }) | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findLeaf(node.children[0], id) || findLeaf(node.children[1], id);
}

// ─── Resize Handles (sidebar + context panel) ───────────────

function initResizeHandles(): void {
  setupEdgeResize(sidebarHandle, sidebarEl, 'left', 36, 280);
  setupEdgeResize(panelHandle, panelEl, 'right', 140, 600);
}

function setupEdgeResize(
  handle: HTMLElement,
  target: HTMLElement,
  side: 'left' | 'right',
  minPx: number,
  maxPx: number,
): void {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    document.body.classList.add('panel-resizing');

    const startX = e.clientX;
    const startWidth = target.getBoundingClientRect().width;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = side === 'left'
        ? startWidth + delta
        : startWidth - delta;
      target.style.width = `${Math.max(minPx, Math.min(maxPx, newWidth))}px`;
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('panel-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── Boot ────────────────────────────────────────────────────

init().catch(console.error);
