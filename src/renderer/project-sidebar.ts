/**
 * Project sidebar: responsive rail that collapses to compact icons at narrow
 * widths and expands to full project cards (name, status, time) when wide.
 */

declare const api: import('../preload/index').ClaudePanesAPI;

export interface ProjectSidebarCallbacks {
  onSelectProject: (projectPath: string) => void;
  onAddProject: () => void;
  onCreateProject: () => void;
  onHomeClick: () => void;
}

interface ProjectEntry {
  path: string;
  name: string;
  lastOpened: string;
}

let currentProjectPath: string | null = null;
let homeActive = false;
let projects: ProjectEntry[] = [];
let sidebarContainer: HTMLElement | null = null;
let sidebarCallbacks: ProjectSidebarCallbacks | null = null;
let resizeObserver: ResizeObserver | null = null;

const DRAG_THRESHOLD = 8;
const EXPAND_THRESHOLD = 120; // px — sidebar shows full cards above this

export async function initSidebar(
  container: HTMLElement,
  callbacks: ProjectSidebarCallbacks,
): Promise<void> {
  sidebarContainer = container;
  sidebarCallbacks = callbacks;
  projects = await api.project.list();
  render(container, callbacks);

  // Watch sidebar width to toggle compact/expanded mode
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const wide = entry.contentRect.width >= EXPAND_THRESHOLD;
      container.classList.toggle('sidebar-expanded', wide);
    }
  });
  resizeObserver.observe(container);
}

export function setActiveProject(projectPath: string | null): void {
  currentProjectPath = projectPath;
  updateActiveState();
}

export function setHomeActive(active: boolean): void {
  homeActive = active;
  const logo = document.querySelector('.sidebar-logo') as HTMLElement | null;
  if (logo) {
    logo.classList.toggle('sidebar-logo-active', active);
  }
  if (active) {
    document.querySelectorAll('.sidebar-project').forEach((el) => {
      el.classList.remove('sidebar-project-active');
    });
  }
}

export async function refreshProjects(container: HTMLElement, callbacks: ProjectSidebarCallbacks): Promise<void> {
  projects = await api.project.list();
  render(container, callbacks);
}

export async function updateDetachedState(): Promise<void> {
  const detachedPaths = await api.window.getDetachedProjects();
  document.querySelectorAll('.sidebar-project').forEach((el) => {
    const path = (el as HTMLElement).dataset.path;
    el.classList.toggle('sidebar-project-detached',
      path ? detachedPaths.includes(path) : false);
  });
}

function render(container: HTMLElement, callbacks: ProjectSidebarCallbacks): void {
  container.innerHTML = '';

  // Logo / app icon (clickable → home screen)
  const logo = document.createElement('div');
  logo.className = 'sidebar-logo' + (homeActive ? ' sidebar-logo-active' : '');
  logo.innerHTML = '&#x2B21;'; // hexagon
  logo.title = 'Dashboard';
  logo.addEventListener('click', () => callbacks.onHomeClick());
  container.appendChild(logo);

  // Expanded-mode header
  const header = document.createElement('div');
  header.className = 'sidebar-header';
  header.textContent = 'Projects';
  container.appendChild(header);

  const divider = document.createElement('div');
  divider.className = 'sidebar-divider';
  container.appendChild(divider);

  // Project list
  const list = document.createElement('div');
  list.className = 'sidebar-projects';

  const sorted = [...projects].sort((a, b) =>
    new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime()
  );

  for (const project of sorted) {
    const item = document.createElement('div');
    item.className = 'sidebar-project' + (project.path === currentProjectPath ? ' sidebar-project-active' : '');
    item.dataset.path = project.path;

    // Status dot
    const dot = document.createElement('span');
    dot.className = 'sidebar-project-dot';
    item.appendChild(dot);

    // Compact abbreviation (shown when narrow)
    const abbr = document.createElement('span');
    abbr.className = 'sidebar-project-abbr';
    abbr.textContent = abbreviate(project.name);
    item.appendChild(abbr);

    // Full name (shown when expanded)
    const nameEl = document.createElement('span');
    nameEl.className = 'sidebar-project-name';
    nameEl.textContent = project.name;
    item.appendChild(nameEl);

    // Relative time (shown when expanded)
    const timeEl = document.createElement('span');
    timeEl.className = 'sidebar-project-time';
    timeEl.textContent = relativeTime(project.lastOpened);
    item.appendChild(timeEl);

    item.title = project.name;

    // Click — open project or focus its detached window
    item.addEventListener('click', async () => {
      const detached = await api.window.isDetached(project.path);
      if (detached) {
        api.window.focus(project.path);
      } else {
        callbacks.onSelectProject(project.path);
      }
    });

    // Drag-to-detach (uses the whole item in compact mode)
    setupDragToDetach(item, project, container, callbacks);

    // Right-click to remove
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm(`Remove "${project.name}" from sidebar? (Files won't be deleted)`)) {
        api.project.remove(project.path);
        projects = projects.filter(p => p.path !== project.path);
        render(container, callbacks);
      }
    });

    list.appendChild(item);
  }

  container.appendChild(list);

  // Bottom buttons
  const bottomBtns = document.createElement('div');
  bottomBtns.className = 'sidebar-bottom-btns';

  // New project (creates a folder)
  const newBtn = document.createElement('div');
  newBtn.className = 'sidebar-add';
  newBtn.innerHTML = '<span class="sidebar-add-icon">+</span><span class="sidebar-add-label">New Project</span>';
  newBtn.title = 'New Project';
  newBtn.addEventListener('click', () => callbacks.onCreateProject());
  bottomBtns.appendChild(newBtn);

  // Add existing project (open folder)
  const addBtn = document.createElement('div');
  addBtn.className = 'sidebar-add';
  addBtn.innerHTML = '<span class="sidebar-add-icon">&#x21B3;</span><span class="sidebar-add-label">Open Existing</span>';
  addBtn.title = 'Open Existing Folder (Cmd+N)';
  addBtn.addEventListener('click', () => callbacks.onAddProject());
  bottomBtns.appendChild(addBtn);

  container.appendChild(bottomBtns);

  updateDetachedState();
}

function setupDragToDetach(
  item: HTMLElement,
  project: ProjectEntry,
  container: HTMLElement,
  callbacks: ProjectSidebarCallbacks,
): void {
  item.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const startX = e.screenX;
    const startY = e.screenY;
    let dragging = false;
    let ghost: HTMLElement | null = null;

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.screenX - startX;
      const dy = ev.screenY - startY;

      if (!dragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        dragging = true;
        item.classList.add('sidebar-badge-dragging');
        document.body.style.cursor = 'grabbing';

        ghost = document.createElement('div');
        ghost.className = 'sidebar-drag-ghost';
        ghost.textContent = abbreviate(project.name);
        ghost.style.position = 'fixed';
        ghost.style.pointerEvents = 'none';
        ghost.style.zIndex = '9999';
        document.body.appendChild(ghost);
      }

      if (ghost) {
        ghost.style.left = `${ev.clientX - 16}px`;
        ghost.style.top = `${ev.clientY - 16}px`;
      }
    };

    const onMouseUp = async (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      item.classList.remove('sidebar-badge-dragging');
      document.body.style.cursor = '';
      if (ghost) {
        ghost.remove();
        ghost = null;
      }

      if (!dragging) return;

      const [cursor, bounds] = await Promise.all([
        api.window.getCursorScreenPoint(),
        api.window.getWindowBounds(),
      ]);

      const outsideWindow =
        cursor.x < bounds.x ||
        cursor.x > bounds.x + bounds.width ||
        cursor.y < bounds.y ||
        cursor.y > bounds.y + bounds.height;

      if (outsideWindow) {
        const alreadyDetached = await api.window.isDetached(project.path);
        if (!alreadyDetached) {
          await api.window.detach(project.path);
          updateDetachedState();
        }
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

/**
 * Toggle the idle/active appearance of a project icon.
 */
export function updateProjectActivity(projectPath: string, active: boolean): void {
  const items = document.querySelectorAll('.sidebar-project');
  items.forEach((item) => {
    const el = item as HTMLElement;
    if (el.dataset.path === projectPath) {
      el.classList.toggle('sidebar-project-idle', !active);
    }
  });
}

function updateActiveState(): void {
  const items = document.querySelectorAll('.sidebar-project');
  items.forEach((item) => {
    const el = item as HTMLElement;
    el.classList.toggle('sidebar-project-active', el.dataset.path === currentProjectPath);
  });
}

function abbreviate(name: string): string {
  const words = name.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
