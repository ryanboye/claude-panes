/**
 * Preload script: exposes typed IPC API to renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface PaneCostInfo {
  paneId: string;
  totalUsd: number;
}

export interface ProjectEntry {
  path: string;
  name: string;
  lastOpened: string;
}

export interface RoleInfo {
  name: string;
  label: string;
  color: string;
}

const api = {
  pty: {
    spawn: (opts: { paneId: string; projectId: string; cwd: string; cols: number; rows: number; role?: string; rawTerminal?: boolean }) =>
      ipcRenderer.invoke('pty:spawn', opts),
    write: (paneId: string, projectId: string, data: string) =>
      ipcRenderer.send('pty:write', paneId, projectId, data),
    resize: (paneId: string, projectId: string, cols: number, rows: number) =>
      ipcRenderer.send('pty:resize', paneId, projectId, cols, rows),
    kill: (paneId: string, projectId: string) =>
      ipcRenderer.send('pty:kill', paneId, projectId),
    getBuffer: (paneId: string, projectId: string) =>
      ipcRenderer.invoke('pty:getBuffer', paneId, projectId) as Promise<string>,
    isAlive: (paneId: string, projectId: string) =>
      ipcRenderer.invoke('pty:isAlive', paneId, projectId) as Promise<boolean>,
    onData: (callback: (paneId: string, data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, paneId: string, data: string) => callback(paneId, data);
      ipcRenderer.on('pty:data', handler);
      return () => ipcRenderer.removeListener('pty:data', handler);
    },
    onExit: (callback: (paneId: string, code: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, paneId: string, code: number) => callback(paneId, code);
      ipcRenderer.on('pty:exit', handler);
      return () => ipcRenderer.removeListener('pty:exit', handler);
    },
  },

  project: {
    list: () => ipcRenderer.invoke('project:list') as Promise<ProjectEntry[]>,
    add: () => ipcRenderer.invoke('project:add') as Promise<ProjectEntry | null>,
    create: () => ipcRenderer.invoke('project:create') as Promise<ProjectEntry | null>,
    remove: (path: string) => ipcRenderer.invoke('project:remove', path),
    open: (path: string) => ipcRenderer.invoke('project:open', path),
    saveConfig: (path: string, config: unknown) => ipcRenderer.invoke('project:saveConfig', path, config),
  },

  tasks: {
    load: (projectPath: string) => ipcRenderer.invoke('tasks:load', projectPath),
    save: (projectPath: string, tasks: unknown[]) => ipcRenderer.invoke('tasks:save', projectPath, tasks),
  },

  research: {
    load: (projectPath: string) => ipcRenderer.invoke('research:load', projectPath) as Promise<string>,
    append: (projectPath: string, content: string) => ipcRenderer.invoke('research:append', projectPath, content),
  },

  artifacts: {
    list: (projectPath: string) => ipcRenderer.invoke('artifacts:list', projectPath) as Promise<string[]>,
  },

  roles: {
    list: () => ipcRenderer.invoke('roles:list') as Promise<RoleInfo[]>,
  },

  tokens: {
    snapshot: (paneId: string) =>
      ipcRenderer.invoke('tokens:snapshot', paneId),
    paneTotal: (paneId: string) =>
      ipcRenderer.invoke('tokens:paneTotal', paneId) as Promise<number>,
    onUpdate: (callback: (paneId: string, snapshot: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, paneId: string, snapshot: unknown) =>
        callback(paneId, snapshot);
      ipcRenderer.on('tokens:update', handler);
      return () => ipcRenderer.removeListener('tokens:update', handler);
    },
  },

  cost: {
    pane: (paneId: string) => ipcRenderer.invoke('cost:pane', paneId) as Promise<number>,
    project: (projectId: string) => ipcRenderer.invoke('cost:project', projectId) as Promise<number>,
    global: () => ipcRenderer.invoke('cost:global') as Promise<number>,
    onUpdate: (callback: (paneId: string, cost: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, paneId: string, cost: number) => callback(paneId, cost);
      ipcRenderer.on('cost:update', handler);
      return () => ipcRenderer.removeListener('cost:update', handler);
    },
    onCeiling: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('cost:ceiling', handler);
      return () => ipcRenderer.removeListener('cost:ceiling', handler);
    },
  },

  prefs: {
    load: () => ipcRenderer.invoke('prefs:load'),
    save: (prefs: unknown) => ipcRenderer.invoke('prefs:save', prefs),
  },

  window: {
    detach: (projectPath: string) =>
      ipcRenderer.invoke('window:detach', projectPath),
    isDetached: (projectPath: string) =>
      ipcRenderer.invoke('window:isDetached', projectPath) as Promise<boolean>,
    getDetachedProjects: () =>
      ipcRenderer.invoke('window:getDetachedProjects') as Promise<string[]>,
    focus: (projectPath: string) =>
      ipcRenderer.invoke('window:focus', projectPath),
    getCursorScreenPoint: () =>
      ipcRenderer.invoke('window:getCursorScreenPoint') as Promise<{ x: number; y: number }>,
    getWindowBounds: () =>
      ipcRenderer.invoke('window:getWindowBounds') as Promise<{ x: number; y: number; width: number; height: number }>,
    getMode: () => {
      const params = new URLSearchParams(location.search);
      return {
        detached: params.get('detached') === 'true',
        projectPath: params.get('project'),
      };
    },
    onProjectReattached: (callback: (projectPath: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, path: string) => callback(path);
      ipcRenderer.on('project:reattached', handler);
      return () => ipcRenderer.removeListener('project:reattached', handler);
    },
  },

  dashboard: {
    getSnapshot: () => ipcRenderer.invoke('dashboard:snapshot'),
    clearStuck: (paneId: string) => ipcRenderer.invoke('stuck:clear', paneId),
    onPaneActivity: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('dashboard:paneActivity', handler);
      return () => ipcRenderer.removeListener('dashboard:paneActivity', handler);
    },
  },

  notifications: {
    getSnapshot: (projectPath: string) =>
      ipcRenderer.invoke('notification:snapshot', projectPath) as Promise<{
        notifications: Array<{
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
        }>;
        unackedCount: number;
      }>,
    ack: (id: string, projectPath: string) =>
      ipcRenderer.invoke('notification:ack', id, projectPath),
    ackAll: (projectPath: string) =>
      ipcRenderer.invoke('notification:ackAll', projectPath),
    ackAllCritical: (projectPath: string) =>
      ipcRenderer.invoke('notification:ackAllCritical', projectPath),
    snooze: (id: string, projectPath: string, durationMs: number) =>
      ipcRenderer.invoke('notification:snooze', id, projectPath, durationMs),
    clear: (projectPath: string) =>
      ipcRenderer.invoke('notification:clear', projectPath),
    onNew: (callback: (event: {
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
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, notif: any) => callback(notif);
      ipcRenderer.on('notification:new', handler);
      return () => ipcRenderer.removeListener('notification:new', handler);
    },
  },

  devServer: {
    detect: (projectPath: string) =>
      ipcRenderer.invoke('devserver:detect', projectPath) as Promise<{ script: string; command: string } | null>,
    start: (projectPath: string, scriptName: string) =>
      ipcRenderer.invoke('devserver:start', projectPath, scriptName) as Promise<{ ok: boolean; reason?: string }>,
    stop: (projectPath: string) =>
      ipcRenderer.invoke('devserver:stop', projectPath) as Promise<boolean>,
    status: (projectPath: string) =>
      ipcRenderer.invoke('devserver:status', projectPath) as Promise<{ running: boolean; url: string | null; script: string | null }>,
    openUrl: (url: string) =>
      ipcRenderer.invoke('devserver:openUrl', url) as Promise<boolean>,
    onStatus: (callback: (projectPath: string, status: string, url: string | null) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, projectPath: string, status: string, url: string | null) =>
        callback(projectPath, status, url);
      ipcRenderer.on('devserver:status', handler);
      return () => ipcRenderer.removeListener('devserver:status', handler);
    },
  },

  // App events from main process
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const validChannels = [
      'app:error', 'app:showPreferences', 'app:newProject',
      'pane:close', 'pane:splitVertical', 'pane:splitHorizontal',
      'pane:splitVerticalRaw', 'pane:splitHorizontalRaw',
      'pane:prev', 'pane:next', 'pane:focus', 'pane:focusById',
      'panel:toggle', 'panel:flipPosition',
      'action:saveToResearch', 'action:toggleDevServer',
      'stuck:detected',
      'project:reattached', 'project:detached',
    ];
    if (validChannels.includes(channel)) {
      const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
    return () => {};
  },
};

export type ClaudePanesAPI = typeof api;

contextBridge.exposeInMainWorld('api', api);
