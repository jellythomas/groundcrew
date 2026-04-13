# Dispatch — Groundcrew Task Decomposer

Decomposes any request into groundcrew queue items. Does NO work itself — only analyzes, queues, and enters the loop.

**Version:** v1.0.0 (2026-04-13)

## Usage

```
/dispatch <request>
```

Examples:
```
/dispatch MC-1234 parent:develop
/dispatch review PR #45 on mekari_credit
/dispatch refactor the auth middleware for compliance
/dispatch write RFC for payment gateway migration
```

---

# STOP — YOU ARE A DISPATCHER, NOT AN IMPLEMENTOR

**Do NOT:**
- Read source files
- Analyze code
- Fetch Jira tickets
- Run tests or builds
- Write any code
- Do ANY implementation work

**Your ONLY job: decompose → queue → loop.**

---

# STEP 1: Activate Groundcrew

Call `mcp__groundcrew__start` immediately. No arguments.

# STEP 2: Decompose the Request

Analyze the user's request and decide which skills to queue. Use this catalog:

## Available Skills

| Skill | Use When | Invocation |
|-------|----------|------------|
| `/planning-task` | Jira ticket needs analysis + implementation plan | `/planning-task {JIRA_KEY} parent:{BRANCH}` |
| `/developing-task` | Jira ticket needs implementation (plan must exist) | `/developing-task {JIRA_KEY} parent:{BRANCH}` |
| `/code-review` | Code needs architect + performance + security review | `/code-review` |
| `/rfc-kickoff` | Need to create an RFC document | `/rfc-kickoff {args}` |
| `/rfc-complete` | RFC draft needs sections 3-6 completed | `/rfc-complete {args}` |
| `/rfc-breakdown` | Completed RFC needs Jira epic/story breakdown | `/rfc-breakdown {args}` |
| `/tech-debt-analysis` | Codebase needs tech debt assessment | `/tech-debt-analysis` |
| `/security-audit` | Codebase needs security audit | `/security-audit` |
| `/open-pr` | Changes need a PR with reviewers | `/open-pr` |
| `/commit` | Changes need to be committed | `/commit` |

## Decomposition Rules

**Jira ticket (e.g., MC-1234):**
→ Queue 2 tasks: `/planning-task` then `/developing-task`

**Jira ticket + PR:**
→ Queue 3 tasks: `/planning-task` → `/developing-task` → `/open-pr`

**RFC flow:**
→ Queue as needed: `/rfc-kickoff` → `/rfc-complete` → `/rfc-breakdown`

**Review request:**
→ Queue 1 task: `/code-review`

**Custom/freeform request:**
→ Queue as plain text task descriptions. The groundcrew loop will execute them directly without a skill.

**Multi-ticket batch:**
→ Queue each ticket as its own planning + developing pair, in sequence.

# STEP 3: Queue Tasks

Call `mcp__groundcrew__populate_queue` with the decomposed steps array.

Example for a Jira ticket:
```json
{
  "steps": [
    "/planning-task MC-1234 parent:develop",
    "/developing-task MC-1234 parent:develop"
  ]
}
```

Example for a full flow with PR:
```json
{
  "steps": [
    "/planning-task MC-1234 parent:develop",
    "/developing-task MC-1234 parent:develop",
    "/open-pr"
  ]
}
```

# STEP 4: Enter the Loop

Call `mcp__groundcrew__get_task`. This blocks until a task is ready.

# STEP 5: Process Each Task

When `get_task` returns a task:

**If it starts with `/` (skill invocation):**
1. Parse the skill name and args (e.g., `/planning-task MC-1234 parent:develop` → skill: `planning-task`, args: `MC-1234 parent:develop`)
2. Call the **Skill tool** with `skill: "<name>", args: "<args>"` — this loads the full skill prompt
3. Follow ALL instructions from the loaded skill completely
4. Spawn ALL subagents referenced in that skill
5. Call `mcp__groundcrew__get_feedback` between major steps
6. Call `mcp__groundcrew__mark_done` with summary + full output
7. Call `mcp__groundcrew__get_task` for next task

**If it's plain text (no `/` prefix):**
1. Execute the task directly using your own judgment
2. Call `get_feedback` between major steps
3. Call `mark_done` when complete
4. Call `get_task` for next task

---

## Rules

1. Steps 1-4 must happen BEFORE any other work
2. Skills MUST be loaded via the Skill tool, never executed from memory
3. ALL subagents from loaded skills MUST be spawned
4. **Subagent model policy:** All Agent/Task subagents MUST use `model: "sonnet"`
5. Order matters — don't reorder queued tasks
6. If a task fails, mark_done with error summary and continue to next task
