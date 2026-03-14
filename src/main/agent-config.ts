/**
 * Agent role definitions and sandbox policies.
 * Ported from orchestrator/src/config.ts — adapted for interactive pane sessions.
 */

export interface SandboxPolicy {
  allowedDomains?: string[];
  additionalWritePaths?: string[];
  denyReadPaths?: string[];
}

export interface AgentRole {
  name: string;
  label: string;
  color: string;          // CSS color for UI badges
  systemPrompt: string;
  allowedTools: string[];
  sandboxPolicy: SandboxPolicy;
  maxCostUsd: number;
}

const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(npm:*,npx:*,node:*,git:*,mkdir:*,cp:*,mv:*,chmod:*,curl:*,ls:*,cat:*,find:*,pwd:*,tsc:*,bun:*,pnpm:*)',
  'WebSearch', 'WebFetch',
];

export const AGENT_ROLES: Record<string, AgentRole> = {
  researcher: {
    name: 'researcher',
    label: 'Researcher',
    color: '#2dd4bf', // teal
    systemPrompt: `You are the researcher. Your job is to:
- Search the web for documentation, best practices, and examples
- Read and analyze existing code and docs
- Write clear research summaries to the workspace
- Recommend approaches based on your findings

Write all findings to files in the workspace so other agents can reference them.`,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    sandboxPolicy: { allowedDomains: ['*'] },
    maxCostUsd: 3,
  },
  architect: {
    name: 'architect',
    label: 'Architect',
    color: '#60a5fa', // blue
    systemPrompt: `You are the architect. Your job is to:
- Design project structure and file layout
- Choose frameworks, libraries, and tools
- Write technical specs and architecture docs
- Create initial scaffolding (package.json, configs, directory structure)

Be opinionated but pragmatic. Prefer simple, proven tools over bleeding edge.`,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(cat:*,ls:*,find:*,tree:*)', 'WebSearch', 'WebFetch'],
    sandboxPolicy: { allowedDomains: ['*.npmjs.com', '*.github.com', '*.stackoverflow.com'] },
    maxCostUsd: 3,
  },
  builder: {
    name: 'builder',
    label: 'Builder',
    color: '#fbbf24', // amber
    systemPrompt: `You are the builder. Your job is to:
- Write production-quality code
- Follow the architecture and specs laid out by the architect
- Run builds and fix errors
- Write tests where appropriate

Read the research and architecture docs in the workspace before starting.`,
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    sandboxPolicy: { allowedDomains: ['*.npmjs.com', 'registry.npmjs.org', '*.github.com', '*.googleapis.com'] },
    maxCostUsd: 5,
  },
  reviewer: {
    name: 'reviewer',
    label: 'Reviewer',
    color: '#4ade80', // green
    systemPrompt: `You are the reviewer. Your job is to:
- Review code for bugs, security issues, and quality
- Run tests and verify builds pass
- Check that implementation matches the architecture spec
- Flag issues clearly with specific suggestions

Be thorough but constructive. Focus on real issues, not style nitpicks.`,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash(npm:test,npm:run,npx:*,node:*,git:diff,git:log,git:status,ls:*,cat:*,curl:*)'],
    sandboxPolicy: { allowedDomains: ['*.npmjs.com', '*.github.com'] },
    maxCostUsd: 2,
  },
  designer: {
    name: 'designer',
    label: 'Designer',
    color: '#c084fc', // purple
    systemPrompt: `You are the designer. Your job is to:
- Own UX direction and interface design
- Ensure brand coherence across the project
- Create and review UI components
- Provide design guidance and critique

Focus on usability, accessibility, and visual consistency.`,
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    sandboxPolicy: { allowedDomains: ['*.npmjs.com', '*.github.com', 'fonts.googleapis.com', '*.figma.com'] },
    maxCostUsd: 3,
  },
};

export function getRoleNames(): string[] {
  return Object.keys(AGENT_ROLES);
}

export function getRole(name: string): AgentRole | undefined {
  return AGENT_ROLES[name];
}
