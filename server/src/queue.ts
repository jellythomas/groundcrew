import fs from "fs/promises";
import { existsSync, watch, type FSWatcher } from "fs";
import { getSessionDir, getQueueFile, getHistoryFile } from "./paths.js";

export interface Task {
  id: string;
  task: string;
  source: "user" | "plan" | "feedback" | "import";
  priority: number;
  createdAt: string;
}

export interface QueueData {
  tasks: Task[];
  completed: CompletedTask[];
}

export interface CompletedTask {
  id: string;
  task: string;
  source: string;
  completedAt: string;
  summary: string;
  output?: string;
}

function emptyQueue(): QueueData {
  return { tasks: [], completed: [] };
}

export async function readQueue(): Promise<QueueData> {
  try {
    const raw = await fs.readFile(getQueueFile(), "utf-8");
    return JSON.parse(raw) as QueueData;
  } catch {
    return emptyQueue();
  }
}

async function writeQueue(data: QueueData): Promise<void> {
  await fs.mkdir(getSessionDir(), { recursive: true });
  await fs.writeFile(getQueueFile(), JSON.stringify(data, null, 2));
}

export async function addTask(
  taskText: string,
  source: Task["source"] = "user",
  priority = 0
): Promise<Task> {
  const queue = await readQueue();
  const task: Task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task: taskText,
    source,
    priority,
    createdAt: new Date().toISOString(),
  };
  queue.tasks.push(task);
  queue.tasks.sort((a, b) => b.priority - a.priority);
  await writeQueue(queue);
  return task;
}

export async function populateQueue(
  steps: string[],
  source: Task["source"] = "plan"
): Promise<Task[]> {
  const queue = await readQueue();
  const tasks: Task[] = steps.map((step, i) => ({
    id: `task-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    task: step,
    source,
    priority: 0,
    createdAt: new Date().toISOString(),
  }));
  queue.tasks.push(...tasks);
  queue.tasks.sort((a, b) => b.priority - a.priority);
  await writeQueue(queue);
  return tasks;
}

export interface BlockingOptions {
  timeoutMs: number;
  /** Called periodically while blocking so callers can send heartbeats / progress */
  onHeartbeat?: () => void;
  /** Interval between heartbeat calls (default: 30 000 ms) */
  heartbeatIntervalMs?: number;
}

export async function getNextTask(opts: BlockingOptions): Promise<Task | null> {
  const { timeoutMs, onHeartbeat, heartbeatIntervalMs = 30_000 } = opts;
  const queueFile = getQueueFile();

  // Check queue immediately
  const queue = await readQueue();
  if (queue.tasks.length > 0) {
    const task = queue.tasks.shift()!;
    await writeQueue(queue);
    return task;
  }

  // Instant return mode — no blocking, no slicing risk
  if (timeoutMs <= 0) return null;

  // Ensure the queue file exists for watching
  await fs.writeFile(queueFile, JSON.stringify(emptyQueue()), { flag: "wx" }).catch(() => {});

  // Block — watch for file changes, send heartbeats to keep MCP alive
  return new Promise<Task | null>((resolve) => {
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      watcher?.close();
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (heartbeat) clearInterval(heartbeat);
    };

    const checkQueue = async () => {
      try {
        const q = await readQueue();
        if (q.tasks.length > 0) {
          const task = q.tasks.shift()!;
          await writeQueue(q);
          cleanup();
          resolve(task);
        }
      } catch {
        // File might be mid-write, ignore and wait for next event
      }
    };

    watcher = watch(queueFile, { persistent: true }, () => {
      checkQueue();
    });

    // Also poll every 1s as fallback (some fs watchers miss events)
    poll = setInterval(() => { checkQueue(); }, 1000);

    // Heartbeat keeps MCP client from timing out the pending request
    if (onHeartbeat) {
      heartbeat = setInterval(() => { onHeartbeat(); }, heartbeatIntervalMs);
    }

    timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

export async function markTaskDone(
  taskId: string,
  summary: string,
  output?: string
): Promise<void> {
  const queue = await readQueue();

  // Find original task info from completed or check if it was already moved
  // The task was shifted from tasks[] in getNextTask, so check completed for prior entries
  // or use the taskId to reconstruct. We store original task text via setActiveTask.
  const completed: CompletedTask = {
    id: taskId,
    task: activeTaskCache.get(taskId)?.task || "",
    source: activeTaskCache.get(taskId)?.source || "user",
    completedAt: new Date().toISOString(),
    summary,
    ...(output ? { output } : {}),
  };
  activeTaskCache.delete(taskId);
  queue.completed.push(completed);
  await writeQueue(queue);

  // Also append to project-level history (persists across sessions)
  await appendHistory(completed);
}

async function appendHistory(entry: CompletedTask): Promise<void> {
  const histFile = getHistoryFile();
  let history: CompletedTask[] = [];
  try {
    history = JSON.parse(await fs.readFile(histFile, "utf-8"));
  } catch { /* first entry */ }
  history.push(entry);
  await fs.writeFile(histFile, JSON.stringify(history, null, 2));
}

// Cache active tasks so we can preserve original prompt on completion
const activeTaskCache = new Map<string, { task: string; source: string }>();

export function cacheActiveTask(task: Task): void {
  activeTaskCache.set(task.id, { task: task.task, source: task.source });
}

export async function listPending(): Promise<Task[]> {
  const queue = await readQueue();
  return queue.tasks;
}

export async function listCompleted(): Promise<CompletedTask[]> {
  const queue = await readQueue();
  return queue.completed;
}
