import fs from "fs/promises";
import { existsSync, watch, type FSWatcher } from "fs";
import { getSessionDir, getQueueFile } from "./paths.js";

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

export async function getNextTask(timeoutMs: number): Promise<Task | null> {
  const queueFile = getQueueFile();

  // Check queue immediately
  const queue = await readQueue();
  if (queue.tasks.length > 0) {
    const task = queue.tasks.shift()!;
    await writeQueue(queue);
    return task;
  }

  // Ensure the queue file exists for watching
  await fs.writeFile(queueFile, JSON.stringify(emptyQueue()), { flag: "wx" }).catch(() => {});

  // Block — watch for file changes
  return new Promise<Task | null>((resolve) => {
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      watcher?.close();
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
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

    // Also poll every 2s as fallback (some fs watchers miss events)
    poll = setInterval(() => { checkQueue(); }, 2000);

    timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

export async function markTaskDone(
  taskId: string,
  summary: string
): Promise<void> {
  const queue = await readQueue();
  const completed: CompletedTask = {
    id: taskId,
    task: "",
    source: "",
    completedAt: new Date().toISOString(),
    summary,
  };
  queue.completed.push(completed);
  await writeQueue(queue);
}

export async function listPending(): Promise<Task[]> {
  const queue = await readQueue();
  return queue.tasks;
}

export async function listCompleted(): Promise<CompletedTask[]> {
  const queue = await readQueue();
  return queue.completed;
}
