/**
 * Per-project .claude-panes/ persistence and global app state.
 * Uses atomic writes (write temp, rename) from orchestrator/src/store.ts pattern.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// ─── Types ─────────────────────────────────────────────────────

export interface ProjectEntry {
  path: string;
  name: string;
  lastOpened: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  status: 'todo' | 'in-progress' | 'done';
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectConfig {
  layout?: unknown; // SplitNode tree — serialized
  paneRoles?: Record<string, string>; // paneId → role name
}

export interface AppPreferences {
  fontSize: number;
  theme: string;
  costCeilingUsd: number;
  claudeCliPath?: string;
}

export interface AuditEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// ─── Paths ─────────────────────────────────────────────────────

const APP_SUPPORT_DIR = path.join(
  process.env.HOME || '~',
  'Library', 'Application Support', 'claude-panes'
);

function ensureAppDir(): void {
  if (!existsSync(APP_SUPPORT_DIR)) {
    mkdirSync(APP_SUPPORT_DIR, { recursive: true });
  }
}

// ─── Atomic Write ──────────────────────────────────────────────

function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = path.join(tmpdir(), `claude-panes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// ─── Global App State ──────────────────────────────────────────

export function getProjectsListPath(): string {
  return path.join(APP_SUPPORT_DIR, 'projects.json');
}

export function getPreferencesPath(): string {
  return path.join(APP_SUPPORT_DIR, 'preferences.json');
}

export function loadProjects(): ProjectEntry[] {
  ensureAppDir();
  return readJsonSafe<ProjectEntry[]>(getProjectsListPath(), []);
}

export function saveProjects(projects: ProjectEntry[]): void {
  ensureAppDir();
  atomicWrite(getProjectsListPath(), JSON.stringify(projects, null, 2));
}

export function addProject(projectPath: string): ProjectEntry {
  const projects = loadProjects();
  const existing = projects.find(p => p.path === projectPath);
  if (existing) {
    existing.lastOpened = new Date().toISOString();
    saveProjects(projects);
    return existing;
  }
  const entry: ProjectEntry = {
    path: projectPath,
    name: path.basename(projectPath),
    lastOpened: new Date().toISOString(),
  };
  projects.push(entry);
  saveProjects(projects);
  return entry;
}

export function removeProject(projectPath: string): void {
  const projects = loadProjects().filter(p => p.path !== projectPath);
  saveProjects(projects);
}

export function touchProject(projectPath: string): void {
  const projects = loadProjects();
  const entry = projects.find(p => p.path === projectPath);
  if (entry) {
    entry.lastOpened = new Date().toISOString();
    saveProjects(projects);
  }
}

// ─── Preferences ───────────────────────────────────────────────

const DEFAULT_PREFERENCES: AppPreferences = {
  fontSize: 13,
  theme: 'midnight',
  costCeilingUsd: 50,
};

export function loadPreferences(): AppPreferences {
  ensureAppDir();
  return { ...DEFAULT_PREFERENCES, ...readJsonSafe<Partial<AppPreferences>>(getPreferencesPath(), {}) };
}

export function savePreferences(prefs: AppPreferences): void {
  ensureAppDir();
  atomicWrite(getPreferencesPath(), JSON.stringify(prefs, null, 2));
}

// ─── Per-Project State ─────────────────────────────────────────

function projectStateDir(projectDir: string): string {
  return path.join(projectDir, '.claude-panes');
}

export function initProjectState(projectDir: string): void {
  const stateDir = projectStateDir(projectDir);
  const dirs = ['sessions', 'logs', 'artifacts'];
  for (const d of dirs) {
    const full = path.join(stateDir, d);
    if (!existsSync(full)) mkdirSync(full, { recursive: true });
  }

  // Init empty files if they don't exist
  const tasksPath = path.join(stateDir, 'tasks.json');
  if (!existsSync(tasksPath)) atomicWrite(tasksPath, '[]');

  const researchPath = path.join(stateDir, 'research.md');
  if (!existsSync(researchPath)) writeFileSync(researchPath, '', 'utf-8');

  const eventsPath = path.join(stateDir, 'events.jsonl');
  if (!existsSync(eventsPath)) writeFileSync(eventsPath, '', 'utf-8');

  const notificationsPath = path.join(stateDir, 'notifications.jsonl');
  if (!existsSync(notificationsPath)) writeFileSync(notificationsPath, '', 'utf-8');
}

export function loadProjectConfig(projectDir: string): ProjectConfig {
  return readJsonSafe<ProjectConfig>(path.join(projectStateDir(projectDir), 'config.json'), {});
}

export function saveProjectConfig(projectDir: string, config: ProjectConfig): void {
  atomicWrite(path.join(projectStateDir(projectDir), 'config.json'), JSON.stringify(config, null, 2));
}

export function loadTasks(projectDir: string): ProjectTask[] {
  return readJsonSafe<ProjectTask[]>(path.join(projectStateDir(projectDir), 'tasks.json'), []);
}

export function saveTasks(projectDir: string, tasks: ProjectTask[]): void {
  atomicWrite(path.join(projectStateDir(projectDir), 'tasks.json'), JSON.stringify(tasks, null, 2));
}

export function appendResearch(projectDir: string, content: string): void {
  const researchPath = path.join(projectStateDir(projectDir), 'research.md');
  const header = `\n\n## ${new Date().toISOString()}\n`;
  appendFileSync(researchPath, header + content + '\n', 'utf-8');
}

export function loadResearch(projectDir: string): string {
  const researchPath = path.join(projectStateDir(projectDir), 'research.md');
  try {
    return existsSync(researchPath) ? readFileSync(researchPath, 'utf-8') : '';
  } catch {
    return '';
  }
}

export function appendEvent(projectDir: string, event: AuditEvent): void {
  const eventsPath = path.join(projectStateDir(projectDir), 'events.jsonl');
  appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf-8');
}

export function listArtifacts(projectDir: string): string[] {
  const dir = path.join(projectStateDir(projectDir), 'artifacts');
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

// ─── Notifications ──────────────────────────────────────────────

export function appendNotification(projectDir: string, event: Record<string, unknown>): void {
  const filePath = path.join(projectStateDir(projectDir), 'notifications.jsonl');
  appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

export function loadNotifications(projectDir: string): Record<string, unknown>[] {
  const filePath = path.join(projectStateDir(projectDir), 'notifications.jsonl');
  try {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    const lines = content.split('\n');
    // Return last 200 entries
    const recent = lines.slice(-200);
    const parsed: Record<string, unknown>[] = [];
    for (const line of recent) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

export function compactNotifications(projectDir: string, events: Record<string, unknown>[]): void {
  const filePath = path.join(projectStateDir(projectDir), 'notifications.jsonl');
  const content = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  atomicWrite(filePath, content);
}
