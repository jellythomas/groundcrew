import fs from "fs/promises";
import { watch } from "fs";
import { getSessionDir, getQueueFile, getHistoryFile } from "./paths.js";
function emptyQueue() {
    return { tasks: [], completed: [] };
}
export async function readQueue() {
    try {
        const raw = await fs.readFile(getQueueFile(), "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return emptyQueue();
    }
}
async function writeQueue(data) {
    await fs.mkdir(getSessionDir(), { recursive: true });
    await fs.writeFile(getQueueFile(), JSON.stringify(data, null, 2));
}
export async function addTask(taskText, source = "user", priority = 0) {
    const queue = await readQueue();
    const task = {
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
export async function populateQueue(steps, source = "plan", chain = true) {
    const queue = await readQueue();
    const tasks = steps.map((step, i) => ({
        id: `task-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        task: step,
        source,
        priority: 0,
        createdAt: new Date().toISOString(),
    }));
    // Auto-chain: each task depends on the previous one
    if (chain && tasks.length > 1) {
        for (let i = 1; i < tasks.length; i++) {
            tasks[i].depends_on = tasks[i - 1].id;
        }
    }
    queue.tasks.push(...tasks);
    queue.tasks.sort((a, b) => b.priority - a.priority);
    await writeQueue(queue);
    return tasks;
}
/**
 * Find the first task whose dependencies are satisfied.
 * A task is ready if it has no depends_on, or its dependency is in completed[].
 */
function findReadyTask(queue) {
    const completedIds = new Set(queue.completed.map((c) => c.id));
    const idx = queue.tasks.findIndex((t) => !t.depends_on || completedIds.has(t.depends_on));
    if (idx === -1)
        return null;
    return queue.tasks.splice(idx, 1)[0];
}
export async function getNextTask(opts) {
    const { timeoutMs, onHeartbeat, heartbeatIntervalMs = 30_000 } = opts;
    const queueFile = getQueueFile();
    // Check queue immediately
    const queue = await readQueue();
    const ready = findReadyTask(queue);
    if (ready) {
        await writeQueue(queue);
        return ready;
    }
    // If tasks exist but none are ready (all blocked by dependencies), still wait
    // — a completing task will unblock them
    // Instant return mode — no blocking, no slicing risk
    if (timeoutMs <= 0)
        return null;
    // Ensure the queue file exists for watching
    await fs.writeFile(queueFile, JSON.stringify(emptyQueue()), { flag: "wx" }).catch(() => { });
    // Block — watch for file changes, send heartbeats to keep MCP alive
    return new Promise((resolve) => {
        let watcher;
        let timer;
        let poll;
        let heartbeat;
        const cleanup = () => {
            watcher?.close();
            if (timer)
                clearTimeout(timer);
            if (poll)
                clearInterval(poll);
            if (heartbeat)
                clearInterval(heartbeat);
        };
        const checkQueue = async () => {
            try {
                const q = await readQueue();
                const task = findReadyTask(q);
                if (task) {
                    await writeQueue(q);
                    cleanup();
                    resolve(task);
                }
            }
            catch {
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
export async function markTaskDone(taskId, summary, output) {
    const queue = await readQueue();
    // Find original task info from completed or check if it was already moved
    // The task was shifted from tasks[] in getNextTask, so check completed for prior entries
    // or use the taskId to reconstruct. We store original task text via setActiveTask.
    const completed = {
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
async function appendHistory(entry) {
    const histFile = getHistoryFile();
    let history = [];
    try {
        history = JSON.parse(await fs.readFile(histFile, "utf-8"));
    }
    catch { /* first entry */ }
    history.push(entry);
    await fs.writeFile(histFile, JSON.stringify(history, null, 2));
}
// Cache active tasks so we can preserve original prompt on completion
const activeTaskCache = new Map();
export function cacheActiveTask(task) {
    activeTaskCache.set(task.id, { task: task.task, source: task.source });
}
export async function listPending() {
    const queue = await readQueue();
    return queue.tasks;
}
export async function listCompleted() {
    const queue = await readQueue();
    return queue.completed;
}
