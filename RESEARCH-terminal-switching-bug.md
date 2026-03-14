# Terminal Switching Bug — Research & Findings

This document captures deep investigation into the project-switching terminal bug so future attempts don't retread the same ground. The bug has been attempted multiple times without full resolution.

## Symptoms

When switching between projects in the sidebar:
1. **White/colorless terminals** — Claude CLI output loses its ANSI colors (orange tones become white text)
2. **Empty terminals** — some panes show the title bar but no terminal content; Claude never spawns
3. **Broken cursor** — cursor renders in wrong position or duplicates after switching back
4. **Inconsistency** — not all panes break; some work fine in the same switch operation

## Architecture Context (read this first)

The terminal lifecycle during a project switch involves **three layers** that must coordinate:

### Layer 1: Main Process PTY (`pty-manager.ts`)
- PTY sessions keyed by `projectId:paneId`
- `outputBuffer: string[]` — ring buffer of raw PTY output lines (WITH ANSI codes), max 10k lines
- `session.onData` callback fires batched (16ms) PTY output to renderer via IPC
- PTY keeps running after terminal UI is detached (by design)
- `getOutputBuffer()` joins lines with `\n` — available via `api.pty.getBuffer()`

### Layer 2: Renderer Terminal (`terminal-pane.ts`)
- `terminals` Map stores active `TerminalPane` instances
- `detachedSnapshots` Map stores text captured at detach time
- `createTerminalPane()` — new xterm + new PTY spawn
- `createTerminalPaneWithoutSpawn()` — new xterm wired to existing PTY
- `reattachTerminal()` — checks `isAlive`, then chooses create vs reattach path
- `detachTerminalPane()` — disposes xterm, does NOT kill PTY

### Layer 3: DOM Layout (`pane-layout.ts`)
- `renderPaneTree()` builds DOM from binary split tree
- Tries to preserve existing xterm DOM elements across re-renders
- For new panes: creates empty `.pane-terminal` div, calls `onPaneMount` synchronously
- **Critical**: In split trees, child leaves are rendered BEFORE their split container is appended to the document. This means `onPaneMount` fires while the container is in a detached DOM subtree.

### IPC Data Flow
- PTY output: `node-pty` → `session.onData` callback → `win.webContents.send('pty:data', paneId, data)` → renderer `api.pty.onData` → `writeToTerminal(paneId, data)`
- If no terminal exists for `paneId` when data arrives, it's **silently dropped**

## Root Causes Identified

### Root Cause 1: Snapshot Strips ANSI Codes

`detachTerminalPane()` calls `extractTerminalContent()` which uses xterm's `buffer.getLine(i).translateToString(true)`. This produces **plain text** — all ANSI escape codes (colors, cursor positioning, bold, etc.) are stripped.

When `reattachTerminal()` restores this snapshot via `term.write(snapshot)`, the terminal shows white text because there are no ANSI color codes in the content.

**The main process `outputBuffer` preserves raw ANSI output** and is accessible via `api.pty.getBuffer(paneId, projectId)`. This is the correct data source for reattach.

### Root Cause 2: Container Layout Race Condition

Both `createTerminalPane` and `createTerminalPaneWithoutSpawn` originally used a single `requestAnimationFrame` to fit the terminal and spawn/resize the PTY. But due to how `renderPaneTree` builds the DOM:

1. Leaf nodes call `onPaneMount` synchronously
2. Split containers are appended to their parent AFTER child rendering
3. So leaf containers may be in a **detached DOM subtree** when `onPaneMount` fires

A single `requestAnimationFrame` is not guaranteed to run after the full DOM tree is attached and laid out by the browser. If `fitAddon.fit()` runs before the container has dimensions:
- `term.cols` = 0, `term.rows` = 0
- `api.pty.spawn()` with 0x0 dimensions may fail silently or produce a broken PTY
- Terminal appears empty

This is **non-deterministic** — it depends on browser layout timing, tree depth, and system load. This is why some panes work and others don't in the same switch operation.

### Root Cause 3: PTY Output Lost During Switch

While a project's terminals are detached (user is viewing another project):
1. PTYs keep running and producing output
2. `session.onData` fires → sends IPC `pty:data` to renderer
3. Renderer calls `writeToTerminal(paneId, data)` → `terminals.get(paneId)` returns undefined → data dropped
4. When switching back, the detached snapshot is stale and the live output is gone

The main process `outputBuffer` partially mitigates this (it stores the last 10k lines), but it stores lines split by `\n` and joined back — which may not perfectly reproduce the raw byte stream. It's still far better than the stripped snapshot.

### Root Cause 4: Cursor Position Mismatch

When reattaching with snapshot content:
1. Snapshot text is written to a fresh terminal at position (0,0)
2. The live PTY's cursor is at a completely different position
3. New PTY output arrives and is written relative to the PTY's actual cursor
4. Result: garbled display, duplicate cursors, text in wrong positions

Using the raw output buffer instead of stripped text helps because the ANSI cursor positioning sequences are preserved, but the buffer may not contain the complete history needed to perfectly reconstruct the terminal state.

## Fixes Applied (current state)

### Fix 1: `waitForLayout()` helper
Added a polling function that waits for `container.offsetWidth > 0 && container.offsetHeight > 0` via `requestAnimationFrame` loop, with a 500ms safety timeout. Both `createTerminalPane` and `createTerminalPaneWithoutSpawn` use this instead of single RAF. Also added fallback dimensions (`cols: 80, rows: 24`) if fit somehow produces 0.

### Fix 2: Raw buffer reattach
`reattachTerminal()` now calls `api.pty.getBuffer(paneId, projectId)` to get the main process output buffer (with ANSI codes preserved) instead of using `detachedSnapshots` (which stripped formatting).

### Fix 3: Concurrency guard in `openProject()`
Added `projectSwitchGeneration` counter. Checked after each `await` to abort if a newer switch superseded the current one. Also added early return for `projectPath === currentProjectPath`.

### Fix 4: Immediate workspace DOM clear
`workspaceEl.innerHTML = ''` runs right after `detachAllTerminals()`, before async IPC calls, so dead terminal DOM is never visible.

## Known Remaining Risks

### Output buffer fidelity
The main process `outputBuffer` stores lines split by `\n` and joined back. Raw PTY output may contain partial ANSI sequences split across data chunks, binary data, or `\r\n` vs `\r` differences that get mangled by the split/join. If terminals still show color artifacts, this is the likely cause.

**Potential improvement**: Store raw data chunks in the ring buffer instead of splitting by newline. Use a circular byte buffer with a max size rather than a line-based array.

### Missed output between detach and reattach
Output produced by the PTY between the `getBuffer()` call and the terminal being ready to receive live IPC data is lost. There's a brief window where:
1. `getBuffer()` returns buffer at time T1
2. Terminal is created and registered in `terminals` Map at time T2
3. Any PTY output between T1 and T2 is delivered via IPC but the terminal may not be mounted yet

**Potential improvement**: Have the main process pause IPC delivery for a session during reattach, queue output, and flush it after the renderer signals ready.

### `waitForLayout` timeout
If a container genuinely never gets dimensions (CSS bug, parent collapsed, etc.), the 500ms timeout fires and the terminal spawns with fallback 80x24. This is a safety net, not a fix — the underlying layout issue would still need debugging.

### Split tree DOM ordering
The fundamental issue of `renderPaneTree` calling `onPaneMount` before the container is in the document hasn't been structurally fixed. The `waitForLayout` approach works around it, but a cleaner fix would be to defer all `onPaneMount` calls until after the entire tree is appended to the document (e.g., build the DOM tree fully detached, append it to the workspace, THEN trigger all mounts).

## Debugging Tips

- Add `console.log('[terminal] fit:', paneId, container.offsetWidth, container.offsetHeight, term.cols, term.rows)` in the fit callback to see if containers have dimensions
- Add `console.log('[terminal] spawn:', paneId, cols, rows)` to verify PTY spawn dimensions
- Add `console.log('[terminal] reattach:', paneId, 'alive:', alive, 'bufferLen:', buffer?.length)` to trace reattach path
- Check the main process console for PTY spawn errors (node-pty logs to stderr)
- The `api.pty.getBuffer()` result can be inspected for ANSI codes — if it's plain text, the outputBuffer storage is the problem

## File Reference

| What | Where |
|------|-------|
| Terminal create/detach/reattach | `src/renderer/terminal-pane.ts` |
| DOM tree rendering | `src/renderer/pane-layout.ts` |
| Project switch orchestration | `src/renderer/app.ts` → `openProject()` |
| PTY lifecycle & buffer | `src/main/pty-manager.ts` |
| IPC wiring (spawn, data routing) | `src/main/ipc-handlers.ts` lines 130-170 |
| Theme definitions & terminal theme | `src/renderer/themes.ts` |
| Preload bridge (available IPC) | `src/preload/index.ts` |
