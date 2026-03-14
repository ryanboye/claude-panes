/**
 * Token display and pane status tracking.
 * Replaces the old cost overlay with lightweight token counts.
 */

declare const api: import('../preload/index').ClaudePanesAPI;

function formatTokenCount(tokens: number): string {
  if (tokens <= 0) return '';
  if (tokens < 1000) return `${tokens} tok`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k tok`;
  return `${(tokens / 1_000_000).toFixed(1)}M tok`;
}

export function updatePaneTokens(paneId: string, totalTokens: number): void {
  const el = document.getElementById(`tokens-${paneId}`);
  if (el) {
    el.textContent = formatTokenCount(totalTokens);
  }
}

// Keep these names for backwards compatibility with existing imports
export function updatePaneCost(paneId: string, _costUsd: number): void {
  // No-op — cost display removed
}

export function updateProjectCost(_costUsd: number): void {
  // No-op — cost display removed
}

export function showCostWarning(): void {
  // No-op — cost warnings removed
}

export function showCostCeiling(): void {
  // No-op — cost ceiling removed
}

export function setPaneStatus(paneId: string, status: 'running' | 'stuck' | 'exited' | 'idle'): void {
  const el = document.getElementById(`status-${paneId}`);
  if (el) {
    el.className = `pane-status pane-status-${status}`;
  }

  // Flash title bar red on stuck
  const pane = document.querySelector(`[data-pane-id="${paneId}"]`);
  if (pane) {
    pane.classList.toggle('pane-stuck', status === 'stuck');
  }
}

/**
 * Initialize token tracking event listeners.
 */
export function initCostTracking(): void {
  // Cost events are no-ops now, but keep the listener to avoid errors
  api.cost.onUpdate(() => {});
  api.cost.onCeiling(() => {});
}
