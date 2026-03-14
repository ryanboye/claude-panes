/**
 * In-memory notification store with JSONL persistence.
 * Manages activity events, ack/snooze state, and badge counts.
 */

import { randomUUID } from 'crypto';
import type { ActivityEvent, NotificationSeverity } from './activity-detector';

export type { ActivityEvent, NotificationSeverity };

export interface NotificationSnapshot {
  notifications: ActivityEvent[];
  unackedCount: number;
}

export class NotificationStore {
  private notifications = new Map<string, ActivityEvent[]>(); // projectId → events
  private onNew?: (event: ActivityEvent) => void;

  private readonly MAX_PER_PROJECT = 200;

  constructor(onNew?: (event: ActivityEvent) => void) {
    this.onNew = onNew;
  }

  /**
   * Push a new activity event into the store.
   */
  push(event: ActivityEvent): void {
    let list = this.notifications.get(event.projectId);
    if (!list) {
      list = [];
      this.notifications.set(event.projectId, list);
    }

    list.unshift(event); // newest first

    // Evict oldest if over cap
    if (list.length > this.MAX_PER_PROJECT) {
      list.splice(this.MAX_PER_PROJECT);
    }

    this.onNew?.(event);
  }

  /**
   * Create and push a synthetic notification (for lifecycle events).
   */
  pushSynthetic(opts: {
    paneId: string;
    projectId: string;
    role: string;
    type: string;
    severity: NotificationSeverity;
    title: string;
    detail?: string;
  }): ActivityEvent {
    const event: ActivityEvent = {
      id: randomUUID(),
      paneId: opts.paneId,
      projectId: opts.projectId,
      role: opts.role,
      type: opts.type,
      severity: opts.severity,
      title: opts.title,
      detail: opts.detail,
      timestamp: new Date().toISOString(),
      acked: false,
    };
    this.push(event);
    return event;
  }

  /**
   * Get current snapshot for a project.
   */
  getSnapshot(projectId: string): NotificationSnapshot {
    const list = this.notifications.get(projectId) ?? [];
    const now = Date.now();
    // Filter out snoozed notifications
    const visible = list.filter((n) => {
      if (n.snoozedUntil) {
        return new Date(n.snoozedUntil).getTime() <= now;
      }
      return true;
    });
    const unackedCount = visible.filter((n) => !n.acked && n.severity === 'critical').length;
    return { notifications: visible, unackedCount };
  }

  /**
   * Acknowledge a notification.
   */
  ack(id: string, projectId: string): boolean {
    const list = this.notifications.get(projectId);
    if (!list) return false;
    const notif = list.find((n) => n.id === id);
    if (notif) {
      notif.acked = true;
      return true;
    }
    return false;
  }

  /**
   * Acknowledge all notifications for a project.
   */
  ackAll(projectId: string): void {
    const list = this.notifications.get(projectId);
    if (!list) return;
    for (const n of list) {
      n.acked = true;
    }
  }

  /**
   * Acknowledge all critical notifications for a project.
   */
  ackAllCritical(projectId: string): void {
    const list = this.notifications.get(projectId);
    if (!list) return;
    for (const n of list) {
      if (n.severity === 'critical') n.acked = true;
    }
  }

  /**
   * Snooze a notification for the given duration.
   */
  snooze(id: string, projectId: string, durationMs: number): boolean {
    const list = this.notifications.get(projectId);
    if (!list) return false;
    const notif = list.find((n) => n.id === id);
    if (notif) {
      notif.snoozedUntil = new Date(Date.now() + durationMs).toISOString();
      return true;
    }
    return false;
  }

  /**
   * Clear all notifications for a project.
   */
  clearAll(projectId: string): void {
    this.notifications.delete(projectId);
  }

  /**
   * Load notifications from a pre-parsed array (e.g., from JSONL on disk).
   */
  loadFromArray(projectId: string, events: ActivityEvent[]): void {
    // Take last MAX_PER_PROJECT, newest first
    const sorted = events.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    this.notifications.set(projectId, sorted.slice(0, this.MAX_PER_PROJECT));
  }

  /**
   * Get all notifications for persistence.
   */
  getAll(projectId: string): ActivityEvent[] {
    return this.notifications.get(projectId) ?? [];
  }

  /**
   * Get unacknowledged count for a project.
   */
  getUnackedCount(projectId: string): number {
    const list = this.notifications.get(projectId) ?? [];
    return list.filter((n) => !n.acked && !n.snoozedUntil && n.severity === 'critical').length;
  }
}
