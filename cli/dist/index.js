#!/usr/bin/env node
import{createRequire}from'module';const require=createRequire(import.meta.url);
// src/index.ts
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
var GROUNDCREW_DIR = ".groundcrew";
var QUEUE_FILE = path.join(GROUNDCREW_DIR, "queue.json");
var FEEDBACK_FILE = path.join(GROUNDCREW_DIR, "feedback.md");
var SESSION_FILE = path.join(GROUNDCREW_DIR, "session.json");
var STATUS_FILE = path.join(GROUNDCREW_DIR, "status.json");
async function ensureDir() {
  if (!existsSync(GROUNDCREW_DIR)) {
    await fs.mkdir(GROUNDCREW_DIR, { recursive: true });
  }
}
async function readQueue() {
  try {
    return JSON.parse(await fs.readFile(QUEUE_FILE, "utf-8"));
  } catch {
    return { tasks: [], completed: [] };
  }
}
async function writeQueue(data) {
  await ensureDir();
  await fs.writeFile(QUEUE_FILE, JSON.stringify(data, null, 2));
}
function color(code, text) {
  return `\x1B[${code}m${text}\x1B[0m`;
}
var green = (t) => color(32, t);
var yellow = (t) => color(33, t);
var cyan = (t) => color(36, t);
var dim = (t) => color(2, t);
var bold = (t) => color(1, t);
var red = (t) => color(31, t);
async function init() {
  await ensureDir();
  if (!existsSync(QUEUE_FILE)) {
    await writeQueue({ tasks: [], completed: [] });
  }
  if (!existsSync(FEEDBACK_FILE)) {
    await fs.writeFile(
      FEEDBACK_FILE,
      "<!-- Write your feedback below. Save to send to agent. -->\n\n"
    );
  }
  console.log(green("Groundcrew initialized.") + ` ${dim(GROUNDCREW_DIR + "/ created")}`);
}
async function add(taskText, priority) {
  const queue = await readQueue();
  const task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task: taskText,
    source: "user",
    priority,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  queue.tasks.push(task);
  queue.tasks.sort((a, b) => b.priority - a.priority);
  await writeQueue(queue);
  const label = priority > 0 ? red("[PRIORITY] ") : "";
  console.log(`${green("+")} ${label}${taskText} ${dim(`(${task.id})`)}`);
  console.log(dim(`  Queue: ${queue.tasks.length} pending`));
}
async function feedback(message) {
  await ensureDir();
  await fs.writeFile(FEEDBACK_FILE, message + "\n");
  console.log(`${green("Feedback sent.")} Agent will receive it on next check.`);
}
async function listQueue() {
  const queue = await readQueue();
  if (queue.tasks.length === 0) {
    console.log(dim("Queue is empty."));
    return;
  }
  console.log(bold(`Pending tasks (${queue.tasks.length}):
`));
  for (const [i, task] of queue.tasks.entries()) {
    const pri = task.priority > 0 ? red(` [P${task.priority}]`) : "";
    console.log(`  ${cyan(`${i + 1}.`)}${pri} ${task.task}`);
    console.log(dim(`     ${task.source} | ${task.id}`));
  }
  if (queue.completed.length > 0) {
    console.log(dim(`
  ${queue.completed.length} task(s) completed this session.`));
  }
}
async function status() {
  try {
    const session = JSON.parse(await fs.readFile(SESSION_FILE, "utf-8"));
    const startTime = new Date(session.started).getTime();
    const minutes = Math.round((Date.now() - startTime) / 6e4);
    console.log(bold("Session:"));
    console.log(`  Status:    ${session.status === "active" ? green("active") : yellow(session.status)}`);
    console.log(`  Duration:  ${minutes}min`);
    console.log(`  Completed: ${session.tasksCompleted || 0} tasks`);
    if (session.currentTask) {
      console.log(`  Current:   ${session.currentTask}`);
    }
  } catch {
    console.log(dim("No active session. Start Copilot with groundcrew agent."));
    return;
  }
  const queue = await readQueue();
  console.log(`
${bold("Queue:")} ${queue.tasks.length} pending`);
  try {
    const reports = JSON.parse(await fs.readFile(STATUS_FILE, "utf-8"));
    if (reports.length > 0) {
      const last = reports[reports.length - 1];
      console.log(`
${bold("Last update:")} ${last.message}`);
      if (last.progress) console.log(`  Progress: ${last.progress}`);
      console.log(dim(`  ${last.timestamp}`));
    }
  } catch {
  }
}
async function clear() {
  await writeQueue({ tasks: [], completed: [] });
  console.log(green("Queue cleared."));
}
async function history() {
  const queue = await readQueue();
  if (queue.completed.length === 0) {
    console.log(dim("No completed tasks yet."));
    return;
  }
  console.log(bold(`Completed tasks (${queue.completed.length}):
`));
  for (const task of queue.completed) {
    console.log(`  ${green("done")} ${task.summary || task.task}`);
    console.log(dim(`       ${task.completedAt} | ${task.id}`));
  }
}
function usage() {
  console.log(`
${bold("groundcrew")} \u2014 CLI companion for the Groundcrew Copilot plugin

${bold("Usage:")}
  groundcrew init                        Initialize .groundcrew/ in current dir
  groundcrew add <task>                  Add a task to the queue
  groundcrew add --priority <task>       Add an urgent task (processed first)
  groundcrew feedback <message>          Send feedback to the agent mid-task
  groundcrew queue                       List pending tasks
  groundcrew status                      Show session status and last update
  groundcrew history                     Show completed tasks
  groundcrew clear                       Clear all pending tasks

${bold("How it works:")}
  1. Start Copilot CLI with groundcrew plugin installed
  2. Give it an initial task or say "start groundcrew"
  3. Open another terminal and use this CLI to queue tasks and send feedback
  4. The agent processes tasks from the queue autonomously

${bold("Install:")}
  copilot plugin install jellythomas/groundcrew   ${dim("# the Copilot plugin")}
  npm install -g groundcrew-cli                   ${dim("# this CLI companion")}
`);
}
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  switch (command) {
    case "init":
      await init();
      break;
    case "add": {
      const hasPriority = args.includes("--priority") || args.includes("-p");
      const taskParts = args.slice(1).filter((a) => a !== "--priority" && a !== "-p");
      const taskText = taskParts.join(" ");
      if (!taskText) {
        console.error(red("Error: task text required."));
        console.error(dim('  groundcrew add "build the dashboard"'));
        process.exit(1);
      }
      await add(taskText, hasPriority ? 9 : 0);
      break;
    }
    case "feedback": {
      const msg = args.slice(1).join(" ");
      if (!msg) {
        console.error(red("Error: feedback message required."));
        console.error(dim('  groundcrew feedback "use bcrypt not argon2"'));
        process.exit(1);
      }
      await feedback(msg);
      break;
    }
    case "queue":
    case "list":
      await listQueue();
      break;
    case "status":
      await status();
      break;
    case "history":
      await history();
      break;
    case "clear":
      await clear();
      break;
    case "help":
    case "--help":
    case "-h":
    case void 0:
      usage();
      break;
    default:
      console.error(red(`Unknown command: ${command}`));
      usage();
      process.exit(1);
  }
}
main().catch((err) => {
  console.error(red("Error:"), err.message);
  process.exit(1);
});
