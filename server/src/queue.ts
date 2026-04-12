import fs from "fs/promises";
import { existsSync, watch, type FSWatcher } from "fs";
import path from "path";

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

const GROUNDCREW_DIR = ".groundcrew";
const QUEUE_FILE = path.join(GROUNDCREW_DIR, "queue.json");

function emptyQueue(): QueueData {
  return { tasks: [], completed: [] };
}

export async function ensureGroundcrewDir(): Promise<void> {
  if (!existsSync(GROUNDCREW_DIR)) {
    await fs.mkdir(GROUNDCREW_DIR, { recursive: true });
  }
}

export async function readQueue(): Promise<QueueData> {
  try {
    const raw = await fs.readFile(QUEUE_FILE, "utf-8");
    return JSON.parse(raw) as QueueData;
  } catch {
    return emptyQueue();
  }
}

async function writeQueue(data: QueueData): Promise<void> {
  await ensureGroundcrewDir();
  await fs.writeFile(QUEUE_FILE, JSON.stringify(data, null, 2));
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
  // Sort by priority descending (9 = urgent, 0 = normal)
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
  // Check queue immediately
  const queue = await readQueue();
  if (queue.tasks.length > 0) {
    const task = queue.tasks.shift()!;
    await writeQueue(queue);
    return task;
  }

  // Block — watch for file changes
  return new Promise<Task | null>((resolve) => {
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      watcher?.close();
      if (timer) clearTimeout(timer);
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

    // Ensure the queue file exists for watching
    ensureGroundcrewDir()
      .then(() =>
        fs.writeFile(QUEUE_FILE, JSON.stringify(emptyQueue()), { flag: "wx" }).catch(() => {})
      )
      .then(() => {
        watcher = watch(QUEUE_FILE, { persistent: true }, () => {
          checkQueue();
        });

        // Also poll every 2s as fallback (some fs watchers miss events)
        const poll = setInterval(() => {
          checkQueue().then((/* void */) => {
            // If resolved, stop polling
          });
        }, 2000);

        timer = setTimeout(() => {
          cleanup();
          clearInterval(poll);
          resolve(null);
        }, timeoutMs);

        // Store poll interval for cleanup
        const origCleanup = cleanup;
        (cleanup as any).__poll = poll;
        watcher.on("close", () => clearInterval(poll));
      });
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
