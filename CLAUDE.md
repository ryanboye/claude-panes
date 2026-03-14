# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Panes is a multi-pane Electron terminal manager for macOS that runs multiple Claude CLI agents simultaneously in split panes. Features include role-based agents, cost tracking, token monitoring, activity detection, and multi-window support.

## Build & Development Commands

```bash
npm run dev          # TypeScript compile + launch Electron
npm run build        # TypeScript compile + esbuild renderer bundle
npm run dist         # Build macOS DMG release
npm run rebuild-pty  # Rebuild native node-pty module (needed after Electron version changes)
npm run postinstall  # Install Electron app dependencies
```

There is no test suite or linter configured.

## Architecture

### Electron Process Model

Three-layer architecture with strict IPC boundaries:

- **Main process** (`src/main/`): Node.js — PTY management, file persistence, monitoring, window lifecycle
- **Preload bridge** (`src/preload/index.ts`): Secure `contextBridge` exposing ~38 IPC handlers across 8 namespaces. This is the API contract between main and renderer.
- **Renderer** (`src/renderer/`): Browser context — xterm.js terminals, split pane layout, UI state. No Node.js access.

### PTY Management (`src/main/pty-manager.ts`)

Spawns `claude` CLI processes via `node-pty`. Sessions stored in `Map<"projectId:paneId", PtySession>`. Routes stdin/stdout via IPC. Maintains rolling output buffer for reattach support when panes are restored.

### Split Pane Tree (`src/renderer/pane-tree.ts`)

Pane layout is a **binary split tree** — each node is either a leaf (terminal) or a split (horizontal/vertical) with two children. Operations are immutable/functional. The tree serializes to `.claude-panes/config.json` per project.

### Multi-Window (`src/main/window-manager.ts`)

Main window has sidebar + all projects. Projects can be detached into standalone windows (`?detached=true&project=...` query params). WindowManager routes IPC to the correct BrowserWindow. Closing a detached window fires `project:reattached` to main window.

### Monitoring Pipeline

All monitors parse Claude CLI terminal output and broadcast events via IPC:

- **CostTracker** (`cost-tracker.ts`): Regex-matches `$X.XX` patterns, aggregates per-pane/project/global
- **TokenTracker** (`token-tracker.ts`): Extracts input/output token counts, computes burn rate in 2-second histogram buckets
- **StuckDetector** (`stuck-detector.ts`): Matches 11 predefined phrases ("i am stuck", "cannot proceed", etc.), fires once per pane
- **ActivityDetector** (`activity-detector.ts`): Rules-based pattern matching for errors, test results, completions; phase-based summarization

### Agent Roles (`src/main/agent-config.ts`)

Five predefined roles (researcher, architect, builder, reviewer, designer), each with system prompt, allowed tools, sandbox policy, and max cost. Roles are assigned per-pane via context menu and rendered as colored badges.

### Persistence (`src/main/project-store.ts`)

- Global project list: `~/Library/Application Support/claude-panes/projects.json`
- Per-project config: `<project-dir>/.claude-panes/config.json` (layout, roles, tasks, research notes)
- Atomic writes via temp file + rename pattern

### Renderer UI (`src/renderer/app.ts`)

The main UI orchestrator (~1200 lines). Event-driven: IPC events → UI state updates → DOM rendering. Key UI regions: sidebar (project rail), workspace (split pane terminals), context panel (tasks/notes/activity feed), status bar (project info, token stats).

## Tech Stack

- **Electron 33** + **TypeScript** (strict mode)
- **xterm.js** for terminal rendering
- **node-pty** for PTY process management
- **esbuild** for renderer bundling (IIFE format)
- **js-yaml** for config parsing
- **electron-builder** for DMG packaging

## Build Output

- Main process: `dist/main/index.js`
- Renderer bundle: `dist/renderer/app.js` (IIFE) + `index.html` + `styles.css`
- Release artifacts: `release/`
