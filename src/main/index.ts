/**
 * Electron main process entry point.
 * Creates BrowserWindow, sets up menus, registers shortcuts, wires IPC.
 */

import { app, BrowserWindow, Menu, shell, globalShortcut, Notification } from 'electron';
import path from 'path';
import { fixProcessEnv } from './shell-env';
import { PtyManager } from './pty-manager';
import { CostTracker } from './cost-tracker';
import { TokenTracker } from './token-tracker';
import { StuckDetector } from './stuck-detector';
import { WindowManager } from './window-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { loadPreferences } from './project-store';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

// Note: ActivityDetector and NotificationStore are instantiated inside registerIpcHandlers

// Fix PATH before anything else
fixProcessEnv();

// Set app name for menu bar (overrides package.json "name" during dev)
app.name = 'Claude Panes';

const windowManager = new WindowManager();
const ptyManager = new PtyManager();

function verifyClaudeCli(): boolean {
  try {
    execSync('which claude', { encoding: 'utf-8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function createWindow(): void {
  const prefs = loadPreferences();

  const iconFile = path.join(__dirname, '..', '..', 'build', 'icon.png');
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 360,
    minHeight: 300,
    title: 'Claude Panes',
    icon: existsSync(iconFile) ? iconFile : undefined,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for node-pty IPC
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  windowManager.setMainWindow(mainWindow);

  mainWindow.on('closed', () => {
    windowManager.setMainWindow(null as any);
  });

  // Verify claude CLI on first load
  mainWindow.webContents.on('did-finish-load', () => {
    if (!verifyClaudeCli()) {
      mainWindow?.webContents.send('app:error', {
        title: 'Claude CLI Not Found',
        message: 'The `claude` command was not found on your PATH. Install it with: npm install -g @anthropic-ai/claude-code',
      });
    }
  });
}

function sendToFocused(channel: string, ...args: unknown[]): void {
  const win = BrowserWindow.getFocusedWindow();
  win?.webContents.send(channel, ...args);
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'Cmd+,',
          click: () => sendToFocused('app:showPreferences'),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project…',
          accelerator: 'Cmd+N',
          click: () => windowManager.getMainWindow()?.webContents.send('app:newProject'),
        },
        { type: 'separator' },
        {
          label: 'Close Pane',
          accelerator: 'Cmd+W',
          click: () => sendToFocused('pane:close'),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Panes',
      submenu: [
        {
          label: 'Split Vertical',
          accelerator: 'Cmd+T',
          click: () => sendToFocused('pane:splitVertical'),
        },
        {
          label: 'Split Horizontal',
          accelerator: 'Cmd+D',
          click: () => sendToFocused('pane:splitHorizontal'),
        },
        { type: 'separator' },
        {
          label: 'Split Vertical (Terminal)',
          accelerator: 'Cmd+Shift+T',
          click: () => sendToFocused('pane:splitVerticalRaw'),
        },
        {
          label: 'Split Horizontal (Terminal)',
          accelerator: 'Cmd+Shift+D',
          click: () => sendToFocused('pane:splitHorizontalRaw'),
        },
        { type: 'separator' },
        {
          label: 'Previous Pane',
          accelerator: 'Cmd+[',
          click: () => sendToFocused('pane:prev'),
        },
        {
          label: 'Next Pane',
          accelerator: 'Cmd+]',
          click: () => sendToFocused('pane:next'),
        },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Focus Pane ${i + 1}`,
          accelerator: `Cmd+${i + 1}` as string,
          click: () => sendToFocused('pane:focus', i),
        })),
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Context Panel',
          accelerator: 'Cmd+B',
          click: () => sendToFocused('panel:toggle'),
        },
        {
          label: 'Toggle Panel Position',
          accelerator: 'Cmd+J',
          click: () => sendToFocused('panel:flipPosition'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Actions',
      submenu: [
        {
          label: 'Save to Research',
          accelerator: 'Cmd+Shift+S',
          click: () => sendToFocused('action:saveToResearch'),
        },
        {
          label: 'Toggle Dev Server',
          accelerator: 'Cmd+Shift+D',
          click: () => sendToFocused('action:toggleDevServer'),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Cost Update Forwarding ──────────────────────────────────

const costTracker = new CostTracker(
  loadPreferences().costCeilingUsd,
  (paneId, cost) => {
    // Broadcast cost updates to all windows
    windowManager.broadcastToAll('cost:update', paneId, cost.totalUsd);
    if (costTracker.isAtCeiling()) {
      windowManager.broadcastToAll('cost:ceiling');
    }
  }
);

// ─── Token Tracking ─────────────────────────────────────────

const tokenTracker = new TokenTracker((paneId, snapshot) => {
  windowManager.broadcastToAll('tokens:update', paneId, snapshot);
});

// ─── Stuck Detection ─────────────────────────────────────────

const stuckDetector = new StuckDetector((event) => {
  windowManager.broadcastToAll('stuck:detected', event.paneId, event.phrase);

  // Native macOS notification
  if (Notification.isSupported()) {
    const notif = new Notification({
      title: 'Agent Stuck',
      body: `Pane ${event.paneId} is stuck: "${event.phrase}"`,
      silent: false,
    });
    notif.show();
    notif.on('click', () => {
      // Focus the main window (user can navigate from there)
      const main = windowManager.getMainWindow();
      main?.show();
      main?.focus();
      main?.webContents.send('pane:focusById', event.paneId);
    });
  }
});

// ─── App Lifecycle ───────────────────────────────────────────

app.whenReady().then(() => {
  // Set dock icon only in development; production uses the bundled .icns
  // which macOS automatically applies the rounded "squircle" mask to.
  // Calling app.dock.setIcon() in production overrides that and shows
  // the raw image with sharp corners.
  if (!app.isPackaged && app.dock) {
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
    if (existsSync(iconPath)) {
      const { nativeImage } = require('electron');
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  registerIpcHandlers(ptyManager, costTracker, tokenTracker, stuckDetector, windowManager);
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep running until Cmd+Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  windowManager.destroyAll();
  ptyManager.killAll();
  globalShortcut.unregisterAll();
});
