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
  ensureGroundcrewDir,
} from "./queue.js";
import { getFeedback, initFeedbackFile } from "./feedback.js";
import {
  reportStatus,
  incrementCompleted,
  parkSession,
  getStatus,
  updateSession,
} from "./session.js";

// Config from environment
const TASK_TIMEOUT = parseInt(process.env.GROUNDCREW_TASK_TIMEOUT || "300000");
const MAX_IDLE_RETRIES = parseInt(process.env.GROUNDCREW_MAX_IDLE_RETRIES || "3");
const FEEDBACK_TIMEOUT = 30000; // 30s for mid-task feedback checks

const server = new Server(
  { name: "groundcrew", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ── Tool Definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_task",
      description:
        "Get the next task from the queue. Blocks until a task is available or timeout. " +
        "Call this after completing each task to get the next one. " +
        "Returns null when queue is empty after all retries (agent should park).",
      inputSchema: {
        type: "object" as const,
        properties: {
          timeout_ms: {
            type: "number",
            description: "How long to wait for a task in milliseconds. Default: 300000 (5 min).",
          },
        },
      },
    },
    {
      name: "get_feedback",
      description:
        "Check for user feedback mid-task. Blocks briefly waiting for the user to write " +
        "to .groundcrew/feedback.md. Returns null if no feedback within timeout. " +
        "Call this between major steps of a task.",
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
        "Mark the current task as complete with a summary of what was done. " +
        "Always call this after finishing a task, before calling get_task for the next one.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "ID of the completed task." },
          summary: { type: "string", description: "Brief summary of what was accomplished." },
        },
        required: ["task_id", "summary"],
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
        "Add multiple tasks to the queue at once. Use after decomposing a plan " +
        "into steps. Tasks are added in order with normal priority.",
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
  ],
}));

// ── Tool Handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_task": {
      const timeout = (args?.timeout_ms as number) || TASK_TIMEOUT;
      let retries = 0;

      while (retries < MAX_IDLE_RETRIES) {
        const task = await getNextTask(timeout);
        if (task) {
          await updateSession({ status: "active", currentTask: task.id });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "task_available",
                  task_id: task.id,
                  task: task.task,
                  source: task.source,
                  priority: task.priority,
                  queue_remaining: (await listPending()).length,
                }),
              },
            ],
          };
        }
        retries++;
        if (retries < MAX_IDLE_RETRIES) {
          // Backoff: 30s, 2min, 5min
          const backoff = [30000, 120000, 300000][retries - 1] || 300000;
          await new Promise((r) => setTimeout(r, Math.min(backoff, 5000)));
          // Re-check immediately after short backoff, the real wait was in getNextTask
        }
      }

      // All retries exhausted — park
      await parkSession();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "queue_empty",
              message:
                "No tasks available after all retries. Session parked. " +
                "User can add tasks with `groundcrew add` then type `continue` to resume.",
              retries_exhausted: MAX_IDLE_RETRIES,
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

      if (!taskId || !summary) {
        return {
          content: [
            { type: "text" as const, text: "Error: task_id and summary are required." },
          ],
          isError: true,
        };
      }

      await markTaskDone(taskId, summary);
      await incrementCompleted();

      const pending = await listPending();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "task_completed",
              task_id: taskId,
              queue_remaining: pending.length,
              message: pending.length > 0
                ? `Done. ${pending.length} task(s) remaining. Call get_task for the next one.`
                : "Done. Queue empty. Call get_task to wait for new tasks.",
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
              message: `Added ${tasks.length} tasks to queue. Call get_task to begin.`,
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

    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ── Start Server ──────────────────────────────────────────────────────────────

async function main() {
  await ensureGroundcrewDir();
  await initFeedbackFile();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Groundcrew MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
