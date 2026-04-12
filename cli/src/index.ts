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

// ── Session Management ───────────────────────────────────────────────────────

async function stopSession(sessionDir: string, sessionId: string): Promise<void> {
  // Mark session as ended
  try {
    const sessionFile = path.join(sessionDir, "session.json");
    const session = JSON.parse(await fs.readFile(sessionFile, "utf-8"));
    session.status = "ended";
    session.ended = new Date().toISOString();
    await fs.writeFile(sessionFile, JSON.stringify(session, null, 2));
  } catch { /* best effort */ }

  // Remove from active sessions
  try {
    const active = await readActiveSessions();
    delete active[sessionId];
    await fs.writeFile(ACTIVE_SESSIONS_FILE, JSON.stringify(active, null, 2));
  } catch { /* best effort */ }
}

async function killSession(sessionDir: string, sessionId: string): Promise<void> {
  // Try to kill the MCP server process
  const active = await readActiveSessions();
  const entry = active[sessionId];
  if (entry?.pid) {
    try {
      process.kill(entry.pid, "SIGTERM");
      console.log(dim(`  Sent SIGTERM to PID ${entry.pid}`));
    } catch {
      // Process already gone
    }
  }
  await stopSession(sessionDir, sessionId);
}

async function stopOne(sessionId: string): Promise<void> {
  const dir = path.join(SESSIONS_DIR, sessionId);
  if (!existsSync(dir)) {
    console.log(red(`Session "${sessionId}" not found.`));
    return;
  }
  console.log(`  ${yellow("stopping")} ${cyan(sessionId)}`);
  await killSession(dir, sessionId);
  console.log(`  ${green("stopped")}  ${cyan(sessionId)}`);
}

async function destroyOne(sessionId: string): Promise<void> {
  const dir = path.join(SESSIONS_DIR, sessionId);
  if (!existsSync(dir)) {
    console.log(red(`Session "${sessionId}" not found.`));
    return;
  }
  await killSession(dir, sessionId);
  await fs.rm(dir, { recursive: true, force: true });
  console.log(green(`Session ${sessionId} destroyed.`));
}

async function stopAll(): Promise<void> {
  const active = await readActiveSessions();
  const ids = Object.keys(active);

  let allDirs: string[] = [];
  try { allDirs = await fs.readdir(SESSIONS_DIR); } catch {}

  if (ids.length === 0 && allDirs.length === 0) {
    console.log(dim("No sessions to stop."));
    return;
  }

  // Kill active sessions (have PIDs)
  for (const id of ids) {
    const dir = path.join(SESSIONS_DIR, id);
    console.log(`  ${yellow("stopping")} ${cyan(id)}`);
    await killSession(dir, id);
    console.log(`  ${green("stopped")}  ${cyan(id)}`);
  }

  // Mark any orphaned session dirs as ended
  for (const dir of allDirs) {
    if (!ids.includes(dir)) {
      const sessionDir = path.join(SESSIONS_DIR, dir);
      await stopSession(sessionDir, dir);
      console.log(`  ${green("cleaned")}  ${cyan(dir)} ${dim("(orphaned)")}`);
    }
  }

  // Clear active sessions file
  await fs.writeFile(ACTIVE_SESSIONS_FILE, "{}");
  console.log(green("\nAll sessions stopped."));
}

async function destroyAll(): Promise<void> {
  // Stop everything first
  await stopAll();

  // Delete all session directories
  try {
    const dirs = await fs.readdir(SESSIONS_DIR);
    for (const dir of dirs) {
      await fs.rm(path.join(SESSIONS_DIR, dir), { recursive: true, force: true });
    }
  } catch { /* no sessions dir */ }

  // Delete history
  try { await fs.unlink(HISTORY_FILE); } catch {}

  // Delete active sessions file
  try { await fs.unlink(ACTIVE_SESSIONS_FILE); } catch {}

  // Delete tool history
  try { await fs.unlink(path.join(GROUNDCREW_DIR, "tool-history.csv")); } catch {}

  console.log(green("All session data and history deleted."));
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

const CHAT_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/feedback",  desc: "Send feedback to the agent mid-task" },
  { cmd: "/priority",  desc: "Queue an urgent task (processed first)" },
  { cmd: "/switch",    desc: "Switch to another active session" },
  { cmd: "/sessions",  desc: "List all active sessions" },
  { cmd: "/status",    desc: "Show current session status" },
  { cmd: "/history",   desc: "Show completed tasks" },
  { cmd: "/queue",     desc: "Show pending tasks" },
  { cmd: "/clear",     desc: "Clear pending tasks" },
  { cmd: "/quit",      desc: "Exit chat" },
];

function chatCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const matches = CHAT_COMMANDS.filter((c) => c.cmd.startsWith(line));

  if (matches.length === 1) {
    return [[matches[0].cmd + " "], line];
  }

  if (matches.length > 1) {
    const display = matches.map((c) => `${c.cmd.padEnd(14)} ${c.desc}`);
    console.log();
    display.forEach((d) => console.log(`  ${d}`));
    return [matches.map((c) => c.cmd), line];
  }

  return [[], line];
}

/**
 * Show inline ghost suggestion as user types / commands.
 * Renders dimmed text after cursor, erased on next keystroke.
 */
function setupInlineSuggestions(rl: readline.Interface): void {
  let lastGhostLen = 0;

  const clearGhost = () => {
    if (lastGhostLen > 0) {
      // Move cursor back to end of typed text, clear ghost
      process.stdout.write("\x1b[" + lastGhostLen + "D");
      process.stdout.write("\x1b[0K");
      lastGhostLen = 0;
    }
  };

  const showGhost = () => {
    const line = (rl as any).line as string;
    if (!line || !line.startsWith("/") || line.includes(" ")) {
      clearGhost();
      return;
    }

    const matches = CHAT_COMMANDS.filter((c) => c.cmd.startsWith(line));
    if (matches.length === 0) {
      clearGhost();
      return;
    }

    // Show best match as ghost
    const best = matches[0];
    const ghost = best.cmd.slice(line.length);
    const hint = ghost + dim(` — ${best.desc}`);
    const rawLen = ghost.length + ` — ${best.desc}`.length;

    clearGhost();
    if (ghost || matches.length > 0) {
      // Write dimmed ghost text
      process.stdout.write(`\x1b[2m${ghost} — ${best.desc}\x1b[0m`);
      // Move cursor back to where user is typing
      lastGhostLen = rawLen;
      process.stdout.write("\x1b[" + rawLen + "D");
    }
  };

  // Listen to keypresses
  process.stdin.on("keypress", (_ch: string, key: any) => {
    if (!key) return;
    // Clear ghost first, then show updated one on next tick
    clearGhost();
    if (key.name !== "return" && key.name !== "tab" && key.name !== "backspace") {
      setImmediate(showGhost);
    } else if (key.name === "backspace") {
      setImmediate(showGhost);
    }
  });
}

async function chat(explicitSession?: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: chatCompleter,
  });

  setupInlineSuggestions(rl);

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
  const W = 47; // inner width
  const title = `  groundcrew  ${current.id}  ${projectName}  `;
  const pad1 = Math.max(0, W - title.length);
  console.log();
  console.log(dim("  ╭" + "─".repeat(W) + "╮"));
  console.log(dim("  │") + "  " + bold("groundcrew") + "  " + cyan(current.id) + "  " + dim(projectName) + " ".repeat(pad1) + dim("  │"));
  console.log(dim("  ├" + "─".repeat(W) + "┤"));
  console.log(dim("  │  Type tasks to queue. / for commands.       │"));
  console.log(dim("  │  End line with \\ for multiline.             │"));
  console.log(dim("  ╰" + "─".repeat(W) + "╯"));
  console.log();

  let continuationBuffer: string[] = [];

  // Handle Ctrl+C gracefully
  rl.on("close", () => {
    console.log(dim("\nBye."));
    process.exit(0);
  });

  const prompt = () => {
    const isContinuation = continuationBuffer.length > 0;
    const prefix = isContinuation
      ? `${dim(`[${current!.id}]`)} ${dim("...")} `
      : `${dim(`[${current!.id}]`)} ${bold(">")} `;

    rl.question(prefix, async (line) => {
      // Line continuation with backslash
      if (line.endsWith("\\")) {
        continuationBuffer.push(line.slice(0, -1));
        prompt(); return;
      }

      // If we were in continuation mode, join and process
      if (continuationBuffer.length > 0) {
        continuationBuffer.push(line);
        const fullText = continuationBuffer.join("\n").trim();
        continuationBuffer = [];
        if (fullText) {
          try {
            if (fullText.startsWith("/")) {
              // Process as command — use first line
              // (multiline commands don't make sense, treat as task)
              await add(fullText, 0, current!.dir);
            } else {
              await add(fullText, 0, current!.dir);
            }
          } catch (err: any) {
            console.error(red(err.message));
          }
        }
        prompt(); return;
      }

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

        if (trimmed === "/queue") {
          await listQueueCmd(current!.dir);
          prompt(); return;
        }

        if (trimmed === "/clear") {
          await clear(current!.dir);
          prompt(); return;
        }

        if (trimmed.startsWith("/")) {
          console.log(red(`Unknown command: ${trimmed.split(" ")[0]}`));
          console.log(dim("  Press Tab to see available commands"));
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
