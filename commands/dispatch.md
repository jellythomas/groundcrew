# Dispatch — Groundcrew Task Decomposer

Breaks any request into groundcrew queue items. Does NO work itself — only decomposes, queues, and enters the loop.

**Version:** v2.0.0 (2026-04-13)

## Usage

```
/dispatch <request>
```

Examples:
```
/dispatch refactor the auth middleware, then write tests, then open a PR
/dispatch analyze the payment module for security issues and performance
/dispatch /planning-task MC-1234 parent:develop → /developing-task MC-1234 parent:develop → /open-pr
```

---

# STOP — YOU ARE A DISPATCHER, NOT AN IMPLEMENTOR

**Do NOT:**
- Read source files
- Analyze code
- Run tests or builds
- Write any code
- Do ANY implementation work

**Your ONLY job: activate groundcrew → decompose → queue → enter loop.**

---

# STEP 1: Activate Groundcrew

Call `mcp__groundcrew__start` immediately.

# STEP 2: Decompose the Request

Break the user's request into **sequential tasks**. Two formats:

**Skill tasks** — if the user explicitly wrote a `/skill-name`, keep it as-is:
```
/planning-task MC-1234 parent:develop
```

**Plain text tasks** — for everything else, write a clear action description:
```
Refactor auth middleware to use JWT validation
Write integration tests for the refactored auth middleware
```

### Decomposition guidelines:
- Each task should be **independently completable** — one clear deliverable
- Order matters — put dependencies first (plan before implement, implement before review)
- Don't over-decompose — 2-5 tasks is typical. Don't split what's naturally one unit of work
- If the request is already a single task, queue it as-is (1 item is fine)
- If the user chained tasks with "then", "→", "after that", respect that order

# STEP 3: Queue Tasks

Call `mcp__groundcrew__populate_queue` with the steps array.

```json
{
  "steps": [
    "first task description or /skill-name args",
    "second task description or /skill-name args"
  ]
}
```

# STEP 4: Enter the Loop

Call `mcp__groundcrew__get_task` to start processing.

# STEP 5: Process Each Task

When `get_task` returns a task:

**If it starts with `/` (skill invocation):**
1. Parse skill name and args (e.g., `/planning-task MC-1234` → skill: `planning-task`, args: `MC-1234`)
2. Call the **Skill tool** with `skill: "<name>", args: "<args>"`
3. Follow ALL instructions from the loaded skill
4. Spawn ALL subagents referenced in that skill

**If it's plain text:**
1. Execute the task directly using your judgment and available tools

**After each task:**
1. Call `mcp__groundcrew__get_feedback` between major steps
2. Call `mcp__groundcrew__mark_done` with summary + full output
3. Call `mcp__groundcrew__get_task` for next task

---

## Rules

1. Steps 1-4 must happen BEFORE any work — no file reads, no analysis
2. Skills referenced with `/` MUST be loaded via the Skill tool, never from memory
3. Order matters — don't reorder queued tasks
4. If a task fails, mark_done with error summary and continue to next task
