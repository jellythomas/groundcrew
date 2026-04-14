import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import crypto from "crypto";
import os from "os";

// Per-session marker file keyed by parent PID (the Copilot CLI process).
// Both the sessionStart hook ($PPID in bash) and this MCP server (process.ppid in Node)
// share the same parent PID, so each session gets its own isolated file — no cross-session
// overwrites when multiple repos are open at the same time.
const MARKER_FILE = path.join(os.homedir(), ".groundcrew", `project-${process.ppid}`);

// Legacy global marker kept for fallback / old installations.
const MARKER_FILE_LEGACY = path.join(os.homedir(), ".groundcrew-active-project");

/**
 * Resolve the project directory.
 * The sessionStart hook writes the project CWD to ~/.groundcrew/project-<PPID>.
 * MCP server CWD is the plugin install dir, not the project dir.
 *
 * Retries briefly on startup because the hook and MCP server start in parallel.
 * Falls back to the legacy global marker if the per-session file is absent.
 */
async function resolveProjectDir(): Promise<string> {
  // Retry up to 3s waiting for the hook to write the per-session marker file
  for (let i = 0; i < 6; i++) {
    // 1. Try per-session file first (correct, isolated)
    try {
      const projectDir = readFileSync(MARKER_FILE, "utf-8").trim();
      if (projectDir && existsSync(projectDir)) {
        return projectDir;
      }
    } catch { /* not yet written */ }

    // 2. Fall back to legacy global file (old hook versions)
    try {
      const projectDir = readFileSync(MARKER_FILE_LEGACY, "utf-8").trim();
      if (projectDir && existsSync(projectDir)) {
        return projectDir;
      }
    } catch { /* not yet written */ }

    if (i < 5) await new Promise((r) => setTimeout(r, 500));
  }
  return process.cwd();
}

// ── Centralized storage at ~/.groundcrew ─────────────────────────────────────

const GROUNDCREW_HOME = path.join(os.homedir(), ".groundcrew");
const SESSIONS_DIR = path.join(GROUNDCREW_HOME, "sessions");
const ACTIVE_SESSION_FILE = path.join(GROUNDCREW_HOME, "active-sessions.json");
const HISTORY_FILE = path.join(GROUNDCREW_HOME, "history.json");

let PROJECT_DIR = "";
let repoName = "";

let sessionId: string | null = null;
let sessionDir: string | null = null;

/**
 * Derive a short repo slug from the main repo root.
 * Uses git --git-common-dir to resolve through worktrees to the main repo.
 * /Users/mekari/projects/mekari_credit/.worktrees/worktree-mc-9292 → "mekari_credit"
 * /Users/mekari/projects/mekari_credit → "mekari_credit"
 */
function deriveRepoName(projectDir: string): string {
  try {
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: projectDir, encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // gitCommonDir is either ".git" (main repo) or absolute path like "/path/to/repo/.git"
    const absGitDir = path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(projectDir, gitCommonDir);
    return path.basename(path.dirname(absGitDir)).replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  } catch {
    return path.basename(projectDir).replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  }
}

/**
 * Generate a repo-prefixed session ID.
 * e.g. "mekari_credit-a1b2c3d4"
 */
function generateSessionId(): string {
  const hex = crypto.randomBytes(4).toString("hex");
  return `${repoName}-${hex}`;
}

/**
 * Resolve paths on MCP server startup.
 * Does NOT create a session — that happens when `start` is called.
 */
export async function initPaths(): Promise<void> {
  PROJECT_DIR = await resolveProjectDir();
  repoName = deriveRepoName(PROJECT_DIR);

  // Ensure centralized dirs exist
  await fs.mkdir(SESSIONS_DIR, { recursive: true });

  // Prune stale per-session project markers whose parent process is no longer running
  try {
    const files = await fs.readdir(GROUNDCREW_HOME);
    for (const f of files) {
      if (!f.startsWith("project-")) continue;
      const pid = parseInt(f.slice("project-".length), 10);
      if (isNaN(pid) || pid === process.ppid) continue; // keep our own
      try { process.kill(pid, 0); } catch {
        // Process gone — remove the stale marker
        await fs.unlink(path.join(GROUNDCREW_HOME, f)).catch(() => {});
      }
    }
  } catch { /* best effort */ }
}

/**
 * Create a new session. Called when the `start` tool is invoked.
 * Creates ~/.groundcrew/sessions/<repo>-<hex>/ and registers in active-sessions.json.
 */
export async function createSession(): Promise<string> {
  if (sessionId) return sessionId; // already created, reuse

  sessionId = generateSessionId();
  sessionDir = path.join(SESSIONS_DIR, sessionId);

  await fs.mkdir(sessionDir, { recursive: true });

  // Register this session in active-sessions.json
  const activeSessions = await readActiveSessions();
  activeSessions[sessionId] = {
    started: new Date().toISOString(),
    pid: process.pid,
    cwd: PROJECT_DIR,
    repo: repoName,
  };
  await fs.writeFile(ACTIVE_SESSION_FILE, JSON.stringify(activeSessions, null, 2));

  return sessionId;
}

/**
 * Remove this session from active-sessions.json and clean up the per-session
 * project marker file. Called on shutdown.
 */
export async function cleanupSession(): Promise<void> {
  if (!sessionId) return;
  try {
    const activeSessions = await readActiveSessions();
    delete activeSessions[sessionId];
    await fs.writeFile(ACTIVE_SESSION_FILE, JSON.stringify(activeSessions, null, 2));
  } catch {
    // Best effort
  }
  // Remove the per-session project marker for our parent PID
  try { await fs.unlink(MARKER_FILE); } catch { /* already gone */ }
}

export function getSessionId(): string {
  if (!sessionId) throw new Error("No active session. Call the 'start' tool first to create a session.");
  return sessionId;
}

export function getSessionDir(): string {
  if (!sessionDir) throw new Error("No active session. Call the 'start' tool first to create a session.");
  return sessionDir;
}

export function getQueueFile(): string {
  return path.join(getSessionDir(), "queue.json");
}

export function getFeedbackFile(): string {
  return path.join(getSessionDir(), "feedback.md");
}

export function getSessionFile(): string {
  return path.join(getSessionDir(), "session.json");
}

export function getStatusFile(): string {
  return path.join(getSessionDir(), "status.json");
}

export function getGroundcrewDir(): string {
  return GROUNDCREW_HOME;
}

export function getHistoryFile(): string {
  return HISTORY_FILE;
}

export function getActiveSessionsFile(): string {
  return ACTIVE_SESSION_FILE;
}

export function getRepoName(): string {
  return repoName;
}

export function getProjectDir(): string {
  return PROJECT_DIR;
}

export interface ActiveSessionEntry {
  started: string;
  pid: number;
  cwd: string;
  repo: string;
}

export async function readActiveSessions(): Promise<Record<string, ActiveSessionEntry>> {
  try {
    const raw = await fs.readFile(ACTIVE_SESSION_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
