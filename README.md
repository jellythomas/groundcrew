# Groundcrew

Your ground crew keeps the copilot flying.

Groundcrew is a [Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) plugin that turns GitHub Copilot into an autonomous task execution engine. Queue tasks, send feedback mid-flight, and let the agent work through your entire backlog — all from the terminal.

One prompt. Unlimited tasks. Minimal premium requests.

## How It Works

```
Terminal 1 (Copilot CLI)              Terminal 2 (groundcrew chat)
─────────────────────────             ─────────────────────────
$ copilot                             $ groundcrew chat
                                      
> "start groundcrew"                  [a1b2c3d4] > build auth module
                                      ✓ Queued
  Agent: reads PRD, makes plan        
  Agent: calls get_task ◄─────────────── queue delivers task
  Agent: builds auth module           [a1b2c3d4] > /feedback use bcrypt
  Agent: calls get_feedback ◄─────────── feedback delivered mid-task
  Agent: adjusts, finishes            [a1b2c3d4] > /priority hotfix!
  Agent: calls get_task ◄─────────────── priority task jumps the line
  Agent: fixes hotfix                 
  ...continues until queue empty...   [a1b2c3d4] > /history
  ...waits up to 90 min for tasks...  [a1b2c3d4] > write tests
  Agent: "Session ended."             ✓ Queued
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

The agent calls `get_task` after each completed task. This MCP tool **blocks** until you add a task to the queue — no LLM calls while waiting, no premium requests burned. It polls every 1 second for up to 90 minutes (configurable). When you add a task, it's picked up within a second.

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
# Terminal 2: Open interactive chat
groundcrew chat
```

That's it. Type tasks in the chat, they get queued and processed automatically.

### Interactive Chat Mode (Recommended)

`groundcrew chat` opens an interactive REPL with tab-completion and multiline support:

```
$ groundcrew chat

Groundcrew chat — a1b2c3d4 (my-project)
Type tasks to queue. Press Tab to autocomplete commands.
Use """ to start/end multiline input.

  Commands:
    /feedback      Send feedback to the agent mid-task
    /priority      Queue an urgent task (processed first)
    /switch        Switch to another active session
    /sessions      List all active sessions
    /status        Show current session status
    /history       Show completed tasks
    /queue         Show pending tasks
    /clear         Clear pending tasks
    /quit          Exit chat

[a1b2c3d4] > build the user registration endpoint
✓ Queued

[a1b2c3d4] > /feedback use bcrypt for password hashing
✓ Feedback sent

[a1b2c3d4] > /priority fix: API returning 500
✓ Queued (priority)

[a1b2c3d4] > /status
Session:
  ID: a1b2c3d4 | active | 12min | 3 done
```

**Tab completion:** Type `/` then Tab to see all commands. Type `/f` then Tab to autocomplete to `/feedback`.

**Multiline input:** End a line with `\` to continue on the next line:

```
[a1b2c3d4] > analyze this codebase:\
[a1b2c3d4] ... - check for security issues\
[a1b2c3d4] ... - suggest performance improvements\
[a1b2c3d4] ... - identify missing tests
✓ Queued
```

### Classic CLI Mode

You can also use individual commands if you prefer:

```bash
groundcrew add "build the user registration endpoint"
groundcrew add --priority "fix: API returning 500"
groundcrew feedback "use bcrypt for password hashing"
groundcrew status
groundcrew queue
groundcrew history
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

### Multiple Sessions

Run multiple Copilot CLI instances in the same project — each gets an isolated queue:

```bash
# Terminal 1                           Terminal 2
$ copilot                              $ copilot
> "build the backend with groundcrew"  > "build the frontend with groundcrew"
  → session: a1b2c3d4                    → session: e5f6g7h8
```

```bash
# Terminal 3: Chat with session switching
$ groundcrew chat

Multiple sessions active:
  1. a1b2c3d4  my-project  active | 45min | 3 done | 2 queued
  2. e5f6g7h8  my-project  active | 12min | 0 done | 5 queued

Pick session [1-2]: 1

[a1b2c3d4] > add rate limiting
✓ Queued

[a1b2c3d4] > /switch 2
Switched to e5f6g7h8 (my-project)

[e5f6g7h8] > fix the nav bar
✓ Queued
```

### Session Management

```bash
# Stop a specific session
groundcrew stop --session a1b2c3d4

# Stop all active sessions
groundcrew stop

# Delete a specific session and its data
groundcrew destroy --session a1b2c3d4

# Delete all sessions, history, and data
groundcrew destroy
```

### Session Timeout

Sessions stay alive for **90 minutes** by default, polling every 1 second for new tasks. When the timeout expires, the session automatically ends and cleans up. Configure via environment variable:

```json
// .mcp.json
{
  "env": {
    "GROUNDCREW_SESSION_TIMEOUT": "5400000"  // 90 min (default)
  }
}
```

Set to `"900000"` for 15 min, `"3600000"` for 1 hour, `"7200000"` for 2 hours.

### Persistent History

Task history persists across sessions in `.groundcrew/history.json`. View completed tasks with full AI output even after sessions end:

```bash
groundcrew history
```

```
Completed tasks (3):

  task  build the user registration endpoint
  done  Created /api/users endpoint with validation, bcrypt hashing, JWT tokens
  ───────────────────────────────────────
  │ Full AI response with code changes,
  │ analysis, and detailed output...
  ───────────────────────────────────────
        2026-04-12T10:30:00Z | user | task-1234567890-abc123
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
| `groundcrew feedback --session <id> <msg>` | Send feedback to a specific session |
| `groundcrew queue` | List pending tasks |
| `groundcrew status` | Show session status and last update |
| `groundcrew sessions` | List all sessions |
| `groundcrew history` | Show completed tasks (persists across sessions) |
| `groundcrew clear` | Clear all pending tasks |
| `groundcrew stop` | Stop all active sessions |
| `groundcrew stop --session <id>` | Stop a specific session |
| `groundcrew destroy` | Delete all sessions, history, and data |
| `groundcrew destroy --session <id>` | Delete a specific session |
| `groundcrew init` | Initialize .groundcrew/ in current dir |

### Chat Commands

Inside `groundcrew chat`, these commands are available (with Tab completion):

| Command | Description |
|---|---|
| `/feedback <msg>` | Send feedback to the agent mid-task |
| `/priority <task>` | Queue an urgent task (processed first) |
| `/switch [N]` | Switch to another active session |
| `/sessions` | List all active sessions |
| `/status` | Show current session status |
| `/history` | Show completed tasks |
| `/queue` | Show pending tasks |
| `/clear` | Clear pending tasks |
| `/quit` | Exit chat |
| `\` (end of line) | Continue input on next line |

## MCP Tools

These MCP tools are available when the plugin is installed. The agent automatically follows the get_task → execute → mark_done → get_task cycle via server instructions.

| Tool | Blocking | Description |
|---|---|---|
| `start` | No | Activates groundcrew mode. Called automatically when user mentions "groundcrew". Shows session ID and CLI commands. |
| `get_task` | Yes (up to 90 min) | Returns the next task. Blocks with 1s polling until a task is available or session timeout. |
| `get_feedback` | Yes (30s) | Checks for user feedback. Blocks briefly, returns null if no feedback. |
| `mark_done` | No | Marks task complete with summary and full output. Saves to session and project-level history. |
| `report_status` | No | Reports progress. Triggers health warnings at 90/120 minutes. |
| `populate_queue` | No | Adds multiple tasks at once. Used after decomposing a plan into steps. |
| `list_queue` | No | Returns all pending tasks. |
| `session_info` | No | Returns session ID and status. |

## Configuration

Environment variables for the MCP server (set in `.mcp.json`):

| Variable | Default | Description |
|---|---|---|
| `GROUNDCREW_SESSION_TIMEOUT` | `5400000` | How long `get_task` blocks waiting for tasks (ms). Default 90 min. |

## Files Created

Groundcrew creates a `.groundcrew/` directory in your project root:

```
.groundcrew/
├── active-sessions.json              # Tracks running MCP server instances
├── history.json                      # Completed tasks across all sessions (persistent)
├── session.json                      # Hook-managed session metadata
├── tool-history.csv                  # Audit log of all tool calls
└── sessions/
    ├── a1b2c3d4/                     # Session 1 (isolated)
    │   ├── queue.json                # Task queue (pending + completed)
    │   ├── feedback.md               # Feedback channel (user writes, agent reads)
    │   ├── session.json              # Session metadata
    │   └── status.json               # Status reports from the agent
    └── e5f6g7h8/                     # Session 2 (isolated)
        └── ...
```

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
