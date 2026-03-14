/**
 * Project sidebar: icon-only rail with project list, add button,
 * and drag-to-detach for multi-window support.
 */

declare const api: import('../preload/index').ClaudePanesAPI;

export interface ProjectSidebarCallbacks {
  onSelectProject: (projectPath: string) => void;
  onAddProject: () => void;
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

const DRAG_THRESHOLD = 8; // px before we consider it a drag

export async function initSidebar(
  container: HTMLElement,
  callbacks: ProjectSidebarCallbacks,
): Promise<void> {
  projects = await api.project.list();
  render(container, callbacks);
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
    // Deselect all projects
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

  const divider = document.createElement('div');
  divider.className = 'sidebar-divider';
  container.appendChild(divider);

  // Project list
  const list = document.createElement('div');
  list.className = 'sidebar-projects';

  // Sort by last opened
  const sorted = [...projects].sort((a, b) =>
    new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime()
  );

  for (const project of sorted) {
    const item = document.createElement('div');
    item.className = 'sidebar-project' + (project.path === currentProjectPath ? ' sidebar-project-active' : '');
    item.dataset.path = project.path;

    const initial = project.name.charAt(0).toUpperCase();
    const badge = document.createElement('div');
    badge.className = 'sidebar-project-badge';
    badge.textContent = initial;
    badge.style.backgroundColor = stringToColor(project.name);

    item.appendChild(badge);
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

    // Drag-to-detach
    setupDragToDetach(badge, project, container, callbacks);

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

  // Add project button
  const addBtn = document.createElement('div');
  addBtn.className = 'sidebar-add';
  addBtn.innerHTML = '+';
  addBtn.title = 'Add Project (Cmd+N)';
  addBtn.addEventListener('click', () => callbacks.onAddProject());
  container.appendChild(addBtn);

  // Update detached state after render
  updateDetachedState();
}

function setupDragToDetach(
  badge: HTMLElement,
  project: ProjectEntry,
  container: HTMLElement,
  callbacks: ProjectSidebarCallbacks,
): void {
  badge.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left click only
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
        badge.classList.add('sidebar-badge-dragging');
        document.body.style.cursor = 'grabbing';

        // Create floating ghost
        ghost = badge.cloneNode(true) as HTMLElement;
        ghost.className = 'sidebar-drag-ghost';
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
      badge.classList.remove('sidebar-badge-dragging');
      document.body.style.cursor = '';
      if (ghost) {
        ghost.remove();
        ghost = null;
      }

      if (!dragging) return; // was a click, not a drag — let click handler fire

      // Check if cursor is outside window bounds
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
 * When `active` is false (no agents burning tokens), the icon fades out.
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

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % 360;
  return `hsl(${hue < 0 ? hue + 360 : hue}, 50%, 40%)`;
}
