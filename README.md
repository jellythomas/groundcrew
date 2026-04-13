# Groundcrew

Your ground crew keeps the copilot flying.

Groundcrew is a Copilot CLI plugin that turns Copilot into an autonomous task execution engine. Queue tasks, send feedback mid-flight, and let the agent work through your entire backlog — all from the terminal.

One prompt. Unlimited tasks. Minimal premium requests.

## How It Works

```
Terminal 1 (Copilot CLI)              Terminal 2 (groundcrew chat)
─────────────────────────             ─────────────────────────
$ copilot                              $ groundcrew chat

> "start groundcrew"                  [myproject-a1b2] > build auth module
                                      ✓ Queued
  Agent: reads PRD, makes plan        
  Agent: calls get_task ◄─────────────── queue delivers task
  Agent: builds auth module           [myproject-a1b2] > /feedback use bcrypt
  Agent: calls get_feedback ◄─────────── feedback delivered mid-task
  Agent: adjusts, finishes            [myproject-a1b2] > /priority hotfix!
  Agent: calls get_task ◄─────────────── priority task jumps the line
  Agent: fixes hotfix                 
  ...continues until queue empty...   [myproject-a1b2] > /history
  ...blocks up to 90 min for tasks... [myproject-a1b2] > write tests
  Agent: "Session ended."             ✓ Queued
```

### The Core Loop

```
┌──────────┐     ┌───────────┐     ┌──────────┐     ┌───────────┐
│ get_task  │────►│  execute   │────►│ mark_done│────►│ get_task   │──► ...
│ (blocks)  │     │  (tools)   │     │          │     │ (blocks)   │
└───────────┘     └─────┬─────┘     └──────────┘     └───────────┘
                        │
                   ┌───────────┐
                   │get_feedback│
                   │  (quick)   │
                   └───────────┘
```

`get_task` **blocks** until a task arrives — no polling, no retrying, no context waste. MCP progress heartbeats keep the connection alive. When you add a task from another terminal, `fs.watch` detects the queue change and delivers it instantly.

### Premium Request Savings

| Without Groundcrew | With Groundcrew |
|---|---|
| "build auth" → 1 request | "start groundcrew" → 1 request |
| "continue" → 1 request | `groundcrew add "..."` → 0 requests |
| "looks good, now tests" → 1 request | `/feedback "..."` → 0 requests |
| "what's the status?" → 1 request | `/status` → 0 requests (local) |
| **10 tasks ≈ 20 prompts** | **10 tasks ≈ 1-3 prompts** |

MCP tool responses are not user prompts. The agent's internal loop (tool calls → reasoning → more tool calls) runs without consuming your premium quota.

## Installation

### Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot) installed
- Node.js 20+

### Install

```bash
copilot plugin install jellythomas/groundcrew
```

Installs the MCP server, hooks, CLI companion, and the `/dispatch` command.

### Set Up the CLI Companion

```bash
npm install -g groundcrew-cli
```

No `init` needed — `~/.groundcrew/` is created automatically on first use.

### Verify

```bash
# Check CLI is available
groundcrew --help
```

## Usage

### Quick Start

```bash
# Terminal 1: Start Copilot CLI and activate groundcrew
copilot
> "start groundcrew"
```

```bash
# Terminal 2: Open interactive chat
groundcrew chat
```

Type tasks in the chat, they get queued and processed automatically.

### Dispatch: Queue Multiple Tasks

Use `/dispatch` to break a request into queued tasks. All tasks are **auto-chained with dependencies** — each waits for the previous one to complete.

**Chain skills explicitly:**
```
/dispatch /planning-task MC-1234 parent:develop → /developing-task MC-1234 parent:develop
```

**Full flow with PR:**
```
/dispatch /planning-task MC-1234 parent:develop → /developing-task MC-1234 parent:develop → /open-pr
```

**Let the agent decompose plain text:**
```
/dispatch refactor auth middleware, then write tests, then open a PR
```

**Mix skills and plain text:**
```
/dispatch /planning-task MC-5678 parent:main → implement the plan → /commit → /open-pr
```

**Batch multiple tickets sequentially:**
```
/dispatch /planning-task MC-100 parent:develop → /developing-task MC-100 parent:develop → /planning-task MC-101 parent:develop → /developing-task MC-101 parent:develop
```

**Or queue manually from CLI (no dispatch needed):**
```bash
groundcrew add "/planning-task MC-1234 parent:develop"
groundcrew add "/developing-task MC-1234 parent:develop"
groundcrew add "/open-pr"
```

> **How dependencies work:** `populate_queue` (used by dispatch) auto-chains tasks — task 2 depends on task 1, task 3 on task 2, etc. `get_task` won't return a task until its dependency is in `completed[]`. This is enforced server-side.

### Interactive Chat Mode (Recommended)

`groundcrew chat` opens an interactive REPL with tab-completion and multiline support:

```
$ groundcrew chat

Groundcrew chat — myproject-a1b2c3d4

  Commands:
    /feedback      Send feedback to the agent mid-task
    /priority      Queue an urgent task (processed first)
    /switch        Switch to another active session
    /sessions      List all active sessions
    /status        Show current session status
    /history       Show completed tasks
    /queue         Show pending tasks
    /clear         Clear pending tasks
    /exit          Exit chat

[myproject-a1b2] > build the user registration endpoint
✓ Queued

[myproject-a1b2] > /feedback use bcrypt for password hashing
✓ Feedback sent
```

**Multiline input:** End a line with `\` to continue:

```
[myproject-a1b2] > analyze this codebase:\
[myproject-a1b2] ... - check for security issues\
[myproject-a1b2] ... - suggest performance improvements
✓ Queued
```

### Skill-Based Tasks

Queue tasks that invoke skills (slash commands) by prefixing with `/`:

```bash
groundcrew add "/planning-task MC-1234 parent:develop"
groundcrew add "/developing-task MC-1234 parent:develop"
```

The groundcrew loop detects the `/` prefix and invokes the skill via the Skill tool. Plain text tasks are executed directly.

### Task Dependencies

Tasks queued via `populate_queue` are auto-chained — each depends on the previous:

```
populate_queue(["/planning-task MC-1234", "/developing-task MC-1234"])

→ task-1: /planning-task    (ready)
→ task-2: /developing-task  (blocked until task-1 completes)
```

`get_task` won't return task-2 until task-1 is in the completed list. Dependencies are enforced server-side.

### Classic CLI Mode

```bash
groundcrew add "build the user registration endpoint"
groundcrew add --priority "fix: API returning 500"
groundcrew feedback "use bcrypt for password hashing"
groundcrew status
groundcrew queue
groundcrew history
```

### Multiple Sessions

Sessions are centralized at `~/.groundcrew/` and prefixed with the repo name:

```bash
# From mekari_credit repo (or any of its worktrees) → session: mekari_credit-a1b2c3d4
# From groundcrew repo → session: groundcrew-e5f6g7h8
```

Worktrees resolve to the main repo — `mekari_credit/.worktrees/worktree-mc-9292` and `mekari_credit/` both produce `mekari_credit-*` sessions.

### Session Management

```bash
groundcrew sessions                          # List ALL sessions (all repos, grouped)
groundcrew sessions --repo mekari_credit     # Filter by repo
groundcrew sessions --status active          # Filter by status (active/parked/ended)
groundcrew sessions --repo myapp --status active  # Combine filters
groundcrew stop                              # Stop current repo's sessions
groundcrew stop --session myproject-a1b2c3d4 # Stop a specific session
groundcrew stop --session a1b2c3d4           # Short hex suffix also works
groundcrew destroy                           # Delete current repo's session data
```

### Session Lifecycle

**Idle Timeout (90 min default)** — `get_task` blocks for up to 90 minutes waiting for tasks. The timer resets on every task received or completed. If no tasks arrive for 90 minutes, the session ends.

**No max lifetime** — sessions stay alive as long as work keeps flowing. Only true idle kills them.

**MCP Heartbeats** — While blocking, `get_task` sends progress notifications every 30s to prevent MCP client timeout.

Configure via environment variables:

```json
{
  "env": {
    "GROUNDCREW_IDLE_TIMEOUT": "5400000"
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `GROUNDCREW_IDLE_TIMEOUT` | `5400000` (90 min) | End session after this much consecutive idle time |

### Persistent History

Task history persists across sessions in `~/.groundcrew/history.json`:

```bash
groundcrew history
```

## CLI Reference

| Command | Description |
|---|---|
| `groundcrew chat` | Interactive chat mode with tab-completion (recommended) |
| `groundcrew chat --session <id>` | Chat with a specific session |
| `groundcrew add <task>` | Add a task to the queue |
| `groundcrew add --priority <task>` | Add an urgent task (processed first) |
| `groundcrew add --session <id> <task>` | Add to a specific session |
| `groundcrew feedback <message>` | Send feedback to the agent mid-task |
| `groundcrew queue` | List pending tasks |
| `groundcrew status` | Show session status and last update |
| `groundcrew sessions` | List all sessions (all repos, grouped) |
| `groundcrew sessions --repo <name>` | Filter sessions by repo name |
| `groundcrew sessions --status <s>` | Filter by status (active/parked/ended) |
| `groundcrew history` | Show completed tasks (persists across sessions) |
| `groundcrew clear` | Clear all pending tasks |
| `groundcrew stop` | Stop current repo's sessions |
| `groundcrew stop --session <id>` | Stop a specific session |
| `groundcrew destroy` | Delete current repo's session data |
| `groundcrew destroy --session <id>` | Delete a specific session |

## MCP Tools

| Tool | Blocking | Description |
|---|---|---|
| `start` | No | Activates groundcrew. Creates session at `~/.groundcrew/sessions/<repo>-<hex>/`. |
| `get_task` | Yes (90 min) | Blocks until a task arrives or session times out. Sends heartbeat every 30s. |
| `get_feedback` | Yes (30s) | Checks for user feedback mid-task. |
| `mark_done` | No | Marks task complete with summary and full output. |
| `report_status` | No | Reports progress. Resets idle timer. |
| `populate_queue` | No | Adds multiple tasks with auto-chained dependencies. |
| `list_queue` | No | Returns all pending tasks. |
| `session_info` | No | Returns session ID and status. |

## Files Created

All data is centralized at `~/.groundcrew/`:

```
~/.groundcrew/
├── active-sessions.json              # Tracks running MCP server instances
├── history.json                      # Completed tasks across all sessions
├── tool-history.csv                  # Audit log of all tool calls
└── sessions/
    ├── myproject-a1b2c3d4/           # Session (repo-prefixed)
    │   ├── queue.json                # Task queue (pending + completed)
    │   ├── feedback.md               # Feedback channel
    │   ├── session.json              # Session metadata
    │   └── status.json               # Status reports
    └── myproject-e5f6g7h8/
        └── ...
```

## Bundled Commands

| Command | Description |
|---|---|
| `/dispatch` | Decomposes any request into queued groundcrew tasks. Supports skill invocations (`/skill-name args`) and plain text tasks. |

## Development

```bash
git clone https://github.com/jellythomas/groundcrew.git
cd groundcrew

# Build the MCP server
cd server && npm install && npm run build && cd ..

# Build the CLI
cd cli && npm install && npm run build && cd ..

# Install CLI globally for testing
cd cli && npm install -g . && cd ..

# Test
groundcrew --help
groundcrew add "test task"
groundcrew queue
```

## Inspired By

[TaskSync](https://github.com/4regab/TaskSync) — the original VS Code extension that pioneered human-in-the-loop task orchestration. Groundcrew brings the same concept to Copilot CLI as a native plugin.

## License

MIT
