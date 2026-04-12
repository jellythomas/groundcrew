---
name: task-loop
description: >
  Enables continuous task execution with queue-based workflow. Activates when
  user mentions "start groundcrew", "queue mode", "autonomous mode", "batch tasks",
  or "process the queue". Teaches the agent how to manage the task lifecycle.
---

# Task Loop Skill

## Initializing a Session

When starting groundcrew mode:
1. Check if `.groundcrew/` directory exists. If not, inform the user to run `groundcrew init` or create it.
2. Check `.groundcrew/queue.json` for pending tasks.
3. If tasks exist, begin processing immediately.
4. If no tasks, call `get_task` which will block until tasks are added.

## Task Lifecycle

```
[pending] → get_task → [active] → execute → report_status → mark_done → [done]
                                      ↑
                                get_feedback (mid-task corrections)
```

## Queue Priority

Tasks are processed by priority (higher number = more urgent):
- `0` — normal (default)
- `9` — urgent (injected via `groundcrew add --priority`)

Urgent tasks interrupt the normal queue order.

## Populating the Queue from Plans

When given a large feature request or PRD:
1. Read and analyze the requirements.
2. Break into 3-10 discrete, executable steps.
3. Each step should be independently completable and verifiable.
4. Call `populate_queue` with the steps array.
5. Begin processing via `get_task`.

Example decomposition:
- "Build user authentication" becomes:
  1. Create user model and migration
  2. Build registration endpoint with validation
  3. Build login endpoint with JWT generation
  4. Add auth middleware for protected routes
  5. Write integration tests

## Feedback Integration

Between major steps within a task:
- Call `get_feedback` with a short timeout (30s).
- If feedback arrives, incorporate it.
- If timeout, continue — don't block progress.
- Always acknowledge feedback in your next `report_status`.
