import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import readline from "readline";

const GROUNDCREW_DIR = ".groundcrew";
const SESSIONS_DIR = path.join(GROUNDCREW_DIR, "sessions");
const ACTIVE_SESSIONS_FILE = path.join(GROUNDCREW_DIR, "active-sessions.json");
const HISTORY_FILE = path.join(GROUNDCREW_DIR, "history.json");

interface Task {
  id: string;
  task: string;
  source: string;
  priority: number;
  createdAt: string;
}

interface QueueData {
  tasks: Task[];
  completed: Array<{
    id: string;
    task: string;
    completedAt: string;
    summary: string;
  }>;
}

interface ActiveSessionEntry {
  started: string;
  pid: number;
  cwd: string;
}

// ── Session Resolution ───────────────────────────────────────────────────────

async function readActiveSessions(): Promise<Record<string, ActiveSessionEntry>> {
  try {
    return JSON.parse(await fs.readFile(ACTIVE_SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Resolve which session to target.
 * Priority: --session flag > single active session > error if ambiguous.
 */
async function resolveSessionDir(explicitSession?: string): Promise<string> {
  if (explicitSession) {
    const dir = path.join(SESSIONS_DIR, explicitSession);
    if (!existsSync(dir)) {
      throw new Error(`Session "${explicitSession}" not found.`);
    }
    return dir;
  }

  const sessions = await readActiveSessions();
  const ids = Object.keys(sessions);

  if (ids.length === 0) {
    // Fallback: check if any session dirs exist (server may have exited without cleanup)
    try {
      const dirs = await fs.readdir(SESSIONS_DIR);
      if (dirs.length === 1) return path.join(SESSIONS_DIR, dirs[0]);
      if (dirs.length > 1) {
        // Pick most recently modified
        let latest = { dir: dirs[0], mtime: 0 };
        for (const d of dirs) {
          try {
            const stat = await fs.stat(path.join(SESSIONS_DIR, d, "session.json"));
            if (stat.mtimeMs > latest.mtime) {
              latest = { dir: d, mtime: stat.mtimeMs };
            }
          } catch { /* skip */ }
        }
        return path.join(SESSIONS_DIR, latest.dir);
      }
    } catch { /* no sessions dir */ }
    throw new Error("No active sessions. Start Copilot with groundcrew first.");
  }

  if (ids.length === 1) {
    return path.join(SESSIONS_DIR, ids[0]);
  }

  // Multiple sessions — pick latest
  let latest = { id: ids[0], time: 0 };
  for (const id of ids) {
    const started = new Date(sessions[id].started).getTime();
    if (started > latest.time) {
      latest = { id, time: started };
    }
  }
  return path.join(SESSIONS_DIR, latest.id);
}

function sessionQueueFile(sessionDir: string): string {
  return path.join(sessionDir, "queue.json");
}

function sessionFeedbackFile(sessionDir: string): string {
  return path.join(sessionDir, "feedback.md");
}

function sessionSessionFile(sessionDir: string): string {
  return path.join(sessionDir, "session.json");
}

function sessionStatusFile(sessionDir: string): string {
  return path.join(sessionDir, "status.json");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readQueue(sessionDir: string): Promise<QueueData> {
  try {
    return JSON.parse(await fs.readFile(sessionQueueFile(sessionDir), "utf-8"));
  } catch {
    return { tasks: [], completed: [] };
  }
}

async function writeQueue(sessionDir: string, data: QueueData): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionQueueFile(sessionDir), JSON.stringify(data, null, 2));
}

function color(code: number, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

const green = (t: string) => color(32, t);
const yellow = (t: string) => color(33, t);
const cyan = (t: string) => color(36, t);
const dim = (t: string) => color(2, t);
const bold = (t: string) => color(1, t);
const red = (t: string) => color(31, t);

// ── Commands ──────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  console.log(green("Groundcrew initialized.") + ` ${dim(GROUNDCREW_DIR + "/ created")}`);
}

async function add(taskText: string, priority: number, sessionDir: string): Promise<void> {
  const queue = await readQueue(sessionDir);
  const task: Task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task: taskText,
    source: "user",
    priority,
    createdAt: new Date().toISOString(),
  };
  queue.tasks.push(task);
  queue.tasks.sort((a, b) => b.priority - a.priority);
  await writeQueue(sessionDir, queue);

  const sid = path.basename(sessionDir);
  const label = priority > 0 ? red("[PRIORITY] ") : "";
  console.log(`${green("+")} ${label}${taskText} ${dim(`(${task.id})`)}`);
  console.log(dim(`  Session: ${sid} | Queue: ${queue.tasks.length} pending`));
}

async function feedback(message: string, sessionDir: string): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionFeedbackFile(sessionDir), message + "\n");
  const sid = path.basename(sessionDir);
  console.log(`${green("Feedback sent.")} Agent will receive it on next check. ${dim(`(session: ${sid})`)}`);
}

async function listQueueCmd(sessionDir: string): Promise<void> {
  const queue = await readQueue(sessionDir);
  const sid = path.basename(sessionDir);

  if (queue.tasks.length === 0) {
    console.log(dim(`Queue is empty. (session: ${sid})`));
    return;
  }

  console.log(bold(`Pending tasks (${queue.tasks.length}):`) + dim(` session: ${sid}\n`));
  for (const [i, task] of queue.tasks.entries()) {
    const pri = task.priority > 0 ? red(` [P${task.priority}]`) : "";
    console.log(`  ${cyan(`${i + 1}.`)}${pri} ${task.task}`);
    console.log(dim(`     ${task.source} | ${task.id}`));
  }

  if (queue.completed.length > 0) {
    console.log(dim(`\n  ${queue.completed.length} task(s) completed this session.`));
  }
}

async function status(sessionDir: string): Promise<void> {
  const sid = path.basename(sessionDir);

  // Session info
  try {
    const session = JSON.parse(await fs.readFile(sessionSessionFile(sessionDir), "utf-8"));
    const startTime = new Date(session.started).getTime();
    const minutes = Math.round((Date.now() - startTime) / 60000);

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

  // Queue info
  const queue = await readQueue(sessionDir);
  console.log(`\n${bold("Queue:")} ${queue.tasks.length} pending`);

  // Last status report
  try {
    const reports = JSON.parse(await fs.readFile(sessionStatusFile(sessionDir), "utf-8"));
    if (reports.length > 0) {
      const last = reports[reports.length - 1];
      console.log(`\n${bold("Last update:")} ${last.message}`);
      if (last.progress) console.log(`  Progress: ${last.progress}`);
      console.log(dim(`  ${last.timestamp}`));
    }
  } catch {
    // No status reports yet
  }
}

async function clear(sessionDir: string): Promise<void> {
  await writeQueue(sessionDir, { tasks: [], completed: [] });
  console.log(green("Queue cleared."));
}

async function history(_sessionDir?: string): Promise<void> {
  // Read from project-level history (persists across sessions)
  let completed: Array<{
    id: string;
    task: string;
    source: string;
    completedAt: string;
    summary: string;
    output?: string;
  }> = [];

  try {
    completed = JSON.parse(await fs.readFile(HISTORY_FILE, "utf-8"));
  } catch { /* no history yet */ }

  if (completed.length === 0) {
    console.log(dim("No completed tasks yet."));
    return;
  }

  console.log(bold(`Completed tasks (${completed.length}):\n`));
  for (const task of completed) {
    // Task prompt
    if (task.task) {
      console.log(`  ${cyan("task")}  ${task.task}`);
    }
    // Summary
    console.log(`  ${green("done")}  ${task.summary}`);
    // Full output
    if (task.output) {
      console.log(`  ${dim("───────────────────────────────────────")}`);
      for (const line of task.output.split("\n")) {
        console.log(`  ${dim("│")} ${line}`);
      }
      console.log(`  ${dim("───────────────────────────────────────")}`);
    }
    console.log(dim(`        ${task.completedAt} | ${task.source} | ${task.id}`));
    console.log();
  }
}

async function sessions(): Promise<void> {
  const active = await readActiveSessions();
  const ids = Object.keys(active);

  // Also check for session dirs that may not be in active-sessions.json
  let allDirs: string[] = [];
  try {
    allDirs = await fs.readdir(SESSIONS_DIR);
  } catch { /* no sessions */ }

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
      const minutes = Math.round((Date.now() - startTime) / 60000);
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
    console.log(dim(`\n  ${green("*")} = active (MCP server running)`));
  }
}

// ── Chat Mode ────────────────────────────────────────────────────────────────

interface SessionChoice {
  id: string;
  dir: string;
  cwd: string;
  status: string;
  minutes: number;
  tasks: number;
  queued: number;
}

async function listSessionChoices(): Promise<SessionChoice[]> {
  const active = await readActiveSessions();
  const choices: SessionChoice[] = [];

  for (const [id, entry] of Object.entries(active)) {
    const dir = path.join(SESSIONS_DIR, id);
    let status = "active";
    let minutes = 0;
    let tasks = 0;
    let queued = 0;

    try {
      const session = JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf-8"));
      status = session.status || "active";
      minutes = Math.round((Date.now() - new Date(session.started).getTime()) / 60000);
      tasks = session.tasksCompleted || 0;
    } catch {}

    try {
      const queue = await readQueue(dir);
      queued = queue.tasks.length;
    } catch {}

    choices.push({ id, dir, cwd: entry.cwd || "unknown", status, minutes, tasks, queued });
  }

  return choices;
}

async function pickSession(rl: readline.Interface): Promise<SessionChoice | null> {
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

async function chat(explicitSession?: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let current: SessionChoice | null = null;

  // Resolve initial session
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
  console.log(`\n${bold("Groundcrew chat")} — ${cyan(current.id)} ${dim(`(${projectName})`)}`);
  console.log(dim("Type tasks to queue. Commands: /feedback, /priority, /switch, /sessions, /status, /history, /quit\n"));

  const prompt = () => {
    rl.question(`${dim(`[${current!.id}]`)} ${bold(">")} `, async (line) => {
      const trimmed = line.trim();
      if (!trimmed) { prompt(); return; }

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
              const marker = s.id === current!.id ? green("*") : " ";
              const pName = path.basename(s.cwd);
              console.log(`  ${marker} ${bold(String(i + 1))}. ${cyan(s.id)}  ${dim(pName)} | ${s.status} | ${s.minutes}min | ${s.tasks} done`);
            });
          }
          prompt(); return;
        }

        if (trimmed.startsWith("/switch")) {
          const arg = trimmed.slice(7).trim();
          const choices = await listSessionChoices();
          if (choices.length === 0) {
            console.log(red("No active sessions."));
            prompt(); return;
          }
          const idx = parseInt(arg) - 1;
          if (idx >= 0 && idx < choices.length) {
            current = choices[idx];
            console.log(green(`Switched to ${current.id} (${path.basename(current.cwd)})`));
          } else {
            // Show picker
            choices.forEach((s, i) => {
              const marker = s.id === current!.id ? green("*") : " ";
              console.log(`  ${marker} ${bold(String(i + 1))}. ${cyan(s.id)}  ${dim(path.basename(s.cwd))}`);
            });
          }
          prompt(); return;
        }

        if (trimmed === "/status") {
          await status(current!.dir);
          prompt(); return;
        }

        if (trimmed === "/history") {
          await history();
          prompt(); return;
        }

        if (trimmed.startsWith("/feedback ")) {
          const msg = trimmed.slice(10).trim();
          if (msg) {
            await feedback(msg, current!.dir);
          } else {
            console.log(red("Usage: /feedback <message>"));
          }
          prompt(); return;
        }

        if (trimmed.startsWith("/priority ")) {
          const task = trimmed.slice(10).trim();
          if (task) {
            await add(task, 9, current!.dir);
          } else {
            console.log(red("Usage: /priority <task>"));
          }
          prompt(); return;
        }

        if (trimmed.startsWith("/")) {
          console.log(red(`Unknown command: ${trimmed.split(" ")[0]}`));
          console.log(dim("Commands: /feedback, /priority, /switch, /sessions, /status, /history, /quit"));
          prompt(); return;
        }

        // Default: queue as task
        await add(trimmed, 0, current!.dir);

      } catch (err: any) {
        console.error(red(err.message));
      }

      prompt();
    });
  };

  prompt();
}

// ── Main ──────────────────────────────────────────────────────────────────────

function usage(): void {
  console.log(`
${bold("groundcrew")} — CLI companion for the Groundcrew Copilot plugin

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

function extractFlag(args: string[], flag: string): { value: string | undefined; remaining: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { value: undefined, remaining: args };
  const value = args[idx + 1];
  const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { value, remaining };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Extract --session flag from anywhere in args
  const { value: explicitSession, remaining: args } = extractFlag(rawArgs, "--session");

  const command = args[0];

  // Commands that don't need a session (handle their own resolution)
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
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      return;
  }

  // Commands that need a session
  let sessionDir: string;
  try {
    sessionDir = await resolveSessionDir(explicitSession);
  } catch (err: any) {
    console.error(red(err.message));
    if (!explicitSession) {
      console.error(dim("  Run 'groundcrew sessions' to see available sessions."));
    }
    process.exit(1);
  }

  switch (command) {
    case "add": {
      const hasPriority = args.includes("--priority") || args.includes("-p");
      const taskParts = args
        .slice(1)
        .filter((a) => a !== "--priority" && a !== "-p");
      const taskText = taskParts.join(" ");

      if (!taskText) {
        console.error(red("Error: task text required."));
        console.error(dim("  groundcrew add \"build the dashboard\""));
        process.exit(1);
      }

      await add(taskText, hasPriority ? 9 : 0, sessionDir);
      break;
    }

    case "feedback": {
      const msg = args.slice(1).join(" ");
      if (!msg) {
        console.error(red("Error: feedback message required."));
        console.error(dim("  groundcrew feedback \"use bcrypt not argon2\""));
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
