# Groundcrew

Your ground crew keeps the copilot flying.

Groundcrew is a [Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) plugin that turns GitHub Copilot into an autonomous task execution engine. Queue tasks, send feedback mid-flight, and let the agent work through your entire backlog — all from the terminal.

One prompt. Unlimited tasks. Minimal premium requests.

## How It Works

```
Terminal 1 (Copilot CLI)              Terminal 2 (You)
─────────────────────────             ─────────────────────────
$ copilot                             $ groundcrew add "build auth module"
                                      $ groundcrew add "write tests"
> "start groundcrew"                  $ groundcrew add "fix CSS on login"
                                      
  Agent: reads PRD, makes plan        $ groundcrew status
  Agent: calls get_task ◄─────────────── queue delivers task 1
  Agent: builds auth module           $ groundcrew feedback "use bcrypt"
  Agent: calls get_feedback ◄─────────── feedback delivered mid-task
  Agent: adjusts, finishes            
  Agent: calls get_task ◄─────────────── queue delivers task 2
  Agent: writes tests                 $ groundcrew add --priority "hotfix!"
  Agent: calls get_task ◄─────────────── priority task jumps the line
  Agent: fixes hotfix                 
  ...continues until queue empty...   $ groundcrew history
  Agent: "Parked. Type continue       
         to resume."                  $ groundcrew add "build dashboard"
> "continue" ─────────────────────────── agent wakes, keeps going
```

### The Core Loop

```
┌──────────┐     ┌───────────┐     ┌──────────┐     ┌───────────┐
│ get_task  │────►│  execute   │────►│ mark_done│────►│ get_task   │──► ...
│ (blocks)  │     │  (tools)   │     │          │     │ (blocks)   │
└──────────┘     └─────┬─────┘     └──────────┘     └───────────┘
                       │
                 ┌─────▼─────┐
                 │get_feedback│
                 │  (quick)   │
                 └───────────┘
```

The agent calls `get_task` after each completed task. This MCP tool **blocks** until you add a task to the queue — no LLM calls while waiting, no premium requests burned. When you add a task from another terminal, the file watcher fires, the tool returns, and the agent continues working.

### Premium Request Savings

| Without Groundcrew | With Groundcrew |
|---|---|
| "build auth" → 1 request | "start groundcrew" → 1 request |
| "continue" → 1 request | `groundcrew add "..."` → 0 requests |
| "looks good, now tests" → 1 request | `groundcrew feedback "..."` → 0 requests |
| "what's the status?" → 1 request | `groundcrew status` → 0 requests (local) |
| **10 tasks ≈ 20 prompts** | **10 tasks ≈ 1-3 prompts** |

MCP tool responses are not user prompts. The agent's internal loop (tool calls → reasoning → more tool calls) runs without consuming your premium quota.

## Installation

### Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) installed
- Node.js 22+
- An active GitHub Copilot subscription

### Install

```bash
copilot plugin install jellythomas/groundcrew
```

That's it. One command installs the MCP server, hooks, and the CLI companion.

### Set Up the CLI Companion

```bash
# Install the CLI globally
npm install -g groundcrew-cli

# Initialize groundcrew in your project (one-time setup)
cd your-project
groundcrew init
```

### Verify

```bash
# Check plugin is loaded (inside Copilot interactive mode)
/plugin list

# Check CLI is available
groundcrew --help
```

## Usage

### Quick Start

```bash
# Terminal 1: Start Copilot and activate groundcrew
copilot
> "start groundcrew"
```

```bash
# From another terminal: manage the queue
groundcrew add "build the user registration endpoint"
groundcrew add "add input validation"
groundcrew add "write integration tests"
groundcrew status
```

### Plan-Driven Execution

Give the agent a large task and it decomposes it into queue items automatically:

```bash
> "Build a complete authentication system. Break it into steps and use groundcrew to execute each one."

# Agent generates a plan:
#   1. Create user model and migration
#   2. Build registration endpoint
#   3. Build login endpoint with JWT
#   4. Add auth middleware
#   5. Write tests
#
# Agent calls populate_queue with all 5 steps
# Agent calls get_task, starts executing step 1
# ...processes all steps autonomously
```

### Mid-Task Feedback

The agent periodically checks for feedback between steps. Write feedback from another terminal and the agent incorporates it immediately:

```bash
groundcrew feedback "use bcrypt instead of argon2 for password hashing"
groundcrew feedback "skip the email verification for now, we'll add it later"
```

### Priority Tasks

Inject an urgent task that jumps to the front of the queue:

```bash
groundcrew add --priority "the migration is broken, fix it before continuing"
```

The agent picks this up on its next `get_task` call, before any normal-priority tasks.

### Session Lifecycle

```bash
# Agent works through queue...
# Queue empties...
# Agent parks: "All tasks complete. Groundcrew parked."

# Later, add more tasks:
groundcrew add "build the dashboard"
groundcrew add "add charts to dashboard"

# Wake the agent with one word:
> "continue"
# Agent resumes, processes new tasks
```

### Multiple Sessions

Run multiple Copilot CLI instances in the same project — each gets an isolated queue and feedback channel:

```bash
# Terminal 1                           Terminal 2
$ copilot                              $ copilot
> "build the backend with groundcrew"  > "build the frontend with groundcrew"
  → session: a1b2c3d4                    → session: e5f6g7h8

# Terminal 3: Manage both
$ groundcrew sessions
  * a1b2c3d4  active | backend
  * e5f6g7h8  active | frontend

$ groundcrew add --session a1b2c3d4 "add rate limiting"
$ groundcrew add --session e5f6g7h8 "fix the nav bar"
$ groundcrew feedback --session a1b2c3d4 "use Redis for rate limit store"
```

Without `--session`, commands auto-target the most recent active session.

## CLI Reference

### `groundcrew add <task>`

Add a task to the queue. The agent picks it up on its next `get_task` call.

```bash
groundcrew add "implement the search feature"
groundcrew add --priority "fix: API returning 500 on /users"
groundcrew add -p "urgent: rollback the migration"
groundcrew add --session a1b2c3d4 "task for a specific session"
```

| Flag | Description |
|---|---|
| `--priority`, `-p` | Mark as urgent (priority 9). Jumps to front of queue. |
| `--session <id>` | Target a specific session instead of auto-detecting. |

### `groundcrew feedback <message>`

Send feedback to the agent mid-task. The agent checks for feedback between major steps via `get_feedback`.

```bash
groundcrew feedback "use PostgreSQL not SQLite"
groundcrew feedback "the test is failing because of a missing env var, check .env.example"
groundcrew feedback --session a1b2c3d4 "feedback for a specific session"
```

### `groundcrew queue`

List all pending tasks in the queue, ordered by priority.

```bash
groundcrew queue
```

```
Pending tasks (3):

  1. [P9] fix: API returning 500 on /users
     user | task-1234567890-abc123
  2. implement the search feature
     user | task-1234567891-def456
  3. add pagination to results
     plan | task-1234567892-ghi789

  2 task(s) completed this session.
```

### `groundcrew status`

Show current session status, active task, and the last progress update from the agent.

```bash
groundcrew status
groundcrew status --session a1b2c3d4
```

```
Session:
  ID:        a1b2c3d4
  Status:    active
  Duration:  45min
  Completed: 3 tasks
  Current:   task-1234567892-ghi789

Queue: 2 pending

Last update: Added pagination component with next/prev buttons
  Progress: 2/3 steps
  2025-04-12T10:30:00Z
```

### `groundcrew sessions`

List all active and recent sessions. Each Copilot CLI instance gets its own isolated session.

```bash
groundcrew sessions
```

```
Sessions:

  * a1b2c3d4  active | 45min | 3 tasks done | 2 queued
  * e5f6g7h8  active | 12min | 0 tasks done | 5 queued
    f9a0b1c2  parked | 120min | 8 tasks done | 0 queued

  * = active (MCP server running)
```

### `groundcrew history`

Show all tasks completed in the current session.

```bash
groundcrew history
```

### `groundcrew clear`

Remove all pending tasks from the queue. Does not affect completed tasks.

```bash
groundcrew clear
```

## MCP Tools

These MCP tools are always available when the plugin is installed. The loop protocol is embedded in the tool descriptions and responses — Copilot automatically follows the get_task → execute → mark_done → get_task cycle.

| Tool | Blocking | Description |
|---|---|---|
| `get_task` | Yes | Returns the next task from the queue. Blocks until a task is available or timeout. Retries with backoff, then parks the session. |
| `get_feedback` | Yes (short) | Checks for user feedback in `.groundcrew/feedback.md`. Blocks briefly (default 30s), returns null if no feedback. |
| `mark_done` | No | Marks a task as complete with a summary. Increments the session completion counter. |
| `report_status` | No | Reports progress on the current task. Triggers session health warnings at 90/120 minutes. |
| `populate_queue` | No | Adds multiple tasks at once. Used by the agent after decomposing a plan into steps. |
| `list_queue` | No | Returns all pending tasks. Used to preview upcoming work. |
| `session_info` | No | Returns session ID and status. Display to user for session targeting. |

## Plugin Structure

```
groundcrew/
├── plugin.json              # Copilot CLI plugin manifest
├── .mcp.json                # MCP server configuration
├── hooks.json               # Session lifecycle hooks
├── server/                  # MCP server (loop protocol in tool descriptions)
│   ├── src/
│   │   ├── index.ts         # Server entry, tool handlers
│   │   ├── paths.ts         # Session-scoped file path management
│   │   ├── queue.ts         # Queue read/write/watch
│   │   ├── feedback.ts      # Feedback file watcher
│   │   └── session.ts       # Session health tracking
│   └── dist/
│       └── index.js         # Bundled output (~500KB, zero runtime deps)
└── cli/                     # CLI companion (TypeScript, bundled)
    ├── src/
    │   └── index.ts         # CLI entry, all commands
    └── dist/
        └── index.js         # Bundled output (~7KB, zero runtime deps)
```

## Configuration

Environment variables for the MCP server (set in `.mcp.json` or system env):

| Variable | Default | Description |
|---|---|---|
| `GROUNDCREW_TASK_TIMEOUT` | `300000` | How long `get_task` blocks per attempt (ms) |
| `GROUNDCREW_MAX_IDLE_RETRIES` | `3` | Retry attempts before parking |
| `GROUNDCREW_HUMAN_DELAY_MIN` | `2000` | Minimum delay on auto-responses (ms) |
| `GROUNDCREW_HUMAN_DELAY_MAX` | `6000` | Maximum delay on auto-responses (ms) |

## Session Health

Groundcrew tracks session duration and warns when quality may degrade:

- **90 minutes**: Advisory — "Consider creating a checkpoint."
- **120 minutes**: Warning — "Quality may degrade. Consider a fresh session."

These warnings appear in `report_status` responses.

## Files Created

Groundcrew creates a `.groundcrew/` directory in your project root with session-scoped isolation:

```
.groundcrew/
├── active-sessions.json              # Tracks running MCP server instances
└── sessions/
    ├── a1b2c3d4/                     # Session 1 (isolated)
    │   ├── queue.json                # Task queue (pending + completed)
    │   ├── feedback.md               # Feedback file (write here, agent reads)
    │   ├── session.json              # Session metadata (start time, status, task count)
    │   └── status.json               # Status reports log from the agent
    └── e5f6g7h8/                     # Session 2 (isolated)
        ├── queue.json
        ├── feedback.md
        ├── session.json
        └── status.json
```

Each Copilot CLI instance generates a unique session ID on startup. All data is scoped to that session — no cross-talk between concurrent sessions.

Add `.groundcrew/` to your `.gitignore`.

## Development

```bash
# Clone
git clone https://github.com/jellythomas/groundcrew.git
cd groundcrew

# Build the MCP server
cd server && npm install && npm run build && cd ..

# Build the CLI
cd cli && npm install && npm run build && cd ..

# Install plugin locally for testing
copilot plugin install .

# Install CLI globally for testing
cd cli && npm install -g . && cd ..

# Test
groundcrew --help
groundcrew init
groundcrew add "test task"
groundcrew queue
```

## Inspired By

[TaskSync](https://github.com/4regab/TaskSync) — the original VS Code extension that pioneered human-in-the-loop task orchestration for Copilot. Groundcrew brings the same concept to Copilot CLI as a native plugin.

## License

MIT
