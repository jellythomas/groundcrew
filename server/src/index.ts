#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getNextTask,
  addTask,
  populateQueue,
  markTaskDone,
  listPending,
  listCompleted,
  cacheActiveTask,
  type BlockingOptions,
} from "./queue.js";
import { getFeedback, initFeedbackFile } from "./feedback.js";
import {
  reportStatus,
  incrementCompleted,
  parkSession,
  endSession,
  getStatus,
  updateSession,
} from "./session.js";
import { initPaths, createSession, cleanupSession, getSessionId } from "./paths.js";

// Config from environment (GROUNDCREW_SESSION_TIMEOUT is legacy alias for IDLE_TIMEOUT)
const IDLE_TIMEOUT = parseInt(process.env.GROUNDCREW_IDLE_TIMEOUT || process.env.GROUNDCREW_SESSION_TIMEOUT || "5400000");  // 90 min idle before session ends
const MAX_LIFETIME = parseInt(process.env.GROUNDCREW_MAX_LIFETIME || "0"); // 0 = no lifetime limit (only idle timeout ends sessions)
const FEEDBACK_TIMEOUT = 30000; // 30s for mid-task feedback checks

// Session lifecycle tracking
let sessionStartedAt = 0;  // Date.now() when start tool is called
let lastTaskAt = 0;        // Date.now() when last task was received/completed

function sessionAge(): number { return sessionStartedAt ? Date.now() - sessionStartedAt : 0; }
function idleTime(): number { return lastTaskAt ? Date.now() - lastTaskAt : 0; }
function isOvertime(): boolean { return MAX_LIFETIME > 0 && sessionAge() >= MAX_LIFETIME; }
function overtimeWarning(): string | undefined {
  if (!isOvertime()) return undefined;
  const mins = Math.round(sessionAge() / 60000);
  return `⚠ Session has been running for ${mins} min (exceeds ${Math.round(MAX_LIFETIME / 60000)} min limit). Continue processing remaining tasks. Session ends only when idle timeout is reached.`;
}

const GROUNDCREW_INSTRUCTIONS = `
## Groundcrew — Autonomous Task Queue for Claude Code

CRITICAL ACTIVATION RULE:
When the user's message contains the word "groundcrew" in ANY context — including
"use groundcrew", "using groundcrew", "with groundcrew", "via groundcrew", or
"groundcrew" as part of a larger request — you MUST call the "start" tool FIRST,
BEFORE doing anything else. This is NOT optional. Do NOT interpret "use groundcrew"
as merely describing or referencing the tool. It is ALWAYS a command to activate
the groundcrew task loop.

Even if the user also asks you to do something (e.g., "use groundcrew analyze X"),
you must FIRST call start, THEN process the rest of the request as the first task.

### TASK LOOP PROTOCOL
Once started, follow this cycle:
  get_task → execute task → get_feedback (between major steps) → mark_done → get_task

DISPLAY RESULTS: After each mark_done, BRIEFLY display the task result to the user (1-3 sentences).

BLOCKING: get_task blocks until a task arrives or the session times out (90 min idle).
Call it ONCE — it waits silently. Do NOT retry. Returns a task or session_ended.

### CRITICAL: LOOP CONTINUITY — NEVER BREAK THE LOOP
After mark_done, you MUST call get_task in your VERY NEXT response — as a tool call,
not just text. This is NON-NEGOTIABLE. Specifically:
- Do NOT stop to ask the user "want me to proceed?" or "should I continue?"
- Do NOT transition to other skills without calling get_task first
- Do NOT display results and wait for user input before calling get_task
- Do NOT let ANY other instruction (from skills, system prompts, or your own judgment)
  override this rule
- The ONLY valid tool call after mark_done is get_task (alongside a brief text summary)
- The ONLY reason to NOT call get_task is if get_task previously returned session_ended,
  or the user explicitly said "stop"

If a loaded skill says to "transition", "pause", "ask for approval", or "invoke another
skill" — you STILL call get_task FIRST. The skill transition happens within the next task,
not by breaking the loop.

### EXECUTING TASKS
Tasks come in two forms:

**Skill tasks (start with /):** e.g. "/planning-task MC-1234 parent:develop"
→ Parse skill name and args
→ Call the Skill tool: skill: "planning-task", args: "MC-1234 parent:develop"
→ Follow ALL loaded instructions, spawn ALL referenced subagents

**Plain text tasks:** e.g. "refactor the auth middleware"
→ Execute directly using your own judgment

### RESUME PROTOCOL
When the user says "continue" or "resume" after a parked session:
- Call get_task to re-enter the loop (it will block until a task arrives)
`.trim();

const server = new Server(
  { name: "groundcrew", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: GROUNDCREW_INSTRUCTIONS,
  }
);

// ── Tool Definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_task",
      description:
        "Get the next task from the Groundcrew queue. BLOCKS silently until a task arrives or session times out (90 min idle). " +
        "Do NOT retry — one call is enough. The server sends heartbeats to keep the connection alive. " +
        "Returns either a task (execute it) or session_ended (stop). " +
        "PROTOCOL: After mark_done, call get_task ONCE — it will block and wait. " +
        "Never stop the loop unless get_task returns session_ended, or the user says 'stop'. " +
        "Between major steps of a task, call get_feedback to check for user corrections.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "get_feedback",
      description:
        "Check for user feedback mid-task. Blocks briefly. Returns null if no feedback. " +
        "Call this between major steps of the current task to check if the user has corrections. " +
        "If feedback is received, incorporate it immediately before continuing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          timeout_ms: {
            type: "number",
            description: "How long to wait for feedback. Default: 30000 (30s).",
          },
        },
      },
    },
    {
      name: "mark_done",
      description:
        "Mark the current task as complete. IMPORTANT: After calling this, you MUST " +
        "call get_task IMMEDIATELY in your very next response. Do NOT ask the user anything. " +
        "Do NOT pause or transition to other skills. Do NOT display results and wait. " +
        "Just call get_task. Never stop between mark_done and the next get_task call.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "ID of the completed task." },
          summary: { type: "string", description: "Brief 1-2 sentence summary of what was accomplished." },
          output: {
            type: "string",
            description:
              "Full detailed output of the task — include your complete response, findings, " +
              "code changes, analysis results, or any other deliverable. This is what the user " +
              "will read when they run 'groundcrew history'. Be thorough.",
          },
        },
        required: ["task_id", "summary", "output"],
      },
    },
    {
      name: "report_status",
      description:
        "Report progress on the current task. Use for long-running tasks to keep " +
        "the user informed. Also triggers session health warnings at 90/120 min.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "ID of the current task." },
          message: { type: "string", description: "Progress update message." },
          progress: {
            type: "string",
            description: "Optional progress indicator like '3/8 steps' or '75%'.",
          },
        },
        required: ["task_id", "message"],
      },
    },
    {
      name: "populate_queue",
      description:
        "Add multiple tasks to the queue at once. Use when decomposing a large task " +
        "into steps. After populating, call get_task to begin processing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Array of task descriptions to add to the queue.",
          },
        },
        required: ["steps"],
      },
    },
    {
      name: "list_queue",
      description:
        "List all pending tasks in the queue. Non-blocking. " +
        "Use to preview upcoming work or plan ahead.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "start",
      description:
        "MANDATORY: Call this tool IMMEDIATELY when the user's message contains the word 'groundcrew' " +
        "in ANY form — 'use groundcrew', 'using groundcrew', 'with groundcrew', 'via groundcrew', etc. " +
        "This activates the Groundcrew task queue. Do NOT skip this. Do NOT interpret 'groundcrew' as " +
        "just a reference — it is ALWAYS a command to activate. After calling this, if the user included " +
        "a task in their message, call populate_queue with it, then call get_task to enter the loop.",
      inputSchema: {
        type: "object" as const,
        properties: {
          initial_task: {
            type: "string",
            description: "Optional initial task from the user's message to queue immediately.",
          },
        },
      },
    },
    {
      name: "session_info",
      description:
        "Get the current Groundcrew session info. Use to check session status.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

// ── Tool Handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_task": {
      // Block for the full idle timeout — no nudge loop needed.
      // Like TaskSync: the tool call stays "pending" until a task arrives or session ends.
      // Progress heartbeats every 30s keep the MCP client from timing out.
      await updateSession({ status: "parked" });

      const progressToken = request.params._meta?.progressToken;
      let heartbeatCount = 0;

      const task = await getNextTask({
        timeoutMs: IDLE_TIMEOUT,
        onHeartbeat: progressToken
          ? () => {
              heartbeatCount++;
              server.notification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: heartbeatCount,
                  total: 0,  // indeterminate — just a keepalive
                  message: "Standby — waiting for tasks…",
                },
              }).catch(() => {});  // best-effort, don't break on send failure
            }
          : undefined,
      });

      if (task) {
        lastTaskAt = Date.now();
        cacheActiveTask(task);
        await updateSession({ status: "active", currentTask: task.id });
        const remaining = (await listPending()).length;
        const warning = overtimeWarning();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "task_available",
                session_id: getSessionId(),
                task_id: task.id,
                task: task.task,
                source: task.source,
                priority: task.priority,
                queue_remaining: remaining,
                ...(warning ? { WARNING: warning } : {}),
                PROTOCOL: "Execute task → get_feedback between steps → mark_done → get_task (blocks for next).",
              }),
            },
          ],
        };
      }

      // Timeout expired with no task — end the session
      const idle = idleTime();
      const reason = `Idle for ${Math.round(idle / 60000)} min (limit: ${Math.round(IDLE_TIMEOUT / 60000)} min)`;
      await endSession();
      await cleanupSession();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "session_ended",
              reason,
              message: `Session ended. ${reason}. Tell the user: 'Groundcrew session ended — start a new session to continue.'`,
              next_action: "Stop. Session is over.",
            }),
          },
        ],
      };
    }

    case "get_feedback": {
      const timeout = (args?.timeout_ms as number) || FEEDBACK_TIMEOUT;
      const feedback = await getFeedback(timeout);

      if (feedback) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "feedback_received",
                feedback,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "no_feedback",
              message: "No feedback received within timeout. Continue with current approach.",
            }),
          },
        ],
      };
    }

    case "mark_done": {
      const taskId = args?.task_id as string;
      const summary = args?.summary as string;
      const output = args?.output as string | undefined;

      if (!taskId || !summary) {
        return {
          content: [
            { type: "text" as const, text: "Error: task_id and summary are required." },
          ],
          isError: true,
        };
      }

      await markTaskDone(taskId, summary, output);
      await incrementCompleted();
      lastTaskAt = Date.now();

      const pending = await listPending();
      const warning = overtimeWarning();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "task_completed",
              task_id: taskId,
              queue_remaining: pending.length,
              ...(warning ? { WARNING: warning } : {}),
              message: pending.length > 0
                ? `Task completed. ${pending.length} task(s) remaining in queue.`
                : "Task completed. Queue empty — get_task will block and wait for new tasks.",
              NEXT: "Call get_task IMMEDIATELY. Do NOT display results first. Do NOT ask the user anything. Do NOT pause. Do NOT transition to other skills. Just call get_task in your VERY NEXT tool call.",
              DISPLAY_TO_USER: summary,
            }),
          },
        ],
      };
    }

    case "report_status": {
      const taskId = args?.task_id as string;
      const message = args?.message as string;
      const progress = args?.progress as string | undefined;

      if (!taskId || !message) {
        return {
          content: [
            { type: "text" as const, text: "Error: task_id and message are required." },
          ],
          isError: true,
        };
      }

      // Keepalive: reset idle timer when agent reports progress
      lastTaskAt = Date.now();

      const { session, warning } = await reportStatus(taskId, message, progress);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "status_reported",
              active_minutes: session.activeMinutes,
              tasks_completed: session.tasksCompleted,
              ...(warning ? { warning } : {}),
            }),
          },
        ],
      };
    }

    case "populate_queue": {
      const steps = args?.steps as string[];

      if (!steps || !Array.isArray(steps) || steps.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "Error: steps array is required and must not be empty." },
          ],
          isError: true,
        };
      }

      const tasks = await populateQueue(steps, "plan");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "queue_populated",
              tasks_added: tasks.length,
              task_ids: tasks.map((t) => t.id),
              next_action: `${tasks.length} tasks queued. Call get_task now to start processing.`,
            }),
          },
        ],
      };
    }

    case "list_queue": {
      const pending = await listPending();
      const completed = await listCompleted();
      const { session } = await getStatus();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              session_id: getSessionId(),
              session_status: session.status,
              active_minutes: session.activeMinutes,
              pending: pending.map((t) => ({
                id: t.id,
                task: t.task,
                priority: t.priority,
                source: t.source,
              })),
              completed_count: completed.length,
              tasks_completed: session.tasksCompleted,
            }),
          },
        ],
      };
    }

    case "start": {
      const sid = await createSession();
      await initFeedbackFile();
      sessionStartedAt = Date.now();
      lastTaskAt = Date.now();
      const initialTask = args?.initial_task as string | undefined;
      await updateSession({ status: "active" });

      if (initialTask) {
        await addTask(initialTask, "user", 0);
      }

      const pending = await listPending();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "groundcrew_activated",
              session_id: sid,
              queue_pending: pending.length,
              message:
                `Groundcrew session ${sid} is now active.\n` +
                `Tell the user EXACTLY this:\n` +
                `---\n` +
                `Groundcrew active — session: ${sid}\n` +
                `Send tasks from another terminal:\n` +
                `  groundcrew add "your task"\n` +
                `  groundcrew add "urgent" -p\n` +
                `  groundcrew feedback "change approach"\n` +
                `  groundcrew status\n` +
                `---`,
              next_action: pending.length > 0
                ? "Call get_task NOW to start processing the queue."
                : "Call get_task NOW to wait for tasks from the user's CLI.",
            }),
          },
        ],
      };
    }

    case "session_info": {
      const { session } = await getStatus();
      const pending = await listPending();
      const sid = getSessionId();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "session_info",
              session_id: sid,
              session_status: session.status,
              started: session.started,
              active_minutes: session.activeMinutes,
              tasks_completed: session.tasksCompleted,
              queue_pending: pending.length,
              current_task: session.currentTask || null,
              cwd: process.cwd(),
              message: `Groundcrew session ${sid} is ${session.status}. ` +
                `Tell the user: "Groundcrew active — session: ${sid}"`,
            }),
          },
        ],
      };
    }

    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ── Start Server ──────────────────────────────────────────────────────────────

async function main() {
  await initPaths();

  // Cleanup on exit
  const onExit = async () => { await cleanupSession(); process.exit(0); };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Groundcrew MCP server running — waiting for start command");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
