#!/usr/bin/env node
import{createRequire}from'module';const require=createRequire(import.meta.url);
// src/index.ts
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import readline from "readline";
var GROUNDCREW_DIR = ".groundcrew";
var SESSIONS_DIR = path.join(GROUNDCREW_DIR, "sessions");
var ACTIVE_SESSIONS_FILE = path.join(GROUNDCREW_DIR, "active-sessions.json");
var HISTORY_FILE = path.join(GROUNDCREW_DIR, "history.json");
async function readActiveSessions() {
  try {
    return JSON.parse(await fs.readFile(ACTIVE_SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}
async function resolveSessionDir(explicitSession) {
  if (explicitSession) {
    const dir = path.join(SESSIONS_DIR, explicitSession);
    if (!existsSync(dir)) {
      throw new Error(`Session "${explicitSession}" not found.`);
    }
    return dir;
  }
  const sessions2 = await readActiveSessions();
  const ids = Object.keys(sessions2);
  if (ids.length === 0) {
    try {
      const dirs = await fs.readdir(SESSIONS_DIR);
      if (dirs.length === 1) return path.join(SESSIONS_DIR, dirs[0]);
      if (dirs.length > 1) {
        let latest2 = { dir: dirs[0], mtime: 0 };
        for (const d of dirs) {
          try {
            const stat = await fs.stat(path.join(SESSIONS_DIR, d, "session.json"));
            if (stat.mtimeMs > latest2.mtime) {
              latest2 = { dir: d, mtime: stat.mtimeMs };
            }
          } catch {
          }
        }
        return path.join(SESSIONS_DIR, latest2.dir);
      }
    } catch {
    }
    throw new Error("No active sessions. Start Copilot with groundcrew first.");
  }
  if (ids.length === 1) {
    return path.join(SESSIONS_DIR, ids[0]);
  }
  let latest = { id: ids[0], time: 0 };
  for (const id of ids) {
    const started = new Date(sessions2[id].started).getTime();
    if (started > latest.time) {
      latest = { id, time: started };
    }
  }
  return path.join(SESSIONS_DIR, latest.id);
}
function sessionQueueFile(sessionDir) {
  return path.join(sessionDir, "queue.json");
}
function sessionFeedbackFile(sessionDir) {
  return path.join(sessionDir, "feedback.md");
}
function sessionSessionFile(sessionDir) {
  return path.join(sessionDir, "session.json");
}
function sessionStatusFile(sessionDir) {
  return path.join(sessionDir, "status.json");
}
async function readQueue(sessionDir) {
  try {
    return JSON.parse(await fs.readFile(sessionQueueFile(sessionDir), "utf-8"));
  } catch {
    return { tasks: [], completed: [] };
  }
}
async function writeQueue(sessionDir, data) {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionQueueFile(sessionDir), JSON.stringify(data, null, 2));
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
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  console.log(green("Groundcrew initialized.") + ` ${dim(GROUNDCREW_DIR + "/ created")}`);
}
async function add(taskText, priority, sessionDir) {
  const queue = await readQueue(sessionDir);
  const task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task: taskText,
    source: "user",
    priority,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  queue.tasks.push(task);
  queue.tasks.sort((a, b) => b.priority - a.priority);
  await writeQueue(sessionDir, queue);
  const sid = path.basename(sessionDir);
  const label = priority > 0 ? red("[PRIORITY] ") : "";
  console.log(`${green("+")} ${label}${taskText} ${dim(`(${task.id})`)}`);
  console.log(dim(`  Session: ${sid} | Queue: ${queue.tasks.length} pending`));
}
async function feedback(message, sessionDir) {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionFeedbackFile(sessionDir), message + "\n");
  const sid = path.basename(sessionDir);
  console.log(`${green("Feedback sent.")} Agent will receive it on next check. ${dim(`(session: ${sid})`)}`);
}
async function listQueueCmd(sessionDir) {
  const queue = await readQueue(sessionDir);
  const sid = path.basename(sessionDir);
  if (queue.tasks.length === 0) {
    console.log(dim(`Queue is empty. (session: ${sid})`));
    return;
  }
  console.log(bold(`Pending tasks (${queue.tasks.length}):`) + dim(` session: ${sid}
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
async function status(sessionDir) {
  const sid = path.basename(sessionDir);
  try {
    const session = JSON.parse(await fs.readFile(sessionSessionFile(sessionDir), "utf-8"));
    const startTime = new Date(session.started).getTime();
    const minutes = Math.round((Date.now() - startTime) / 6e4);
    console.log(bold("Session:"));
    console.log(`  ID:        ${cyan(sid)}`);
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
  const queue = await readQueue(sessionDir);
  console.log(`
${bold("Queue:")} ${queue.tasks.length} pending`);
  try {
    const reports = JSON.parse(await fs.readFile(sessionStatusFile(sessionDir), "utf-8"));
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
async function clear(sessionDir) {
  await writeQueue(sessionDir, { tasks: [], completed: [] });
  console.log(green("Queue cleared."));
}
async function history(_sessionDir) {
  let completed = [];
  try {
    completed = JSON.parse(await fs.readFile(HISTORY_FILE, "utf-8"));
  } catch {
  }
  if (completed.length === 0) {
    console.log(dim("No completed tasks yet."));
    return;
  }
  console.log(bold(`Completed tasks (${completed.length}):
`));
  for (const task of completed) {
    if (task.task) {
      console.log(`  ${cyan("task")}  ${task.task}`);
    }
    console.log(`  ${green("done")}  ${task.summary}`);
    if (task.output) {
      console.log(`  ${dim("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500")}`);
      for (const line of task.output.split("\n")) {
        console.log(`  ${dim("\u2502")} ${line}`);
      }
      console.log(`  ${dim("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500")}`);
    }
    console.log(dim(`        ${task.completedAt} | ${task.source} | ${task.id}`));
    console.log();
  }
}
async function sessions() {
  const active = await readActiveSessions();
  const ids = Object.keys(active);
  let allDirs = [];
  try {
    allDirs = await fs.readdir(SESSIONS_DIR);
  } catch {
  }
  if (ids.length === 0 && allDirs.length === 0) {
    console.log(dim("No sessions found."));
    return;
  }
  console.log(bold("Sessions:\n"));
  for (const dir of allDirs) {
    const isActive = ids.includes(dir);
    const sessionDir = path.join(SESSIONS_DIR, dir);
    let info = "";
    try {
      const session = JSON.parse(await fs.readFile(path.join(sessionDir, "session.json"), "utf-8"));
      const startTime = new Date(session.started).getTime();
      const minutes = Math.round((Date.now() - startTime) / 6e4);
      const statusColor = session.status === "active" ? green : session.status === "parked" ? yellow : dim;
      info = `${statusColor(session.status)} | ${minutes}min | ${session.tasksCompleted || 0} tasks done`;
    } catch {
      info = dim("no session data");
    }
    const queue = await readQueue(sessionDir);
    const marker = isActive ? green("*") : " ";
    console.log(`  ${marker} ${cyan(dir)}  ${info} | ${queue.tasks.length} queued`);
  }
  if (ids.length > 0) {
    console.log(dim(`
  ${green("*")} = active (MCP server running)`));
  }
}
async function stopSession(sessionDir, sessionId) {
  try {
    const sessionFile = path.join(sessionDir, "session.json");
    const session = JSON.parse(await fs.readFile(sessionFile, "utf-8"));
    session.status = "ended";
    session.ended = (/* @__PURE__ */ new Date()).toISOString();
    await fs.writeFile(sessionFile, JSON.stringify(session, null, 2));
  } catch {
  }
  try {
    const active = await readActiveSessions();
    delete active[sessionId];
    await fs.writeFile(ACTIVE_SESSIONS_FILE, JSON.stringify(active, null, 2));
  } catch {
  }
}
async function killSession(sessionDir, sessionId) {
  const active = await readActiveSessions();
  const entry = active[sessionId];
  if (entry?.pid) {
    try {
      process.kill(entry.pid, "SIGTERM");
      console.log(dim(`  Sent SIGTERM to PID ${entry.pid}`));
    } catch {
    }
  }
  await stopSession(sessionDir, sessionId);
}
async function stopOne(sessionId) {
  const dir = path.join(SESSIONS_DIR, sessionId);
  if (!existsSync(dir)) {
    console.log(red(`Session "${sessionId}" not found.`));
    return;
  }
  console.log(`  ${yellow("stopping")} ${cyan(sessionId)}`);
  await killSession(dir, sessionId);
  console.log(`  ${green("stopped")}  ${cyan(sessionId)}`);
}
async function destroyOne(sessionId) {
  const dir = path.join(SESSIONS_DIR, sessionId);
  if (!existsSync(dir)) {
    console.log(red(`Session "${sessionId}" not found.`));
    return;
  }
  await killSession(dir, sessionId);
  await fs.rm(dir, { recursive: true, force: true });
  console.log(green(`Session ${sessionId} destroyed.`));
}
async function stopAll() {
  const active = await readActiveSessions();
  const ids = Object.keys(active);
  let allDirs = [];
  try {
    allDirs = await fs.readdir(SESSIONS_DIR);
  } catch {
  }
  if (ids.length === 0 && allDirs.length === 0) {
    console.log(dim("No sessions to stop."));
    return;
  }
  for (const id of ids) {
    const dir = path.join(SESSIONS_DIR, id);
    console.log(`  ${yellow("stopping")} ${cyan(id)}`);
    await killSession(dir, id);
    console.log(`  ${green("stopped")}  ${cyan(id)}`);
  }
  for (const dir of allDirs) {
    if (!ids.includes(dir)) {
      const sessionDir = path.join(SESSIONS_DIR, dir);
      await stopSession(sessionDir, dir);
      console.log(`  ${green("cleaned")}  ${cyan(dir)} ${dim("(orphaned)")}`);
    }
  }
  await fs.writeFile(ACTIVE_SESSIONS_FILE, "{}");
  console.log(green("\nAll sessions stopped."));
}
async function destroyAll() {
  await stopAll();
  try {
    const dirs = await fs.readdir(SESSIONS_DIR);
    for (const dir of dirs) {
      await fs.rm(path.join(SESSIONS_DIR, dir), { recursive: true, force: true });
    }
  } catch {
  }
  try {
    await fs.unlink(HISTORY_FILE);
  } catch {
  }
  try {
    await fs.unlink(ACTIVE_SESSIONS_FILE);
  } catch {
  }
  try {
    await fs.unlink(path.join(GROUNDCREW_DIR, "tool-history.csv"));
  } catch {
  }
  console.log(green("All session data and history deleted."));
}
async function listSessionChoices() {
  const active = await readActiveSessions();
  const choices = [];
  for (const [id, entry] of Object.entries(active)) {
    const dir = path.join(SESSIONS_DIR, id);
    let status2 = "active";
    let minutes = 0;
    let tasks = 0;
    let queued = 0;
    try {
      const session = JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf-8"));
      status2 = session.status || "active";
      minutes = Math.round((Date.now() - new Date(session.started).getTime()) / 6e4);
      tasks = session.tasksCompleted || 0;
    } catch {
    }
    try {
      const queue = await readQueue(dir);
      queued = queue.tasks.length;
    } catch {
    }
    choices.push({ id, dir, cwd: entry.cwd || "unknown", status: status2, minutes, tasks, queued });
  }
  return choices;
}
async function pickSession(rl) {
  const choices = await listSessionChoices();
  if (choices.length === 0) {
    console.log(red("No active sessions. Start Copilot with groundcrew first."));
    return null;
  }
  if (choices.length === 1) {
    return choices[0];
  }
  console.log(bold("\nMultiple sessions active:\n"));
  choices.forEach((s, i) => {
    const projectName = path.basename(s.cwd);
    const statusColor = s.status === "active" ? green : s.status === "parked" ? yellow : dim;
    console.log(`  ${bold(String(i + 1))}. ${cyan(s.id)}  ${dim(projectName)}  ${statusColor(s.status)} | ${s.minutes}min | ${s.tasks} done | ${s.queued} queued`);
  });
  console.log();
  return new Promise((resolve) => {
    rl.question(`Pick session [1-${choices.length}]: `, (answer) => {
      const idx = parseInt(answer) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx]);
      } else {
        console.log(red("Invalid choice."));
        resolve(null);
      }
    });
  });
}
var CHAT_COMMANDS = [
  { cmd: "/feedback", desc: "Send feedback to the agent mid-task" },
  { cmd: "/priority", desc: "Queue an urgent task (processed first)" },
  { cmd: "/switch", desc: "Switch to another active session" },
  { cmd: "/sessions", desc: "List all active sessions" },
  { cmd: "/status", desc: "Show current session status" },
  { cmd: "/history", desc: "Show completed tasks" },
  { cmd: "/queue", desc: "Show pending tasks" },
  { cmd: "/clear", desc: "Clear pending tasks" },
  { cmd: "/quit", desc: "Exit chat" }
];
function chatCompleter(line) {
  if (!line.startsWith("/")) return [[], line];
  const matches = CHAT_COMMANDS.filter((c) => c.cmd.startsWith(line)).map((c) => c.cmd + " ");
  return [matches, line];
}
async function chat(explicitSession) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: chatCompleter
  });
  let current = null;
  if (explicitSession) {
    const dir = path.join(SESSIONS_DIR, explicitSession);
    if (!existsSync(dir)) {
      console.log(red(`Session "${explicitSession}" not found.`));
      rl.close();
      return;
    }
    current = { id: explicitSession, dir, cwd: ".", status: "active", minutes: 0, tasks: 0, queued: 0 };
  } else {
    current = await pickSession(rl);
    if (!current) {
      rl.close();
      return;
    }
  }
  const projectName = path.basename(current.cwd);
  console.log(`
${bold("Groundcrew chat")} \u2014 ${cyan(current.id)} ${dim(`(${projectName})`)}`);
  console.log(dim("Type tasks to queue. Press Tab to autocomplete commands.\n"));
  console.log(dim("  Commands:"));
  for (const c of CHAT_COMMANDS) {
    console.log(dim(`    ${cyan(c.cmd.padEnd(14))} ${c.desc}`));
  }
  console.log();
  const prompt = () => {
    rl.question(`${dim(`[${current.id}]`)} ${bold(">")} `, async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        prompt();
        return;
      }
      try {
        if (trimmed === "/quit" || trimmed === "/exit") {
          console.log(dim("Bye."));
          rl.close();
          return;
        }
        if (trimmed === "/sessions") {
          const choices = await listSessionChoices();
          if (choices.length === 0) {
            console.log(dim("No active sessions."));
          } else {
            choices.forEach((s, i) => {
              const marker = s.id === current.id ? green("*") : " ";
              const pName = path.basename(s.cwd);
              console.log(`  ${marker} ${bold(String(i + 1))}. ${cyan(s.id)}  ${dim(pName)} | ${s.status} | ${s.minutes}min | ${s.tasks} done`);
            });
          }
          prompt();
          return;
        }
        if (trimmed.startsWith("/switch")) {
          const arg = trimmed.slice(7).trim();
          const choices = await listSessionChoices();
          if (choices.length === 0) {
            console.log(red("No active sessions."));
            prompt();
            return;
          }
          const idx = parseInt(arg) - 1;
          if (idx >= 0 && idx < choices.length) {
            current = choices[idx];
            console.log(green(`Switched to ${current.id} (${path.basename(current.cwd)})`));
          } else {
            choices.forEach((s, i) => {
              const marker = s.id === current.id ? green("*") : " ";
              console.log(`  ${marker} ${bold(String(i + 1))}. ${cyan(s.id)}  ${dim(path.basename(s.cwd))}`);
            });
          }
          prompt();
          return;
        }
        if (trimmed === "/status") {
          await status(current.dir);
          prompt();
          return;
        }
        if (trimmed === "/history") {
          await history();
          prompt();
          return;
        }
        if (trimmed.startsWith("/feedback ")) {
          const msg = trimmed.slice(10).trim();
          if (msg) {
            await feedback(msg, current.dir);
          } else {
            console.log(red("Usage: /feedback <message>"));
          }
          prompt();
          return;
        }
        if (trimmed.startsWith("/priority ")) {
          const task = trimmed.slice(10).trim();
          if (task) {
            await add(task, 9, current.dir);
          } else {
            console.log(red("Usage: /priority <task>"));
          }
          prompt();
          return;
        }
        if (trimmed === "/queue") {
          await listQueueCmd(current.dir);
          prompt();
          return;
        }
        if (trimmed === "/clear") {
          await clear(current.dir);
          prompt();
          return;
        }
        if (trimmed.startsWith("/")) {
          console.log(red(`Unknown command: ${trimmed.split(" ")[0]}`));
          console.log(dim("  Press Tab to see available commands"));
          prompt();
          return;
        }
        await add(trimmed, 0, current.dir);
      } catch (err) {
        console.error(red(err.message));
      }
      prompt();
    });
  };
  prompt();
}
function usage() {
  console.log(`
${bold("groundcrew")} \u2014 CLI companion for the Groundcrew Copilot plugin

${bold("Usage:")}
  groundcrew chat                              Interactive chat mode (recommended)
  groundcrew chat --session <id>               Chat with a specific session
  groundcrew init                              Initialize .groundcrew/ in current dir
  groundcrew add <task>                        Add a task to the queue
  groundcrew add --priority <task>             Add an urgent task (processed first)
  groundcrew add --session <id> <task>         Add to a specific session
  groundcrew feedback <message>                Send feedback to the agent mid-task
  groundcrew feedback --session <id> <message> Send feedback to a specific session
  groundcrew queue                             List pending tasks
  groundcrew status                            Show session status and last update
  groundcrew sessions                          List all sessions
  groundcrew history                           Show completed tasks
  groundcrew clear                             Clear all pending tasks
  groundcrew stop                              Stop all active sessions
  groundcrew stop --session <id>               Stop a specific session
  groundcrew destroy                           Delete all sessions, history, and data
  groundcrew destroy --session <id>            Delete a specific session

${bold("Session targeting:")}
  Most commands auto-detect the active session. If multiple sessions
  are running, use ${cyan("--session <id>")} to target a specific one.
  Run ${cyan("groundcrew sessions")} to see all session IDs.

${bold("How it works:")}
  1. Start Copilot CLI with groundcrew plugin installed
  2. Give it an initial task or say "start groundcrew"
  3. Open another terminal and use this CLI to queue tasks and send feedback
  4. The agent processes tasks from the queue autonomously
  5. Each Copilot session gets its own isolated queue

${bold("Install:")}
  copilot plugin install jellythomas/groundcrew
`);
}
function extractFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return { value: void 0, remaining: args };
  const value = args[idx + 1];
  const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { value, remaining };
}
async function main() {
  const rawArgs = process.argv.slice(2);
  const { value: explicitSession, remaining: args } = extractFlag(rawArgs, "--session");
  const command = args[0];
  switch (command) {
    case "init":
      await init();
      return;
    case "chat":
      await chat(explicitSession);
      return;
    case "sessions":
      await sessions();
      return;
    case "history":
      await history();
      return;
    case "stop":
    case "kill":
      if (explicitSession) {
        await stopOne(explicitSession);
      } else {
        await stopAll();
      }
      return;
    case "destroy":
      if (explicitSession) {
        await destroyOne(explicitSession);
      } else {
        await destroyAll();
      }
      return;
    case "help":
    case "--help":
    case "-h":
    case void 0:
      usage();
      return;
  }
  let sessionDir;
  try {
    sessionDir = await resolveSessionDir(explicitSession);
  } catch (err) {
    console.error(red(err.message));
    if (!explicitSession) {
      console.error(dim("  Run 'groundcrew sessions' to see available sessions."));
    }
    process.exit(1);
  }
  switch (command) {
    case "add": {
      const hasPriority = args.includes("--priority") || args.includes("-p");
      const taskParts = args.slice(1).filter((a) => a !== "--priority" && a !== "-p");
      const taskText = taskParts.join(" ");
      if (!taskText) {
        console.error(red("Error: task text required."));
        console.error(dim('  groundcrew add "build the dashboard"'));
        process.exit(1);
      }
      await add(taskText, hasPriority ? 9 : 0, sessionDir);
      break;
    }
    case "feedback": {
      const msg = args.slice(1).join(" ");
      if (!msg) {
        console.error(red("Error: feedback message required."));
        console.error(dim('  groundcrew feedback "use bcrypt not argon2"'));
        process.exit(1);
      }
      await feedback(msg, sessionDir);
      break;
    }
    case "queue":
    case "list":
      await listQueueCmd(sessionDir);
      break;
    case "status":
      await status(sessionDir);
      break;
    case "clear":
      await clear(sessionDir);
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
