/**
 * System prompt builder for pane sessions.
 * Ported from orchestrator/src/agent-runner.ts context loading.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import type { AgentRole } from './agent-config';

export interface ContextSources {
  role?: AgentRole;
  projectDir: string;
  taskContext?: string;
}

/**
 * Build a system prompt for a Claude CLI pane session.
 */
export function buildSystemPrompt(sources: ContextSources): string {
  const parts: string[] = [];

  // Role-based prompt
  if (sources.role) {
    parts.push(sources.role.systemPrompt);
  }

  // Project research context
  const researchPath = path.join(sources.projectDir, '.claude-panes', 'research.md');
  if (existsSync(researchPath)) {
    try {
      const research = readFileSync(researchPath, 'utf-8').trim();
      if (research) {
        parts.push(`## Project Research\n${research}`);
      }
    } catch { /* ignore read errors */ }
  }

  // Task context
  if (sources.taskContext) {
    parts.push(`## Current Task\n${sources.taskContext}`);
  }

  // Artifact references
  const artifactsDir = path.join(sources.projectDir, '.claude-panes', 'artifacts');
  if (existsSync(artifactsDir)) {
    try {
      const files = readdirSync(artifactsDir);
      if (files.length > 0) {
        const listing = files.map(f => `- ${f}`).join('\n');
        parts.push(`## Available Artifacts\nShared outputs in ${artifactsDir}:\n${listing}`);
      }
    } catch { /* ignore */ }
  }

  // Workspace info
  parts.push(`## Workspace\nProject directory: ${sources.projectDir}`);

  return parts.join('\n\n');
}

/**
 * Build Claude CLI args for a role-configured pane.
 */
export function buildClaudeArgs(sources: ContextSources): string[] {
  const args: string[] = [];
  const systemPrompt = buildSystemPrompt(sources);

  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  return args;
}
