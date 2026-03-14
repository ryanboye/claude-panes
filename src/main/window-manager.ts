/**
 * Multi-window manager. Tracks which BrowserWindow owns which project.
 * Detached windows show a single project without the sidebar.
 */

import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { existsSync } from 'fs';

interface DetachedEntry {
  window: BrowserWindow;
  projectPath: string;
}

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private detached = new Map<string, DetachedEntry>(); // projectPath -> entry

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  /**
   * Get the window that should receive events for a given project.
   * Returns the detached window if one exists, otherwise the main window.
   */
  getWindowForProject(projectPath: string): BrowserWindow | null {
    const entry = this.detached.get(projectPath);
    if (entry && !entry.window.isDestroyed()) return entry.window;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) return this.mainWindow;
    return null;
  }

  isDetached(projectPath: string): boolean {
    const entry = this.detached.get(projectPath);
    return !!entry && !entry.window.isDestroyed();
  }

  getDetachedProjectPaths(): string[] {
    const paths: string[] = [];
    for (const [path, entry] of this.detached) {
      if (!entry.window.isDestroyed()) paths.push(path);
    }
    return paths;
  }

  /**
   * Spawn a new window dedicated to a single project.
   * The window loads the same HTML with query params to signal detached mode.
   */
  detachProject(projectPath: string, cursorX?: number, cursorY?: number): BrowserWindow {
    const existing = this.detached.get(projectPath);
    if (existing && !existing.window.isDestroyed()) {
      existing.window.focus();
      return existing.window;
    }

    // Position near cursor if provided, otherwise center on current display
    let x: number | undefined;
    let y: number | undefined;
    if (cursorX !== undefined && cursorY !== undefined) {
      x = cursorX - 600; // offset so window appears near cursor
      y = cursorY - 100;
    }

    const iconFile = path.join(__dirname, '..', '..', 'build', 'icon.png');
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      x,
      y,
      minWidth: 600,
      minHeight: 400,
      title: path.basename(projectPath),
      icon: existsSync(iconFile) ? iconFile : undefined,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
      backgroundColor: '#1a1a2e',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // Load same HTML with query params for detached mode
    win.loadFile(
      path.join(__dirname, '..', 'renderer', 'index.html'),
      { query: { detached: 'true', project: projectPath } },
    );

    win.on('closed', () => {
      this.detached.delete(projectPath);
      // Notify main window that project was reattached
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('project:reattached', projectPath);
      }
    });

    this.detached.set(projectPath, { window: win, projectPath });
    return win;
  }

  focusDetached(projectPath: string): void {
    const entry = this.detached.get(projectPath);
    if (entry && !entry.window.isDestroyed()) {
      entry.window.show();
      entry.window.focus();
    }
  }

  /**
   * Send a message to all windows (main + detached).
   */
  broadcastToAll(channel: string, ...args: unknown[]): void {
    for (const win of this.getAllWindows()) {
      win.webContents.send(channel, ...args);
    }
  }

  getAllWindows(): BrowserWindow[] {
    const wins: BrowserWindow[] = [];
    if (this.mainWindow && !this.mainWindow.isDestroyed()) wins.push(this.mainWindow);
    for (const entry of this.detached.values()) {
      if (!entry.window.isDestroyed()) wins.push(entry.window);
    }
    return wins;
  }

  destroyAll(): void {
    for (const entry of this.detached.values()) {
      if (!entry.window.isDestroyed()) entry.window.close();
    }
    this.detached.clear();
  }
}
