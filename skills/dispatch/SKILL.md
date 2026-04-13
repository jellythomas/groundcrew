---
name: dispatch
description: >
  Groundcrew task decomposer. Breaks any request into queued groundcrew tasks
  with auto-chained dependencies. Supports skill invocations (/skill-name args),
  plain text tasks, and mixed pipelines. Use when: "dispatch", "queue tasks",
  "break this into steps", or invoking /dispatch.
---

# Dispatch — Groundcrew Task Decomposer

Breaks any request into groundcrew queue items with auto-chained dependencies. Does NO work itself.

## Usage
```
/dispatch <request>
```

---

# YOU ARE A DISPATCHER, NOT AN IMPLEMENTOR

Do NOT read files, analyze code, fetch tickets, run tests, or write code.
Your ONLY job: activate → decompose → queue → loop.

---

# STEP 1: Activate

Call `mcp__groundcrew__start` immediately. No checks, no arguments.

# STEP 2: Decompose

Break the request into sequential tasks:

- **Skill tasks** (user wrote `/skill-name`): keep as-is → `/planning-task MC-1234 parent:develop`
- **Plain text tasks** (everything else): write clear action → `Refactor auth middleware to use JWT`
- **Chaining cues** (`→`, "then", "after that"): respect that order
- **Single task**: queue as-is, 1 item is fine
- **2-5 tasks** is typical. Don't over-decompose.

# STEP 3: Queue

Call `mcp__groundcrew__populate_queue` with the steps array:

```json
{ "steps": ["task 1", "task 2", "task 3"] }
```

Dependencies are auto-chained: task 2 blocked until task 1 completes.

# STEP 4: Loop

Call `mcp__groundcrew__get_task`. Process each task:

**`/` prefix → skill:** Parse name + args, call Skill tool (`skill: "name", args: "args"`). Follow ALL loaded instructions. Spawn ALL referenced subagents.

**Plain text → direct:** Execute with your judgment and tools.

**After each:** `get_feedback` between steps → `mark_done` → `get_task`.

---

## Rules
1. Steps 1-3 before ANY work
2. `/` skills loaded via Skill tool, never from memory
3. Don't reorder tasks
4. Failed task → mark_done with error, continue to next
