/**
 * Per-pane cost tracking. Parses Claude CLI output for cost data
 * and aggregates per-pane, per-project, and global totals.
 */

export interface PaneCost {
  paneId: string;
  projectId: string;
  totalUsd: number;
  lastUpdated: string;
}

export class CostTracker {
  private paneCosts = new Map<string, PaneCost>();
  private globalCeilingUsd: number;
  private onUpdate?: (paneId: string, cost: PaneCost) => void;

  constructor(globalCeilingUsd = 50, onUpdate?: (paneId: string, cost: PaneCost) => void) {
    this.globalCeilingUsd = globalCeilingUsd;
    this.onUpdate = onUpdate;
  }

  setGlobalCeiling(usd: number): void {
    this.globalCeilingUsd = usd;
  }

  /**
   * Parse PTY output for cost information.
   * Claude CLI in interactive mode shows cost in the status line or on exit.
   * We look for patterns like "Cost: $X.XX" or JSON cost data.
   */
  parseOutput(paneId: string, projectId: string, data: string): void {
    // Pattern 1: stream-json result with cost_usd
    const jsonCostMatch = data.match(/"cost_usd"\s*:\s*([\d.]+)/);
    if (jsonCostMatch) {
      this.addCost(paneId, projectId, parseFloat(jsonCostMatch[1]));
      return;
    }

    // Pattern 2: "Total cost: $X.XX" or "Cost: $X.XX" in terminal output
    const costMatch = data.match(/(?:Total )?[Cc]ost:\s*\$?([\d.]+)/);
    if (costMatch) {
      this.setCost(paneId, projectId, parseFloat(costMatch[1]));
      return;
    }

    // Pattern 3: ANSI-escaped cost display (Claude CLI status bar)
    const ansiCostMatch = data.match(/\$([\d.]+)\s*(?:USD|usd)?/);
    if (ansiCostMatch && parseFloat(ansiCostMatch[1]) > 0) {
      this.setCost(paneId, projectId, parseFloat(ansiCostMatch[1]));
    }
  }

  private addCost(paneId: string, projectId: string, amount: number): void {
    const existing = this.paneCosts.get(paneId);
    const cost: PaneCost = {
      paneId,
      projectId,
      totalUsd: (existing?.totalUsd ?? 0) + amount,
      lastUpdated: new Date().toISOString(),
    };
    this.paneCosts.set(paneId, cost);
    this.onUpdate?.(paneId, cost);
  }

  private setCost(paneId: string, projectId: string, total: number): void {
    const cost: PaneCost = {
      paneId,
      projectId,
      totalUsd: total,
      lastUpdated: new Date().toISOString(),
    };
    this.paneCosts.set(paneId, cost);
    this.onUpdate?.(paneId, cost);
  }

  getPaneCost(paneId: string): number {
    return this.paneCosts.get(paneId)?.totalUsd ?? 0;
  }

  getProjectCost(projectId: string): number {
    let total = 0;
    for (const cost of this.paneCosts.values()) {
      if (cost.projectId === projectId) total += cost.totalUsd;
    }
    return total;
  }

  getGlobalCost(): number {
    let total = 0;
    for (const cost of this.paneCosts.values()) {
      total += cost.totalUsd;
    }
    return total;
  }

  isAtWarning(): boolean {
    return this.getGlobalCost() >= this.globalCeilingUsd * 0.8;
  }

  isAtCeiling(): boolean {
    return this.getGlobalCost() >= this.globalCeilingUsd;
  }

  removePaneCost(paneId: string): void {
    this.paneCosts.delete(paneId);
  }

  getAllCosts(): PaneCost[] {
    return Array.from(this.paneCosts.values());
  }
}
