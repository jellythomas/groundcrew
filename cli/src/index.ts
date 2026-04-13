import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Git context for separator line (cached, refreshed periodically)
function getGitContext(): { branch: string; dirty: string } | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8", timeout: 500, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // Status indicators matching Copilot CLI: * unstaged, + staged, % untracked
    let dirty = "";
    try {
      const status = execFileSync("git", ["status", "--porcelain", "-uno"], {
        encoding: "utf8", timeout: 500, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (status) {
        const hasStaged = status.split("\n").some(l => l[0] !== " " && l[0] !== "?");
        const hasUnstaged = status.split("\n").some(l => l[1] === "M" || l[1] === "D");
        if (hasStaged) dirty += "+";
        if (hasUnstaged) dirty += "*";
      }
      const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
        encoding: "utf8", timeout: 500, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (untracked) dirty += "%";
    } catch { /* ignore status errors */ }
    return { branch, dirty };
  } catch {
    return null;
  }
}

// Clipboard paste with image support (macOS)
function pasteFromClipboard(sessionDir: string): { type: "text"; text: string } | { type: "image"; path: string } | null {
  // Try text first (fast)
  try {
    const text = execFileSync("pbpaste", [], { encoding: "utf8", timeout: 1000, stdio: ["pipe", "pipe", "pipe"] }).replace(/\r\n/g, "\n");
    if (text) return { type: "text", text };
  } catch { /* no text */ }

  // Check for image in clipboard
  if (process.platform !== "darwin") return null;
  try {
    const check = execFileSync("osascript", ["-e",
      'try\nthe clipboard as «class PNGf»\nreturn "image"\non error\nreturn "none"\nend try',
    ], { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (check !== "image") return null;

    // Save image to session attachments dir
    const attachDir = path.join(sessionDir, "attachments");
    try { execFileSync("mkdir", ["-p", attachDir]); } catch { /* exists */ }
    const fname = `clipboard-${Date.now()}.png`;
    const fpath = path.join(attachDir, fname);
    execFileSync("osascript", ["-e", `
set theFile to POSIX file "${fpath}"
set imageData to the clipboard as «class PNGf»
set fp to open for access theFile with write permission
set eof fp to 0
write imageData to fp
close access fp`], { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
    return { type: "image", path: fpath };
  } catch { return null; }
}

// ── Centralized storage at ~/.groundcrew ─────────────────────────────────────
const GROUNDCREW_HOME = path.join(os.homedir(), ".groundcrew");
const SESSIONS_DIR = path.join(GROUNDCREW_HOME, "sessions");
const ACTIVE_SESSIONS_FILE = path.join(GROUNDCREW_HOME, "active-sessions.json");
const HISTORY_FILE = path.join(GROUNDCREW_HOME, "history.json");

let REPO_NAME = "";

/**
 * Derive repo name from CWD (git-aware for worktree/subdirectory support).
 */
async function resolveRoot(): Promise<void> {
  let root: string | null = null;

  // 1. Try git rev-parse --show-toplevel (worktree-aware)
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    root = stdout.trim() || null;
  } catch { /* not a git repo or git not installed */ }

  // 2. Fallback to CWD
  if (!root) root = process.cwd();

  REPO_NAME = path.basename(root).replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";

  // Ensure centralized dirs exist
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

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
 * Filter session IDs that belong to the current repo.
 * Session IDs are prefixed with repo name: "mekari_credit-a1b2c3d4"
 */
function isRepoSession(sessionId: string): boolean {
  return sessionId.startsWith(REPO_NAME + "-");
}

/**
 * Resolve which session to target.
 * Priority: --session flag > single active repo session > error if ambiguous.
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
  // Filter to sessions for THIS repo
  const ids = Object.keys(sessions).filter(isRepoSession);

  if (ids.length === 0) {
    // Fallback: check session dirs on disk for this repo
    try {
      const dirs = (await fs.readdir(SESSIONS_DIR)).filter(isRepoSession);
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
    throw new Error(`No active sessions for repo "${REPO_NAME}". Start Copilot with groundcrew first.`);
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

  // Group by repo prefix
  const byRepo = new Map<string, string[]>();
  for (const dir of allDirs) {
    const dashIdx = dir.lastIndexOf("-");
    const repo = dashIdx > 0 ? dir.substring(0, dashIdx) : "unknown";
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo)!.push(dir);
  }

  console.log(bold("Sessions:\n"));

  for (const [repo, dirs] of byRepo) {
    const isCurrent = repo === REPO_NAME;
    console.log(`  ${isCurrent ? green(repo) : dim(repo)}`);

    for (const dir of dirs) {
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
      // Show only the hex suffix for cleaner display
      const shortId = dir.substring(repo.length + 1);

      console.log(`    ${marker} ${cyan(shortId)}  ${info} | ${queue.tasks.length} queued`);
    }
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
  // Scope to current repo
  const ids = Object.keys(active).filter(isRepoSession);

  let allDirs: string[] = [];
  try { allDirs = (await fs.readdir(SESSIONS_DIR)).filter(isRepoSession); } catch {}

  if (ids.length === 0 && allDirs.length === 0) {
    console.log(dim(`No sessions to stop for repo "${REPO_NAME}".`));
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

  // Remove stopped sessions from active-sessions.json (keep other repos)
  const remaining = await readActiveSessions();
  for (const id of ids) delete remaining[id];
  await fs.writeFile(ACTIVE_SESSIONS_FILE, JSON.stringify(remaining, null, 2));
  console.log(green(`\nAll ${REPO_NAME} sessions stopped.`));
}

async function destroyAll(): Promise<void> {
  // Stop this repo's sessions first
  await stopAll();

  // Delete this repo's session directories only
  try {
    const dirs = (await fs.readdir(SESSIONS_DIR)).filter(isRepoSession);
    for (const dir of dirs) {
      await fs.rm(path.join(SESSIONS_DIR, dir), { recursive: true, force: true });
    }
  } catch { /* no sessions dir */ }

  // Delete tool history
  try { await fs.unlink(path.join(GROUNDCREW_HOME, "tool-history.csv")); } catch {}

  console.log(green(`All ${REPO_NAME} session data deleted.`));
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
    // Only show sessions for the current repo
    if (!isRepoSession(id)) continue;

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
    console.log(red(`No active sessions for repo "${REPO_NAME}". Start Copilot with groundcrew first.`));
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
  { cmd: "/exit",      desc: "Exit chat" },
];

/**
 * Custom multiline editor — replaces readline for chat input.
 * No `\` line endings, no `...` prefix, clean aligned continuation.
 * Uses ANSI escape sequences for in-place rendering.
 *
 * Submit: Enter
 * Newline: Shift+Enter (Kitty), Alt+Enter, Ctrl+J
 * Clear: Ctrl+C (clears input, or exits if empty)
 * Navigation: Arrow keys, Home/End, Ctrl+A/E
 * Editing: Backspace, Delete, Ctrl+U/K/W/D
 * Tab: slash command completion
 * Paste: bracketed paste with multiline support
 */
function readMultilineInput(sessionId: string, projectName: string, gitCtx: { branch: string; dirty: string } | null, sessionDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const lines: string[] = [""];
    let crow = 0;  // cursor row in lines[]
    let ccol = 0;  // cursor col in lines[crow]

    // Visible width of prompt: "[sessionId] > "
    const padWidth = sessionId.length + 5; // [ + id + ] + space + > + space = len+5
    const linePad = (i: number) => i === 0 ? padWidth : 0;

    // Track how many rows up from cursor to top of rendered area (including separator)
    let lastTermRow = 0;
    let pasteBuffer = "";
    let isPasting = false;

    const fullText = () => lines.join("\n").trim();

    const render = () => {
      const buf: string[] = [];

      // Move to start of input area (includes separator line + suggestions)
      if (lastTermRow > 0) buf.push(`\x1b[${lastTermRow}A`);
      buf.push("\r\x1b[J"); // col 0 + clear to end of screen

      // Separator line: ─── sessionId  projectName git:(branch*) ───
      const termW = process.stdout.columns || 80;
      let info = ` ${sessionId} `;
      const ctxParts: string[] = [];
      if (projectName) ctxParts.push(projectName);
      if (gitCtx) {
        ctxParts.push(`git:(${gitCtx.branch}${gitCtx.dirty})`);
      }
      if (ctxParts.length) info += ` ${ctxParts.join(" ")} `;
      const dashRight = "─".repeat(Math.max(0, termW - 4 - info.length));
      buf.push(dim("───" + info + dashRight));

      // Draw each input line (below separator)
      for (let i = 0; i < lines.length; i++) {
        buf.push("\n");
        if (i === 0) {
          buf.push(dim(`[${sessionId}]`) + " " + bold(">") + " " + lines[i]);
        } else {
          buf.push(lines[i]);
        }
      }

      // Auto-show slash command suggestions below input
      let suggestionRows = 0;
      if (lines.length === 1 && lines[0].startsWith("/") && !lines[0].includes(" ")) {
        const partial = lines[0];
        const matches = CHAT_COMMANDS.filter(c => c.cmd.startsWith(partial));
        if (matches.length > 0 && partial.length >= 1) {
          for (const m of matches) {
            buf.push(`\n  ${cyan(m.cmd.padEnd(14))} ${dim(m.desc)}`);
            suggestionRows++;
          }
        }
      }

      // Position cursor at (crow, ccol)
      const lastRow = lines.length - 1;

      // Calculate actual terminal rows each line occupies (for wrapped lines)
      const termRowsForLine = (i: number): number => {
        const lineLen = linePad(i) + lines[i].length;
        return lineLen === 0 ? 1 : Math.max(1, Math.ceil(lineLen / termW));
      };

      // Move up from the end of the last drawn line to the cursor position
      // Count terminal rows below cursor line (remaining input lines + suggestions)
      let rowsBelowCursor = suggestionRows;
      for (let i = lastRow; i > crow; i--) rowsBelowCursor += termRowsForLine(i);
      // Add any extra wrapped rows on the cursor line itself (below the cursor's row within wraps)
      const cursorLineTermRows = termRowsForLine(crow);
      const cursorPad = linePad(crow);
      const cursorRowWithinLine = Math.floor((cursorPad + ccol) / termW);
      rowsBelowCursor += (cursorLineTermRows - 1 - cursorRowWithinLine);

      if (rowsBelowCursor > 0) buf.push(`\x1b[${rowsBelowCursor}A`);

      buf.push("\r");
      const col = (cursorPad + ccol) % termW;
      if (col > 0) buf.push(`\x1b[${col}C`);

      // lastTermRow = terminal rows above cursor (separator + wrapped input lines above crow + cursor's wrapped rows above)
      let rowsAbove = 1; // separator line
      for (let i = 0; i < crow; i++) rowsAbove += termRowsForLine(i);
      rowsAbove += cursorRowWithinLine;
      lastTermRow = rowsAbove;
      process.stdout.write(buf.join(""));
    };

    const finish = (result: string | null) => {
      process.stdin.removeListener("data", onData);
      resolve(result);
    };

    const submit = () => {
      const text = fullText();
      // Erase the separator + input area, then re-draw only the prompt (no separator in history)
      const buf: string[] = [];
      if (lastTermRow > 0) buf.push(`\x1b[${lastTermRow}A`);
      buf.push("\r\x1b[J"); // clear from separator line down

      // Re-draw only the input lines (no separator)
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) buf.push("\n");
        if (i === 0) {
          buf.push(dim(`[${sessionId}]`) + " " + bold(">") + " " + lines[i]);
        } else {
          buf.push(lines[i]);
        }
      }
      buf.push("\n");
      process.stdout.write(buf.join(""));
      lastTermRow = 0;
      finish(text || null);
    };

    const insertText = (text: string) => {
      const chunks = text.split(/\r?\n/);
      const before = lines[crow].slice(0, ccol);
      const after = lines[crow].slice(ccol);

      if (chunks.length === 1) {
        lines[crow] = before + chunks[0] + after;
        ccol += chunks[0].length;
      } else {
        lines[crow] = before + chunks[0];
        const middle = chunks.slice(1, -1);
        const last = chunks[chunks.length - 1];
        lines.splice(crow + 1, 0, ...middle, last + after);
        crow += chunks.length - 1;
        ccol = last.length;
      }
      render();
    };

    const insertNewline = () => {
      const before = lines[crow].slice(0, ccol);
      const after = lines[crow].slice(ccol);
      lines[crow] = before;
      lines.splice(crow + 1, 0, after);
      crow++;
      ccol = 0;
      render();
    };

    const doBackspace = () => {
      if (ccol > 0) {
        lines[crow] = lines[crow].slice(0, ccol - 1) + lines[crow].slice(ccol);
        ccol--;
      } else if (crow > 0) {
        const prevLen = lines[crow - 1].length;
        lines[crow - 1] += lines[crow];
        lines.splice(crow, 1);
        crow--;
        ccol = prevLen;
      }
      render();
    };

    const doDelete = () => {
      if (ccol < lines[crow].length) {
        lines[crow] = lines[crow].slice(0, ccol) + lines[crow].slice(ccol + 1);
      } else if (crow < lines.length - 1) {
        lines[crow] += lines[crow + 1];
        lines.splice(crow + 1, 1);
      }
      render();
    };

    const processKeys = (str: string) => {
      let i = 0;
      while (i < str.length) {
        // Shift+Enter (Kitty: \x1b[13;2u)
        if (str.startsWith("\x1b[13;2u", i)) { insertNewline(); i += 7; continue; }

        // Alt+Enter (ESC + CR or ESC + LF)
        if (i + 1 < str.length && str[i] === "\x1b" && (str[i + 1] === "\r" || str[i + 1] === "\n")) {
          insertNewline(); i += 2; continue;
        }

        // Arrow Up
        if (str.startsWith("\x1b[A", i)) {
          if (crow > 0) { crow--; ccol = Math.min(ccol, lines[crow].length); render(); }
          i += 3; continue;
        }
        // Arrow Down
        if (str.startsWith("\x1b[B", i)) {
          if (crow < lines.length - 1) { crow++; ccol = Math.min(ccol, lines[crow].length); render(); }
          i += 3; continue;
        }
        // Arrow Right
        if (str.startsWith("\x1b[C", i)) {
          if (ccol < lines[crow].length) ccol++;
          else if (crow < lines.length - 1) { crow++; ccol = 0; }
          render(); i += 3; continue;
        }
        // Arrow Left
        if (str.startsWith("\x1b[D", i)) {
          if (ccol > 0) ccol--;
          else if (crow > 0) { crow--; ccol = lines[crow].length; }
          render(); i += 3; continue;
        }

        // Delete key (\x1b[3~)
        if (str.startsWith("\x1b[3~", i)) { doDelete(); i += 4; continue; }

        // Home (\x1b[H)
        if (str.startsWith("\x1b[H", i)) { ccol = 0; render(); i += 3; continue; }
        // End (\x1b[F)
        if (str.startsWith("\x1b[F", i)) { ccol = lines[crow].length; render(); i += 3; continue; }

        // CSI u (Kitty keyboard protocol) — decode \x1b[{codepoint};{modifier}u
        // Also handles single-param \x1b[{codepoint}u (unmodified key)
        // modifier bit 3 (value 4) = Ctrl, sent as bits+1 so modifier 5 = Ctrl
        if (str[i] === "\x1b" && i + 1 < str.length && str[i + 1] === "[") {
          const csiMatch = str.slice(i).match(/^\x1b\[(\d+)(?:;(\d+))?u/);
          if (csiMatch) {
            const codepoint = parseInt(csiMatch[1], 10);
            const modifier = csiMatch[2] ? parseInt(csiMatch[2], 10) : 1;
            const isCtrl = (modifier - 1) & 4;
            const seqLen = csiMatch[0].length;

            // Handle unmodified functional keys encoded as CSI u
            if (!isCtrl && modifier <= 1) {
              switch (codepoint) {
                case 9: // Tab (unmodified)
                  // Delegate to Tab handler by injecting \t
                  str = str.slice(0, i) + "\t" + str.slice(i + seqLen);
                  continue;
                case 13: // Enter (unmodified)
                  str = str.slice(0, i) + "\r" + str.slice(i + seqLen);
                  continue;
                case 27: // Escape (unmodified)
                  i += seqLen; continue;
                case 127: // Backspace (unmodified)
                  str = str.slice(0, i) + "\x7f" + str.slice(i + seqLen);
                  continue;
              }
            }

            if (isCtrl) {
              switch (codepoint) {
                case 99: // Ctrl+C
                  if (fullText() || lines.length > 1 || lines[0].length > 0) {
                    // Clear input in-place (no scrollback residue)
                    lines.length = 0; lines.push("");
                    crow = 0; ccol = 0;
                    render();
                  } else {
                    process.stdout.write("\r\n");
                    finish(null); return;
                  }
                  i += seqLen; continue;
                case 100: // Ctrl+D
                  if (fullText()) { doDelete(); } else { process.stdout.write("\n"); finish(null); return; }
                  i += seqLen; continue;
                case 97:  // Ctrl+A — home
                  ccol = 0; render(); i += seqLen; continue;
                case 101: // Ctrl+E — end
                  ccol = lines[crow].length; render(); i += seqLen; continue;
                case 117: // Ctrl+U — clear before cursor
                  lines[crow] = lines[crow].slice(ccol); ccol = 0; render(); i += seqLen; continue;
                case 107: // Ctrl+K — clear after cursor
                  lines[crow] = lines[crow].slice(0, ccol); render(); i += seqLen; continue;
                case 119: // Ctrl+W — delete word before cursor
                  { const before = lines[crow].slice(0, ccol);
                    const stripped = before.replace(/\s+$/, "");
                    const sp = stripped.lastIndexOf(" ");
                    const newBefore = sp >= 0 ? stripped.slice(0, sp + 1) : "";
                    lines[crow] = newBefore + lines[crow].slice(ccol);
                    ccol = newBefore.length; render(); }
                  i += seqLen; continue;
                case 108: // Ctrl+L — clear screen
                  process.stdout.write("\x1b[2J\x1b[H");
                  lastTermRow = 0; render();
                  i += seqLen; continue;
                case 118: // Ctrl+V — paste from clipboard
                  { const clip = pasteFromClipboard(sessionDir);
                    if (clip?.type === "text") insertText(clip.text);
                    else if (clip?.type === "image") insertText(`[📷 ${clip.path}]`);
                    render(); }
                  i += seqLen; continue;
                default: break;
              }
            }
            // Unhandled CSI u — skip it
            i += seqLen; continue;
          }

          // Skip unknown CSI sequences (non-u final byte)
          let j = i + 2;
          while (j < str.length && str.charCodeAt(j) >= 0x30 && str.charCodeAt(j) <= 0x3f) j++;
          if (j < str.length) j++; // skip final byte
          i = j; continue;
        }
        // Skip lone ESC
        if (str[i] === "\x1b") { i++; continue; }

        // Ctrl+C — clear input or exit
        if (str[i] === "\x03") {
          if (fullText() || lines.length > 1 || lines[0].length > 0) {
            // Clear input in-place (no scrollback residue)
            lines.length = 0; lines.push("");
            crow = 0; ccol = 0;
            render();
          } else {
            process.stdout.write("\r\n");
            finish(null); return;
          }
          i++; continue;
        }

        // Ctrl+D — delete char or exit on empty
        if (str[i] === "\x04") {
          if (fullText()) { doDelete(); } else { process.stdout.write("\n"); finish(null); return; }
          i++; continue;
        }

        // Ctrl+A — home
        if (str[i] === "\x01") { ccol = 0; render(); i++; continue; }
        // Ctrl+E — end
        if (str[i] === "\x05") { ccol = lines[crow].length; render(); i++; continue; }
        // Ctrl+U — clear line before cursor
        if (str[i] === "\x15") {
          lines[crow] = lines[crow].slice(ccol); ccol = 0; render(); i++; continue;
        }
        // Ctrl+K — clear line after cursor
        if (str[i] === "\x0b") {
          lines[crow] = lines[crow].slice(0, ccol); render(); i++; continue;
        }
        // Ctrl+W — delete word before cursor
        if (str[i] === "\x17") {
          const before = lines[crow].slice(0, ccol);
          const stripped = before.replace(/\s+$/, "");
          const sp = stripped.lastIndexOf(" ");
          const newBefore = sp >= 0 ? stripped.slice(0, sp + 1) : "";
          lines[crow] = newBefore + lines[crow].slice(ccol);
          ccol = newBefore.length; render(); i++; continue;
        }
        // Ctrl+L — clear screen (legacy byte)
        if (str[i] === "\x0c") {
          process.stdout.write("\x1b[2J\x1b[H");
          lastTermRow = 0; render(); i++; continue;
        }
        // Ctrl+V — paste from clipboard (legacy byte)
        if (str[i] === "\x16") {
          const clip = pasteFromClipboard(sessionDir);
          if (clip?.type === "text") insertText(clip.text);
          else if (clip?.type === "image") insertText(`[📷 ${clip.path}]`);
          render(); i++; continue;
        }

        // Ctrl+J (LF, 0x0A) — newline (cross-terminal)
        if (str[i] === "\n") { insertNewline(); i++; continue; }

        // Enter (CR, 0x0D) — submit
        if (str[i] === "\r") { submit(); return; }

        // Backspace (DEL 0x7F or BS 0x08)
        if (str[i] === "\x7f" || str[i] === "\b") { doBackspace(); i++; continue; }

        // Tab — slash command completion
        if (str[i] === "\t") {
          const currentLine = lines[crow];
          if (lines.length === 1 && currentLine.startsWith("/")) {
            const partial = currentLine.split(" ")[0]; // only match command part
            const matches = CHAT_COMMANDS.filter(c => c.cmd.startsWith(partial));
            if (matches.length === 1) {
              lines[0] = matches[0].cmd + " ";
              ccol = lines[0].length; render();
            } else if (matches.length > 1) {
              // Show matches below, then re-render prompt
              const lastRow = lines.length - 1;
              const rowsDown = lastRow - crow;
              if (rowsDown > 0) process.stdout.write(`\x1b[${rowsDown}B`);
              process.stdout.write("\r\n");
              for (const m of matches) {
                process.stdout.write(`  ${cyan(m.cmd.padEnd(14))} ${dim(m.desc)}\n`);
              }
              lastTermRow = 0; render();
            }
          }
          i++; continue;
        }

        // Regular printable character
        const code = str.charCodeAt(i);
        if (code >= 32) {
          lines[crow] = lines[crow].slice(0, ccol) + str[i] + lines[crow].slice(ccol);
          ccol++; render();
        }
        i++;
      }
    };

    const onData = (data: Buffer) => {
      let str = data.toString();

      // Bracketed paste handling
      const ps = str.indexOf("\x1b[200~");
      if (ps !== -1) {
        isPasting = true;
        const before = str.slice(0, ps);
        if (before) processKeys(before);
        str = str.slice(ps + 6);
      }
      if (isPasting) {
        const pe = str.indexOf("\x1b[201~");
        if (pe !== -1) {
          pasteBuffer += str.slice(0, pe);
          isPasting = false;
          const pasted = pasteBuffer.replace(/[\r\n]+$/, "");
          pasteBuffer = "";
          if (pasted) insertText(pasted);
          const after = str.slice(pe + 6);
          if (after) processKeys(after);
        } else {
          pasteBuffer += str;
        }
        return;
      }

      processKeys(str);
    };

    // Start listening
    process.stdin.on("data", onData);
    render();
  });
}



async function chat(explicitSession?: string): Promise<void> {
  // Enable bracketed paste + Kitty keyboard protocol
  process.stdout.write("\x1b[?2004h\x1b[>1u");

  // Use readline ONLY for session picker — then switch to custom multiline editor
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let current: SessionChoice | null = null;

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

  // Done with readline — close it before switching to raw mode
  rl.close();

  const projectName = path.basename(current.cwd);
  const banner = [
    " \u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588\u2588\u2588\u2588\u2588    \u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588    \u2588\u2588 \u2588\u2588    \u2588\u2588 \u2588\u2588\u2588\u2588\u2588    ",
    "\u2588\u2588       \u2588\u2588   \u2588\u2588  \u2588\u2588    \u2588\u2588 \u2588\u2588    \u2588\u2588 \u2588\u2588\u2588   \u2588\u2588 \u2588\u2588   \u2588\u2588  ",
    "\u2588\u2588  \u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588    \u2588\u2588 \u2588\u2588    \u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588 \u2588\u2588    \u2588\u2588 ",
    "\u2588\u2588    \u2588\u2588 \u2588\u2588  \u2588\u2588   \u2588\u2588    \u2588\u2588 \u2588\u2588    \u2588\u2588 \u2588\u2588   \u2588\u2588\u2588 \u2588\u2588   \u2588\u2588  ",
    " \u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588   \u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588    \u2588\u2588 \u2588\u2588\u2588\u2588\u2588    ",
    "         \u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588 \u2588\u2588    \u2588\u2588           ",
    "        \u2588\u2588       \u2588\u2588   \u2588\u2588  \u2588\u2588       \u2588\u2588    \u2588\u2588           ",
    "        \u2588\u2588       \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588 \u2588\u2588 \u2588\u2588           ",
    "        \u2588\u2588       \u2588\u2588  \u2588\u2588   \u2588\u2588       \u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588          ",
    "         \u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588   \u2588\u2588  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588   \u2588\u2588           ",
  ];
  const W = 56;
  const sess = `  Session ${current.id}  ${projectName}`;
  const hint = "  Type tasks to queue. / for commands.";
  const hint2 = "  Shift+Enter = newline. Ctrl+C = clear input.";
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  console.log();
  console.log(dim("  \u256d" + "\u2500".repeat(W) + "\u256e"));
  console.log(dim("  \u2502") + " ".repeat(W) + dim("\u2502"));
  for (const line of banner) {
    console.log(dim("  \u2502") + bold(cyan(pad(line, W))) + dim("\u2502"));
  }
  console.log(dim("  \u2502") + " ".repeat(W) + dim("\u2502"));
  console.log(dim("  \u251c" + "\u2500".repeat(W) + "\u2524"));
  console.log(dim("  \u2502") + pad(sess, W) + dim("\u2502"));
  console.log(dim("  \u2502") + pad(hint, W) + dim("\u2502"));
  console.log(dim("  \u2502") + dim(pad(hint2, W)) + dim("\u2502"));
  console.log(dim("  \u2502") + " ".repeat(W) + dim("\u2502"));
  console.log(dim("  \u2570" + "\u2500".repeat(W) + "\u256f"));
  console.log();

  // Enable raw mode for custom multiline editor
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const exitChat = () => {
    process.stdout.write("\x1b[?2004l\x1b[<u");
    process.stdin.setRawMode(false);
    console.log(dim("Bye."));
    process.exit(0);
  };

  // ── Main chat loop ─────────────────────────────────────────────────────────────────
  while (true) {
    // Refresh git context each turn (branch may change between prompts)
    const gitCtx = getGitContext();
    const text = await readMultilineInput(current.id, projectName, gitCtx, current.dir);

    if (text === null) exitChat();
    if (!text) continue;

    const trimmed = text.trim();

    try {
      if (trimmed === "/quit" || trimmed === "/exit") exitChat();

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
        continue;
      }

      if (trimmed.startsWith("/switch")) {
        const arg = trimmed.slice(7).trim();
        const choices = await listSessionChoices();
        if (choices.length === 0) {
          console.log(red("No active sessions."));
          continue;
        }
        const idx = parseInt(arg) - 1;
        if (idx >= 0 && idx < choices.length) {
          current = choices[idx];
          console.log(green(`Switched to ${current.id} (${path.basename(current.cwd)})`));
        } else {
          choices.forEach((s, i) => {
            const marker = s.id === current!.id ? green("*") : " ";
            console.log(`  ${marker} ${bold(String(i + 1))}. ${cyan(s.id)}  ${dim(path.basename(s.cwd))}`);
          });
        }
        continue;
      }

      if (trimmed === "/status") { await status(current.dir); continue; }
      if (trimmed === "/history") { await history(); continue; }

      if (trimmed.startsWith("/feedback ")) {
        const msg = trimmed.slice(10).trim();
        if (msg) await feedback(msg, current.dir);
        else console.log(red("Usage: /feedback <message>"));
        continue;
      }

      if (trimmed.startsWith("/priority ")) {
        const task = trimmed.slice(10).trim();
        if (task) await add(task, 9, current.dir);
        else console.log(red("Usage: /priority <task>"));
        continue;
      }

      if (trimmed === "/queue") { await listQueueCmd(current.dir); continue; }
      if (trimmed === "/clear") { await clear(current.dir); continue; }

      if (trimmed.startsWith("/")) {
        console.log(red(`Unknown command: ${trimmed.split(" ")[0]}`));
        console.log(dim("  Press Tab to see available commands"));
        continue;
      }

      // Default: queue as task
      await add(trimmed, 0, current.dir);
    } catch (err: any) {
      console.error(red(err.message));
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function usage(): void {
  console.log(`
${bold("groundcrew")} — CLI companion for the Groundcrew Copilot plugin

${bold("Usage:")}
  groundcrew chat                              Interactive chat mode (recommended)
  groundcrew chat --session <id>               Chat with a specific session
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
  groundcrew stop                              Stop all sessions for current repo
  groundcrew stop --session <id>               Stop a specific session
  groundcrew destroy                           Delete all sessions for current repo
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
  // Resolve .groundcrew/ root (git-aware for worktree + subdirectory support)
  await resolveRoot();

  const rawArgs = process.argv.slice(2);

  // Extract --session flag from anywhere in args
  const { value: explicitSession, remaining: args } = extractFlag(rawArgs, "--session");

  const command = args[0];

  // Commands that don't need a session (handle their own resolution)
  switch (command) {
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
