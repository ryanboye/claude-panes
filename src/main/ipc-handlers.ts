/**
 * IPC bridge between main process and renderer.
 * Handles PTY operations, project management, and state queries.
 */

import { ipcMain, dialog, Notification, BrowserWindow, screen, shell } from 'electron';
import { PtyManager } from './pty-manager';
import { CostTracker } from './cost-tracker';
import { TokenTracker } from './token-tracker';
import { StuckDetector } from './stuck-detector';
import { ActivityDetector } from './activity-detector';
import { NotificationStore } from './notification-store';
import { WindowManager } from './window-manager';
import type { ActivityEvent } from './activity-detector';
import { getRole, AGENT_ROLES, getRoleNames } from './agent-config';
import { buildSystemPrompt } from './context-builder';
import * as store from './project-store';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn, ChildProcess } from 'child_process';

export function registerIpcHandlers(
  ptyManager: PtyManager,
  costTracker: CostTracker,
  tokenTracker: TokenTracker,
  stuckDetector: StuckDetector,
  windowManager: WindowManager,
): void {
  const getMainWindow = () => windowManager.getMainWindow();
  // ─── Notification System ──────────────────────────────────────

  const notificationStore = new NotificationStore((event: ActivityEvent) => {
    const win = windowManager.getWindowForProject(event.projectId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('notification:new', event);
    }
    // Persist to disk
    try {
      store.appendNotification(event.projectId, event as unknown as Record<string, unknown>);
    } catch {
      // Non-critical — don't crash on write failure
    }
  });

  const activityDetector = new ActivityDetector((event: ActivityEvent) => {
    notificationStore.push(event);
  });

  // ─── Dashboard ────────────────────────────────────────────

  ipcMain.handle('dashboard:snapshot', () => {
    const sessions = ptyManager.getAllSessions();
    const panes: Array<{
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
      spawnedAt: number;
      currentTokPerSec: number;
      avgTokPerSec: number;
      peakTokPerSec: number;
      elapsed: number;
      activity: string;
      isActiveBurn: boolean;
      histogram: number[];
      activityTimeline: string[];
    }> = [];
    for (const [key, session] of sessions) {
      const snap = tokenTracker.getSnapshot(session.paneId);
      panes.push({
        paneId: session.paneId,
        projectId: session.projectId,
        projectName: session.projectId.split('/').pop() ?? session.projectId,
        role: session.role,
        costUsd: 0,
        totalTokens: snap?.totalTokens ?? tokenTracker.getPaneTotal(session.paneId),
        isAlive: session.alive,
        isStuck: stuckDetector.isStuck(session.paneId),
        stuckQuestion: stuckDetector.getStuckContext(session.paneId),
        lastActivity: ptyManager.getLastOutputLine(key),
        spawnedAt: session.spawnedAt,
        currentTokPerSec: snap?.currentTokPerSec ?? 0,
        avgTokPerSec: snap?.avgTokPerSec ?? 0,
        peakTokPerSec: snap?.peakTokPerSec ?? 0,
        elapsed: snap?.elapsed ?? 0,
        activity: snap?.activity ?? 'idle',
        isActiveBurn: tokenTracker.isActivelyBurning(session.paneId),
        histogram: snap?.histogram ?? [],
        activityTimeline: snap?.activityTimeline ?? [],
      });
    }
    return panes;
  });

  ipcMain.handle('stuck:clear', (_event, paneId: string) => {
    stuckDetector.clearStuck(paneId);
    return true;
  });

  // Throttled activity event: forward PTY activity to dashboard (max 1/sec)
  let lastActivityBroadcast = 0;
  const ACTIVITY_THROTTLE_MS = 1000;

  function maybeBroadcastActivity(): void {
    const now = Date.now();
    if (now - lastActivityBroadcast < ACTIVITY_THROTTLE_MS) return;
    lastActivityBroadcast = now;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('dashboard:paneActivity');
    }
  }

  // ─── PTY Operations ────────────────────────────────────────

  ipcMain.handle('pty:spawn', (_event, opts: {
    paneId: string;
    projectId: string;
    cwd: string;
    cols: number;
    rows: number;
    role?: string;
    rawTerminal?: boolean;
  }) => {
    const role = opts.role ? getRole(opts.role) : undefined;
    const contextSources = opts.rawTerminal ? undefined : {
      role,
      projectDir: opts.cwd,
    };

    const session = ptyManager.spawn({
      paneId: opts.paneId,
      projectId: opts.projectId,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      role: opts.role,
      rawTerminal: opts.rawTerminal,
      contextSources,
    });

    if (!session) return false;

    // Wire data events to renderer — route to correct window
    session.onData = (data: string) => {
      const win = windowManager.getWindowForProject(opts.projectId);
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:data', opts.paneId, data);
      }
      // Also send to main window for dashboard updates if project is detached
      if (windowManager.isDetached(opts.projectId)) {
        const main = getMainWindow();
        if (main && !main.isDestroyed()) {
          main.webContents.send('dashboard:paneActivity');
        }
      }
      // Feed through cost tracker, stuck detector, and activity detector
      costTracker.parseOutput(opts.paneId, opts.projectId, data);
      tokenTracker.parseOutput(opts.paneId, opts.projectId, data);
      stuckDetector.feed(opts.paneId, data);
      activityDetector.feed(opts.paneId, opts.projectId, opts.role ?? 'default', data);
      maybeBroadcastActivity();
    };

    session.onExit = (code: number) => {
      const win = windowManager.getWindowForProject(opts.projectId);
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:exit', opts.paneId, code);
      }
      // Log event
      store.appendEvent(opts.cwd, {
        type: 'pane_exit',
        timestamp: new Date().toISOString(),
        data: { paneId: opts.paneId, exitCode: code },
      });
      // Push lifecycle notification
      notificationStore.pushSynthetic({
        paneId: opts.paneId,
        projectId: opts.projectId,
        role: opts.role ?? 'default',
        type: 'lifecycle',
        severity: code === 0 ? 'info' : 'warn',
        title: code === 0
          ? `${opts.role ?? 'agent'} exited`
          : `${opts.role ?? 'agent'} exited (code ${code})`,
      });
    };

    // Log spawn event
    store.appendEvent(opts.cwd, {
      type: 'pane_spawn',
      timestamp: new Date().toISOString(),
      data: { paneId: opts.paneId, role: opts.role },
    });

    // Push lifecycle notification
    notificationStore.pushSynthetic({
      paneId: opts.paneId,
      projectId: opts.projectId,
      role: opts.role ?? 'default',
      type: 'lifecycle',
      severity: 'info',
      title: `${opts.role ?? 'agent'} spawned`,
    });

    return true;
  });

  ipcMain.on('pty:write', (_event, paneId: string, projectId: string, data: string) => {
    ptyManager.write(projectId, paneId, data);
  });

  ipcMain.on('pty:resize', (_event, paneId: string, projectId: string, cols: number, rows: number) => {
    ptyManager.resize(projectId, paneId, cols, rows);
  });

  ipcMain.on('pty:kill', (_event, paneId: string, projectId: string) => {
    ptyManager.kill(projectId, paneId);
    costTracker.removePaneCost(paneId);
    tokenTracker.removePaneData(paneId);
    stuckDetector.removePaneBuffer(paneId);
    activityDetector.removePaneState(paneId);
  });

  ipcMain.handle('pty:getBuffer', (_event, paneId: string, projectId: string) => {
    return ptyManager.getOutputBuffer(projectId, paneId);
  });

  ipcMain.handle('pty:isAlive', (_event, paneId: string, projectId: string) => {
    const session = ptyManager.getSession(projectId, paneId);
    return session?.alive ?? false;
  });

  // ─── Notifications ────────────────────────────────────────

  ipcMain.handle('notification:snapshot', (_event, projectPath: string) => {
    return notificationStore.getSnapshot(projectPath);
  });

  ipcMain.handle('notification:ack', (_event, id: string, projectPath: string) => {
    return notificationStore.ack(id, projectPath);
  });

  ipcMain.handle('notification:ackAll', (_event, projectPath: string) => {
    notificationStore.ackAll(projectPath);
    return true;
  });

  ipcMain.handle('notification:ackAllCritical', (_event, projectPath: string) => {
    notificationStore.ackAllCritical(projectPath);
    return true;
  });

  ipcMain.handle('notification:snooze', (_event, id: string, projectPath: string, durationMs: number) => {
    return notificationStore.snooze(id, projectPath, durationMs);
  });

  ipcMain.handle('notification:clear', (_event, projectPath: string) => {
    notificationStore.clearAll(projectPath);
    return true;
  });

  // ─── Project Operations ────────────────────────────────────

  ipcMain.handle('project:list', () => {
    return store.loadProjects();
  });

  ipcMain.handle('project:add', async () => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Project Folder',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const entry = store.addProject(result.filePaths[0]);
    store.initProjectState(entry.path);
    return entry;
  });

  ipcMain.handle('project:remove', (_event, projectPath: string) => {
    store.removeProject(projectPath);
    return true;
  });

  ipcMain.handle('project:open', (_event, projectPath: string) => {
    store.touchProject(projectPath);
    store.initProjectState(projectPath);
    // Load persisted notifications
    try {
      const events = store.loadNotifications(projectPath) as unknown as ActivityEvent[];
      if (events.length > 0) {
        notificationStore.loadFromArray(projectPath, events);
      }
    } catch {
      // Non-critical
    }
    return store.loadProjectConfig(projectPath);
  });

  ipcMain.handle('project:saveConfig', (_event, projectPath: string, config: store.ProjectConfig) => {
    store.saveProjectConfig(projectPath, config);
    // Compact notifications on project save
    try {
      const events = notificationStore.getAll(projectPath);
      if (events.length > 0) {
        store.compactNotifications(
          projectPath,
          events.slice(0, 500) as unknown as Record<string, unknown>[],
        );
      }
    } catch {
      // Non-critical
    }
    return true;
  });

  // ─── Tasks ─────────────────────────────────────────────────

  ipcMain.handle('tasks:load', (_event, projectPath: string) => {
    return store.loadTasks(projectPath);
  });

  ipcMain.handle('tasks:save', (_event, projectPath: string, tasks: store.ProjectTask[]) => {
    store.saveTasks(projectPath, tasks);
    return true;
  });

  // ─── Research ──────────────────────────────────────────────

  ipcMain.handle('research:load', (_event, projectPath: string) => {
    return store.loadResearch(projectPath);
  });

  ipcMain.handle('research:append', (_event, projectPath: string, content: string) => {
    store.appendResearch(projectPath, content);
    return true;
  });

  // ─── Artifacts ─────────────────────────────────────────────

  ipcMain.handle('artifacts:list', (_event, projectPath: string) => {
    return store.listArtifacts(projectPath);
  });

  // ─── Agent Roles ───────────────────────────────────────────

  ipcMain.handle('roles:list', () => {
    return Object.values(AGENT_ROLES).map(r => ({
      name: r.name,
      label: r.label,
      color: r.color,
    }));
  });

  // ─── Cost ──────────────────────────────────────────────────

  ipcMain.handle('cost:pane', (_event, paneId: string) => {
    return costTracker.getPaneCost(paneId);
  });

  ipcMain.handle('cost:project', (_event, projectId: string) => {
    return costTracker.getProjectCost(projectId);
  });

  ipcMain.handle('cost:global', () => {
    return costTracker.getGlobalCost();
  });

  ipcMain.handle('cost:isAtWarning', () => {
    return costTracker.isAtWarning();
  });

  ipcMain.handle('cost:isAtCeiling', () => {
    return costTracker.isAtCeiling();
  });

  // ─── Tokens ─────────────────────────────────────────────────

  ipcMain.handle('tokens:snapshot', (_event, paneId: string) => {
    return tokenTracker.getSnapshot(paneId);
  });

  ipcMain.handle('tokens:paneTotal', (_event, paneId: string) => {
    return tokenTracker.getPaneTotal(paneId);
  });

  // ─── Preferences ───────────────────────────────────────────

  ipcMain.handle('prefs:load', () => {
    return store.loadPreferences();
  });

  ipcMain.handle('prefs:save', (_event, prefs: store.AppPreferences) => {
    store.savePreferences(prefs);
    costTracker.setGlobalCeiling(prefs.costCeilingUsd);
    return true;
  });

  // ─── Window Management ────────────────────────────────────

  ipcMain.handle('window:detach', (_event, projectPath: string) => {
    const cursor = screen.getCursorScreenPoint();
    windowManager.detachProject(projectPath, cursor.x, cursor.y);
    return true;
  });

  ipcMain.handle('window:isDetached', (_event, projectPath: string) => {
    return windowManager.isDetached(projectPath);
  });

  ipcMain.handle('window:getDetachedProjects', () => {
    return windowManager.getDetachedProjectPaths();
  });

  ipcMain.handle('window:focus', (_event, projectPath: string) => {
    windowManager.focusDetached(projectPath);
    return true;
  });

  ipcMain.handle('window:getCursorScreenPoint', () => {
    return screen.getCursorScreenPoint();
  });

  ipcMain.handle('window:getWindowBounds', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  });

  ipcMain.handle('window:getMode', () => {
    // Detached windows get this from URL params, but provide fallback
    return { detached: false, projectPath: null };
  });

  // ─── Dev Server Detection & Management ─────────────────────

  const DEV_SCRIPT_NAMES = ['dev', 'start', 'serve', 'develop'];
  const devServerProcesses = new Map<string, { proc: ChildProcess; url: string | null; script: string }>();

  ipcMain.handle('devserver:detect', (_event, projectPath: string) => {
    const pkgPath = join(projectPath, 'package.json');
    if (!existsSync(pkgPath)) return null;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (!pkg.scripts) return null;
      for (const name of DEV_SCRIPT_NAMES) {
        if (pkg.scripts[name]) {
          return { script: name, command: pkg.scripts[name] };
        }
      }
      return null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('devserver:start', (_event, projectPath: string, scriptName: string) => {
    if (devServerProcesses.has(projectPath)) return { ok: false, reason: 'already running' };

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(npmCmd, ['run', scriptName], {
      cwd: projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const entry = { proc, url: null as string | null, script: scriptName };
    devServerProcesses.set(projectPath, entry);

    // Scan output for localhost URLs
    const urlPattern = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/;
    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      if (!entry.url) {
        const match = text.match(urlPattern);
        if (match) {
          entry.url = match[0].replace('0.0.0.0', 'localhost');
          // Notify renderer
          const win = windowManager.getWindowForProject(projectPath) ?? getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('devserver:status', projectPath, 'running', entry.url);
          }
        }
      }
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);

    proc.on('exit', () => {
      devServerProcesses.delete(projectPath);
      const win = windowManager.getWindowForProject(projectPath) ?? getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('devserver:status', projectPath, 'stopped', null);
      }
    });

    return { ok: true };
  });

  ipcMain.handle('devserver:stop', (_event, projectPath: string) => {
    const entry = devServerProcesses.get(projectPath);
    if (!entry) return false;
    entry.proc.kill('SIGTERM');
    // Force kill after 5s if needed
    setTimeout(() => {
      try { entry.proc.kill('SIGKILL'); } catch { /* already dead */ }
    }, 5000);
    return true;
  });

  ipcMain.handle('devserver:status', (_event, projectPath: string) => {
    const entry = devServerProcesses.get(projectPath);
    if (!entry) return { running: false, url: null, script: null };
    return { running: true, url: entry.url, script: entry.script };
  });

  ipcMain.handle('devserver:openUrl', (_event, url: string) => {
    shell.openExternal(url);
    return true;
  });

  // ─── Cost Warning Notifications ────────────────────────────

  // Periodically check if cost warning threshold crossed
  let costWarningEmitted = false;
  // costTracker is fed from session.onData in pty:spawn handler.
  // Use a periodic check instead of hooking internals.
  setInterval(() => {
    if (!costWarningEmitted && costTracker.isAtWarning()) {
      costWarningEmitted = true;
      const globalCost = costTracker.getGlobalCost();
      // Find any active session to get projectId
      const sessions = ptyManager.getAllSessions();
      let projectId = 'unknown';
      for (const [, session] of sessions) {
        if (session.alive) {
          projectId = session.projectId;
          break;
        }
      }
      notificationStore.pushSynthetic({
        paneId: 'system',
        projectId,
        role: 'system',
        type: 'cost_warning',
        severity: 'warn',
        title: `Token budget warning — ~$${globalCost.toFixed(2)} spent`,
        detail: `approaching cost ceiling`,
      });
    }
  }, 5000);
}
