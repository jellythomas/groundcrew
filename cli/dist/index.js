#!/usr/bin/env node
import{createRequire}from'module';const require=createRequire(import.meta.url);
// src/index.ts
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
function getGitContext() {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    let dirty = "";
    try {
      const status2 = execFileSync("git", ["status", "--porcelain", "-uno"], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["pipe", "pipe", "pipe"]
      }).trim();
      if (status2) {
        const hasStaged = status2.split("\n").some((l) => l[0] !== " " && l[0] !== "?");
        const hasUnstaged = status2.split("\n").some((l) => l[1] === "M" || l[1] === "D");
        if (hasStaged) dirty += "+";
        if (hasUnstaged) dirty += "*";
      }
      const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["pipe", "pipe", "pipe"]
      }).trim();
      if (untracked) dirty += "%";
    } catch {
    }
    return { branch, dirty };
  } catch {
    return null;
  }
}
function pasteFromClipboard(sessionDir) {
  try {
    const text = execFileSync("pbpaste", [], { encoding: "utf8", timeout: 1e3, stdio: ["pipe", "pipe", "pipe"] }).replace(/\r\n/g, "\n");
    if (text) return { type: "text", text };
  } catch {
  }
  if (process.platform !== "darwin") return null;
  try {
    const check = execFileSync("osascript", [
      "-e",
      'try\nthe clipboard as \xABclass PNGf\xBB\nreturn "image"\non error\nreturn "none"\nend try'
    ], { encoding: "utf8", timeout: 2e3, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (check !== "image") return null;
    const attachDir = path.join(sessionDir, "attachments");
    try {
      execFileSync("mkdir", ["-p", attachDir]);
    } catch {
    }
    const fname = `clipboard-${Date.now()}.png`;
    const fpath = path.join(attachDir, fname);
    execFileSync("osascript", ["-e", `
set theFile to POSIX file "${fpath}"
set imageData to the clipboard as \xABclass PNGf\xBB
set fp to open for access theFile with write permission
set eof fp to 0
write imageData to fp
close access fp`], { timeout: 3e3, stdio: ["pipe", "pipe", "pipe"] });
    return { type: "image", path: fpath };
  } catch {
    return null;
  }
}
var GROUNDCREW_HOME = path.join(os.homedir(), ".groundcrew");
var SESSIONS_DIR = path.join(GROUNDCREW_HOME, "sessions");
var ACTIVE_SESSIONS_FILE = path.join(GROUNDCREW_HOME, "active-sessions.json");
var HISTORY_FILE = path.join(GROUNDCREW_HOME, "history.json");
var REPO_NAME = "";
async function resolveRoot() {
  let root = null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    root = stdout.trim() || null;
  } catch {
  }
  if (!root) root = process.cwd();
  REPO_NAME = path.basename(root).replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}
async function readActiveSessions() {
  try {
    return JSON.parse(await fs.readFile(ACTIVE_SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function isRepoSession(sessionId) {
  return sessionId.startsWith(REPO_NAME + "-");
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
  const ids = Object.keys(sessions2).filter(isRepoSession);
  if (ids.length === 0) {
    try {
      const dirs = (await fs.readdir(SESSIONS_DIR)).filter(isRepoSession);
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
    throw new Error(`No active sessions for repo "${REPO_NAME}". Start Copilot with groundcrew first.`);
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
  const byRepo = /* @__PURE__ */ new Map();
  for (const dir of allDirs) {
    const dashIdx = dir.lastIndexOf("-");
    const repo = dashIdx > 0 ? dir.substring(0, dashIdx) : "unknown";
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(dir);
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
        const minutes = Math.round((Date.now() - startTime) / 6e4);
        const statusColor = session.status === "active" ? green : session.status === "parked" ? yellow : dim;
        info = `${statusColor(session.status)} | ${minutes}min | ${session.tasksCompleted || 0} tasks done`;
      } catch {
        info = dim("no session data");
      }
      const queue = await readQueue(sessionDir);
      const marker = isActive ? green("*") : " ";
      const shortId = dir.substring(repo.length + 1);
      console.log(`    ${marker} ${cyan(shortId)}  ${info} | ${queue.tasks.length} queued`);
    }
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
  const ids = Object.keys(active).filter(isRepoSession);
  let allDirs = [];
  try {
    allDirs = (await fs.readdir(SESSIONS_DIR)).filter(isRepoSession);
  } catch {
  }
  if (ids.length === 0 && allDirs.length === 0) {
    console.log(dim(`No sessions to stop for repo "${REPO_NAME}".`));
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
  const remaining = await readActiveSessions();
  for (const id of ids) delete remaining[id];
  await fs.writeFile(ACTIVE_SESSIONS_FILE, JSON.stringify(remaining, null, 2));
  console.log(green(`
All ${REPO_NAME} sessions stopped.`));
}
async function destroyAll() {
  await stopAll();
  try {
    const dirs = (await fs.readdir(SESSIONS_DIR)).filter(isRepoSession);
    for (const dir of dirs) {
      await fs.rm(path.join(SESSIONS_DIR, dir), { recursive: true, force: true });
    }
  } catch {
  }
  try {
    await fs.unlink(path.join(GROUNDCREW_HOME, "tool-history.csv"));
  } catch {
  }
  console.log(green(`All ${REPO_NAME} session data deleted.`));
}
async function listSessionChoices() {
  const active = await readActiveSessions();
  const choices = [];
  for (const [id, entry] of Object.entries(active)) {
    if (!isRepoSession(id)) continue;
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
var CHAT_COMMANDS = [
  { cmd: "/feedback", desc: "Send feedback to the agent mid-task" },
  { cmd: "/priority", desc: "Queue an urgent task (processed first)" },
  { cmd: "/switch", desc: "Switch to another active session" },
  { cmd: "/sessions", desc: "List all active sessions" },
  { cmd: "/status", desc: "Show current session status" },
  { cmd: "/history", desc: "Show completed tasks" },
  { cmd: "/queue", desc: "Show pending tasks" },
  { cmd: "/clear", desc: "Clear pending tasks" },
  { cmd: "/exit", desc: "Exit chat" }
];
function readMultilineInput(sessionId, projectName, gitCtx, sessionDir) {
  return new Promise((resolve) => {
    const lines = [""];
    let crow = 0;
    let ccol = 0;
    const padWidth = sessionId.length + 5;
    const linePad = (i) => i === 0 ? padWidth : 0;
    let lastTermRow = 0;
    let pasteBuffer = "";
    let isPasting = false;
    const fullText = () => lines.join("\n").trim();
    const render = () => {
      const buf = [];
      if (lastTermRow > 0) buf.push(`\x1B[${lastTermRow}A`);
      buf.push("\r\x1B[J");
      const termW = process.stdout.columns || 80;
      let info = ` ${sessionId} `;
      const ctxParts = [];
      if (projectName) ctxParts.push(projectName);
      if (gitCtx) {
        ctxParts.push(`git:(${gitCtx.branch}${gitCtx.dirty})`);
      }
      if (ctxParts.length) info += ` ${ctxParts.join(" ")} `;
      const dashRight = "\u2500".repeat(Math.max(0, termW - 4 - info.length));
      buf.push(dim("\u2500\u2500\u2500" + info + dashRight));
      for (let i = 0; i < lines.length; i++) {
        buf.push("\n");
        if (i === 0) {
          buf.push(dim(`[${sessionId}]`) + " " + bold(">") + " " + lines[i]);
        } else {
          buf.push(lines[i]);
        }
      }
      let suggestionRows = 0;
      if (lines.length === 1 && lines[0].startsWith("/") && !lines[0].includes(" ")) {
        const partial = lines[0];
        const matches = CHAT_COMMANDS.filter((c) => c.cmd.startsWith(partial));
        if (matches.length > 0 && partial.length >= 1) {
          for (const m of matches) {
            buf.push(`
  ${cyan(m.cmd.padEnd(14))} ${dim(m.desc)}`);
            suggestionRows++;
          }
        }
      }
      const lastRow = lines.length - 1;
      const termRowsForLine = (i) => {
        const lineLen = linePad(i) + lines[i].length;
        return lineLen === 0 ? 1 : Math.max(1, Math.ceil(lineLen / termW));
      };
      let rowsBelowCursor = suggestionRows;
      for (let i = lastRow; i > crow; i--) rowsBelowCursor += termRowsForLine(i);
      const cursorLineTermRows = termRowsForLine(crow);
      const cursorPad = linePad(crow);
      const cursorRowWithinLine = Math.floor((cursorPad + ccol) / termW);
      rowsBelowCursor += cursorLineTermRows - 1 - cursorRowWithinLine;
      if (rowsBelowCursor > 0) buf.push(`\x1B[${rowsBelowCursor}A`);
      buf.push("\r");
      const col = (cursorPad + ccol) % termW;
      if (col > 0) buf.push(`\x1B[${col}C`);
      let rowsAbove = 1;
      for (let i = 0; i < crow; i++) rowsAbove += termRowsForLine(i);
      rowsAbove += cursorRowWithinLine;
      lastTermRow = rowsAbove;
      process.stdout.write(buf.join(""));
    };
    const finish = (result) => {
      process.stdin.removeListener("data", onData);
      resolve(result);
    };
    const submit = () => {
      const text = fullText();
      const buf = [];
      if (lastTermRow > 0) buf.push(`\x1B[${lastTermRow}A`);
      buf.push("\r\x1B[J");
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
    const insertText = (text) => {
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
    const processKeys = (str) => {
      let i = 0;
      while (i < str.length) {
        if (str.startsWith("\x1B[13;2u", i)) {
          insertNewline();
          i += 7;
          continue;
        }
        if (i + 1 < str.length && str[i] === "\x1B" && (str[i + 1] === "\r" || str[i + 1] === "\n")) {
          insertNewline();
          i += 2;
          continue;
        }
        if (str.startsWith("\x1B[A", i)) {
          if (crow > 0) {
            crow--;
            ccol = Math.min(ccol, lines[crow].length);
            render();
          }
          i += 3;
          continue;
        }
        if (str.startsWith("\x1B[B", i)) {
          if (crow < lines.length - 1) {
            crow++;
            ccol = Math.min(ccol, lines[crow].length);
            render();
          }
          i += 3;
          continue;
        }
        if (str.startsWith("\x1B[C", i)) {
          if (ccol < lines[crow].length) ccol++;
          else if (crow < lines.length - 1) {
            crow++;
            ccol = 0;
          }
          render();
          i += 3;
          continue;
        }
        if (str.startsWith("\x1B[D", i)) {
          if (ccol > 0) ccol--;
          else if (crow > 0) {
            crow--;
            ccol = lines[crow].length;
          }
          render();
          i += 3;
          continue;
        }
        if (str.startsWith("\x1B[3~", i)) {
          doDelete();
          i += 4;
          continue;
        }
        if (str.startsWith("\x1B[H", i)) {
          ccol = 0;
          render();
          i += 3;
          continue;
        }
        if (str.startsWith("\x1B[F", i)) {
          ccol = lines[crow].length;
          render();
          i += 3;
          continue;
        }
        if (str[i] === "\x1B" && i + 1 < str.length && str[i + 1] === "[") {
          const csiMatch = str.slice(i).match(/^\x1b\[(\d+)(?:;(\d+))?u/);
          if (csiMatch) {
            const codepoint = parseInt(csiMatch[1], 10);
            const modifier = csiMatch[2] ? parseInt(csiMatch[2], 10) : 1;
            const isCtrl = modifier - 1 & 4;
            const seqLen = csiMatch[0].length;
            if (!isCtrl && modifier <= 1) {
              switch (codepoint) {
                case 9:
                  str = str.slice(0, i) + "	" + str.slice(i + seqLen);
                  continue;
                case 13:
                  str = str.slice(0, i) + "\r" + str.slice(i + seqLen);
                  continue;
                case 27:
                  i += seqLen;
                  continue;
                case 127:
                  str = str.slice(0, i) + "\x7F" + str.slice(i + seqLen);
                  continue;
              }
            }
            if (isCtrl) {
              switch (codepoint) {
                case 99:
                  if (fullText() || lines.length > 1 || lines[0].length > 0) {
                    lines.length = 0;
                    lines.push("");
                    crow = 0;
                    ccol = 0;
                    render();
                  } else {
                    process.stdout.write("\r\n");
                    finish(null);
                    return;
                  }
                  i += seqLen;
                  continue;
                case 100:
                  if (fullText()) {
                    doDelete();
                  } else {
                    process.stdout.write("\n");
                    finish(null);
                    return;
                  }
                  i += seqLen;
                  continue;
                case 97:
                  ccol = 0;
                  render();
                  i += seqLen;
                  continue;
                case 101:
                  ccol = lines[crow].length;
                  render();
                  i += seqLen;
                  continue;
                case 117:
                  lines[crow] = lines[crow].slice(ccol);
                  ccol = 0;
                  render();
                  i += seqLen;
                  continue;
                case 107:
                  lines[crow] = lines[crow].slice(0, ccol);
                  render();
                  i += seqLen;
                  continue;
                case 119:
                  {
                    const before = lines[crow].slice(0, ccol);
                    const stripped = before.replace(/\s+$/, "");
                    const sp = stripped.lastIndexOf(" ");
                    const newBefore = sp >= 0 ? stripped.slice(0, sp + 1) : "";
                    lines[crow] = newBefore + lines[crow].slice(ccol);
                    ccol = newBefore.length;
                    render();
                  }
                  i += seqLen;
                  continue;
                case 108:
                  process.stdout.write("\x1B[2J\x1B[H");
                  lastTermRow = 0;
                  render();
                  i += seqLen;
                  continue;
                case 118:
                  {
                    const clip = pasteFromClipboard(sessionDir);
                    if (clip?.type === "text") insertText(clip.text);
                    else if (clip?.type === "image") insertText(`[\u{1F4F7} ${clip.path}]`);
                    render();
                  }
                  i += seqLen;
                  continue;
                default:
                  break;
              }
            }
            i += seqLen;
            continue;
          }
          let j = i + 2;
          while (j < str.length && str.charCodeAt(j) >= 48 && str.charCodeAt(j) <= 63) j++;
          if (j < str.length) j++;
          i = j;
          continue;
        }
        if (str[i] === "\x1B") {
          i++;
          continue;
        }
        if (str[i] === "") {
          if (fullText() || lines.length > 1 || lines[0].length > 0) {
            lines.length = 0;
            lines.push("");
            crow = 0;
            ccol = 0;
            render();
          } else {
            process.stdout.write("\r\n");
            finish(null);
            return;
          }
          i++;
          continue;
        }
        if (str[i] === "") {
          if (fullText()) {
            doDelete();
          } else {
            process.stdout.write("\n");
            finish(null);
            return;
          }
          i++;
          continue;
        }
        if (str[i] === "") {
          ccol = 0;
          render();
          i++;
          continue;
        }
        if (str[i] === "") {
          ccol = lines[crow].length;
          render();
          i++;
          continue;
        }
        if (str[i] === "") {
          lines[crow] = lines[crow].slice(ccol);
          ccol = 0;
          render();
          i++;
          continue;
        }
        if (str[i] === "\v") {
          lines[crow] = lines[crow].slice(0, ccol);
          render();
          i++;
          continue;
        }
        if (str[i] === "") {
          const before = lines[crow].slice(0, ccol);
          const stripped = before.replace(/\s+$/, "");
          const sp = stripped.lastIndexOf(" ");
          const newBefore = sp >= 0 ? stripped.slice(0, sp + 1) : "";
          lines[crow] = newBefore + lines[crow].slice(ccol);
          ccol = newBefore.length;
          render();
          i++;
          continue;
        }
        if (str[i] === "\f") {
          process.stdout.write("\x1B[2J\x1B[H");
          lastTermRow = 0;
          render();
          i++;
          continue;
        }
        if (str[i] === "") {
          const clip = pasteFromClipboard(sessionDir);
          if (clip?.type === "text") insertText(clip.text);
          else if (clip?.type === "image") insertText(`[\u{1F4F7} ${clip.path}]`);
          render();
          i++;
          continue;
        }
        if (str[i] === "\n") {
          insertNewline();
          i++;
          continue;
        }
        if (str[i] === "\r") {
          submit();
          return;
        }
        if (str[i] === "\x7F" || str[i] === "\b") {
          doBackspace();
          i++;
          continue;
        }
        if (str[i] === "	") {
          const currentLine = lines[crow];
          if (lines.length === 1 && currentLine.startsWith("/")) {
            const partial = currentLine.split(" ")[0];
            const matches = CHAT_COMMANDS.filter((c) => c.cmd.startsWith(partial));
            if (matches.length === 1) {
              lines[0] = matches[0].cmd + " ";
              ccol = lines[0].length;
              render();
            } else if (matches.length > 1) {
              const lastRow = lines.length - 1;
              const rowsDown = lastRow - crow;
              if (rowsDown > 0) process.stdout.write(`\x1B[${rowsDown}B`);
              process.stdout.write("\r\n");
              for (const m of matches) {
                process.stdout.write(`  ${cyan(m.cmd.padEnd(14))} ${dim(m.desc)}
`);
              }
              lastTermRow = 0;
              render();
            }
          }
          i++;
          continue;
        }
        const code = str.charCodeAt(i);
        if (code >= 32) {
          lines[crow] = lines[crow].slice(0, ccol) + str[i] + lines[crow].slice(ccol);
          ccol++;
          render();
        }
        i++;
      }
    };
    const onData = (data) => {
      let str = data.toString();
      const ps = str.indexOf("\x1B[200~");
      if (ps !== -1) {
        isPasting = true;
        const before = str.slice(0, ps);
        if (before) processKeys(before);
        str = str.slice(ps + 6);
      }
      if (isPasting) {
        const pe = str.indexOf("\x1B[201~");
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
    process.stdin.on("data", onData);
    render();
  });
}
async function chat(explicitSession) {
  process.stdout.write("\x1B[?2004h\x1B[>1u");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
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
    "         \u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588   \u2588\u2588  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588   \u2588\u2588           "
  ];
  const W = 56;
  const sess = `  Session ${current.id}  ${projectName}`;
  const hint = "  Type tasks to queue. / for commands.";
  const hint2 = "  Shift+Enter = newline. Ctrl+C = clear input.";
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - s.length));
  console.log();
  console.log(dim("  \u256D" + "\u2500".repeat(W) + "\u256E"));
  console.log(dim("  \u2502") + " ".repeat(W) + dim("\u2502"));
  for (const line of banner) {
    console.log(dim("  \u2502") + bold(cyan(pad(line, W))) + dim("\u2502"));
  }
  console.log(dim("  \u2502") + " ".repeat(W) + dim("\u2502"));
  console.log(dim("  \u251C" + "\u2500".repeat(W) + "\u2524"));
  console.log(dim("  \u2502") + pad(sess, W) + dim("\u2502"));
  console.log(dim("  \u2502") + pad(hint, W) + dim("\u2502"));
  console.log(dim("  \u2502") + dim(pad(hint2, W)) + dim("\u2502"));
  console.log(dim("  \u2502") + " ".repeat(W) + dim("\u2502"));
  console.log(dim("  \u2570" + "\u2500".repeat(W) + "\u256F"));
  console.log();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const exitChat = () => {
    process.stdout.write("\x1B[?2004l\x1B[<u");
    process.stdin.setRawMode(false);
    console.log(dim("Bye."));
    process.exit(0);
  };
  while (true) {
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
            const marker = s.id === current.id ? green("*") : " ";
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
            const marker = s.id === current.id ? green("*") : " ";
            console.log(`  ${marker} ${bold(String(i + 1))}. ${cyan(s.id)}  ${dim(path.basename(s.cwd))}`);
          });
        }
        continue;
      }
      if (trimmed === "/status") {
        await status(current.dir);
        continue;
      }
      if (trimmed === "/history") {
        await history();
        continue;
      }
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
      if (trimmed === "/queue") {
        await listQueueCmd(current.dir);
        continue;
      }
      if (trimmed === "/clear") {
        await clear(current.dir);
        continue;
      }
      if (trimmed.startsWith("/")) {
        console.log(red(`Unknown command: ${trimmed.split(" ")[0]}`));
        console.log(dim("  Press Tab to see available commands"));
        continue;
      }
      await add(trimmed, 0, current.dir);
    } catch (err) {
      console.error(red(err.message));
    }
  }
}
function usage() {
  console.log(`
${bold("groundcrew")} \u2014 CLI companion for the Groundcrew Copilot plugin

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
function extractFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return { value: void 0, remaining: args };
  const value = args[idx + 1];
  const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { value, remaining };
}
async function main() {
  await resolveRoot();
  const rawArgs = process.argv.slice(2);
  const { value: explicitSession, remaining: args } = extractFlag(rawArgs, "--session");
  const command = args[0];
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
