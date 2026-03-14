/**
 * Renders SplitNode tree to flexbox DOM with drag handles for resizing.
 * Preserves existing terminal DOM elements across re-renders by detaching
 * and reattaching them instead of destroying/recreating.
 */

import type { SplitNode } from './pane-tree';
import { getLeafIds } from './pane-tree';

export interface PaneLayoutCallbacks {
  onPaneMount: (paneId: string, container: HTMLElement) => void;
  onPaneUnmount: (paneId: string) => void;
  onResizeStart: () => void;
  onResizeEnd: (paneId: string, newRatio: number) => void;
  onPaneClick: (paneId: string) => void;
  onPaneContextMenu: (paneId: string, x: number, y: number) => void;
}

const MIN_PANE_PX = 120;

export function renderPaneTree(
  root: SplitNode,
  container: HTMLElement,
  callbacks: PaneLayoutCallbacks,
  activePaneId?: string,
): void {
  // Collect which pane IDs will exist in the new tree
  const newLeafIds = new Set(getLeafIds(root));

  // Detach existing terminal containers so they survive innerHTML clear
  const savedTerminals = new Map<string, HTMLElement>();
  container.querySelectorAll('.pane-terminal').forEach((el) => {
    const id = el.id.replace('terminal-', '');
    if (newLeafIds.has(id) && el.children.length > 0) {
      // Has a live xterm inside — save it
      savedTerminals.set(id, el as HTMLElement);
      el.remove(); // detach from DOM but keep in memory
    }
  });

  // Find panes that existed before but are gone in new tree → unmount them
  const oldLeafEls = container.querySelectorAll('.pane-leaf');
  oldLeafEls.forEach((el) => {
    const id = (el as HTMLElement).dataset.paneId;
    if (id && !newLeafIds.has(id)) {
      callbacks.onPaneUnmount(id);
    }
  });

  // Clear and rebuild layout structure
  container.innerHTML = '';
  renderNode(root, container, callbacks, activePaneId, savedTerminals);
}

function renderNode(
  node: SplitNode,
  parent: HTMLElement,
  callbacks: PaneLayoutCallbacks,
  activePaneId: string | undefined,
  savedTerminals: Map<string, HTMLElement>,
): void {
  if (node.type === 'leaf') {
    const pane = document.createElement('div');
    pane.className = 'pane-leaf' + (node.id === activePaneId ? ' pane-active' : '');
    pane.dataset.paneId = node.id;

    // Title bar
    const titleBar = document.createElement('div');
    titleBar.className = 'pane-title-bar';

    const roleLabel = document.createElement('span');
    roleLabel.className = 'pane-role';
    roleLabel.textContent = node.rawTerminal ? 'terminal' : (node.role || 'claude');
    if (node.rawTerminal) {
      roleLabel.dataset.role = 'terminal';
    } else if (node.role) {
      roleLabel.dataset.role = node.role;
    }
    titleBar.appendChild(roleLabel);

    const tokenBadge = document.createElement('span');
    tokenBadge.className = 'pane-tokens';
    tokenBadge.id = `tokens-${node.id}`;
    tokenBadge.textContent = '';
    titleBar.appendChild(tokenBadge);

    const statusDot = document.createElement('span');
    statusDot.className = 'pane-status';
    statusDot.id = `status-${node.id}`;
    titleBar.appendChild(statusDot);

    pane.appendChild(titleBar);

    // Terminal container: reuse existing if we have one, otherwise create new
    const saved = savedTerminals.get(node.id);
    if (saved) {
      // Reattach the saved terminal element — preserves xterm state + PTY
      pane.appendChild(saved);
      savedTerminals.delete(node.id);
      parent.appendChild(pane);
      // Trigger a refit after layout settles
      requestAnimationFrame(() => {
        callbacks.onPaneMount(node.id, saved);
      });
    } else {
      // New pane — create empty container, callback will mount a terminal
      const termContainer = document.createElement('div');
      termContainer.className = 'pane-terminal';
      termContainer.id = `terminal-${node.id}`;
      pane.appendChild(termContainer);
      parent.appendChild(pane);
      callbacks.onPaneMount(node.id, termContainer);
    }

    // Events
    pane.addEventListener('mousedown', () => callbacks.onPaneClick(node.id));
    titleBar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      callbacks.onPaneContextMenu(node.id, e.clientX, e.clientY);
    });

    return;
  }

  // Split node
  const splitContainer = document.createElement('div');
  splitContainer.className = `pane-split pane-split-${node.direction}`;

  const first = document.createElement('div');
  first.className = 'pane-split-child';
  first.style.flexBasis = `${node.ratio * 100}%`;
  renderNode(node.children[0], first, callbacks, activePaneId, savedTerminals);
  splitContainer.appendChild(first);

  const handle = document.createElement('div');
  handle.className = `pane-handle pane-handle-${node.direction}`;
  setupDragHandle(handle, splitContainer, first, node, callbacks);
  splitContainer.appendChild(handle);

  const second = document.createElement('div');
  second.className = 'pane-split-child';
  second.style.flexBasis = `${(1 - node.ratio) * 100}%`;
  renderNode(node.children[1], second, callbacks, activePaneId, savedTerminals);
  splitContainer.appendChild(second);

  parent.appendChild(splitContainer);
}

function setupDragHandle(
  handle: HTMLElement,
  splitContainer: HTMLElement,
  firstChild: HTMLElement,
  node: SplitNode & { type: 'split' },
  callbacks: PaneLayoutCallbacks,
): void {
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    callbacks.onResizeStart();
    document.body.classList.add('pane-resizing');

    const rect = splitContainer.getBoundingClientRect();
    const isHoriz = node.direction === 'horizontal';

    const onMove = (ev: MouseEvent) => {
      if (!dragging) return;
      const pos = isHoriz ? ev.clientY - rect.top : ev.clientX - rect.left;
      const total = isHoriz ? rect.height : rect.width;
      let ratio = pos / total;
      ratio = Math.max(MIN_PANE_PX / total, Math.min(1 - MIN_PANE_PX / total, ratio));
      firstChild.style.flexBasis = `${ratio * 100}%`;
      const secondChild = splitContainer.children[2] as HTMLElement;
      if (secondChild) secondChild.style.flexBasis = `${(1 - ratio) * 100}%`;
    };

    const onUp = (ev: MouseEvent) => {
      dragging = false;
      document.body.classList.remove('pane-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      const pos = isHoriz ? ev.clientY - rect.top : ev.clientX - rect.left;
      const total = isHoriz ? rect.height : rect.width;
      let ratio = pos / total;
      ratio = Math.max(0.1, Math.min(0.9, ratio));

      const leaf = firstChild.querySelector('.pane-leaf');
      const paneId = leaf?.getAttribute('data-pane-id') || '';
      callbacks.onResizeEnd(paneId, ratio);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
