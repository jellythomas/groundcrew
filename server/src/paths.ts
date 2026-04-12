import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

const MARKER_FILE = path.join(os.homedir(), ".groundcrew-active-project");

/**
 * Resolve the project directory.
 * The sessionStart hook writes the project CWD to ~/.groundcrew-active-project.
 * MCP server CWD is the plugin install dir, not the project dir.
 *
 * Retries briefly on startup because the hook and MCP server start in parallel.
 */
async function resolveProjectDir(): Promise<string> {
  // Retry up to 3s waiting for the hook to write the marker file
  for (let i = 0; i < 6; i++) {
    try {
      const projectDir = readFileSync(MARKER_FILE, "utf-8").trim();
      if (projectDir && existsSync(projectDir)) {
        return projectDir;
      }
    } catch {
      // Not yet written
    }
    if (i < 5) await new Promise((r) => setTimeout(r, 500));
  }
  return process.cwd();
}

// Resolved lazily in initSession()
let PROJECT_DIR = "";
let GROUNDCREW_DIR = "";
let SESSIONS_DIR = "";
let ACTIVE_SESSION_FILE = "";

let sessionId: string | null = null;
let sessionDir: string | null = null;

/**
 * Generate a short unique session ID.
 */
function generateSessionId(): string {
  return crypto.randomBytes(4).toString("hex"); // e.g. "a1b2c3d4"
}

/**
 * Initialize a new session. Called once on MCP server startup.
 * Creates .groundcrew/sessions/<id>/ and registers in active-sessions.json.
 */
export async function initSession(): Promise<string> {
  // Resolve project dir (waits for hook to write marker file)
  PROJECT_DIR = await resolveProjectDir();
  GROUNDCREW_DIR = path.join(PROJECT_DIR, ".groundcrew");
  SESSIONS_DIR = path.join(GROUNDCREW_DIR, "sessions");
  ACTIVE_SESSION_FILE = path.join(GROUNDCREW_DIR, "active-sessions.json");

  sessionId = generateSessionId();
  sessionDir = path.join(SESSIONS_DIR, sessionId);

  await fs.mkdir(sessionDir, { recursive: true });

  // Register this session in active-sessions.json
  const activeSessions = await readActiveSessions();
  activeSessions[sessionId] = {
    started: new Date().toISOString(),
    pid: process.pid,
    cwd: PROJECT_DIR,
  };
  await fs.writeFile(ACTIVE_SESSION_FILE, JSON.stringify(activeSessions, null, 2));

  return sessionId;
}

/**
 * Remove this session from active-sessions.json. Called on shutdown.
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
}

export function getSessionId(): string {
  if (!sessionId) throw new Error("Session not initialized. Call initSession() first.");
  return sessionId;
}

export function getSessionDir(): string {
  if (!sessionDir) throw new Error("Session not initialized. Call initSession() first.");
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
  return GROUNDCREW_DIR;
}

export function getActiveSessionsFile(): string {
  return ACTIVE_SESSION_FILE;
}

interface ActiveSessionEntry {
  started: string;
  pid: number;
  cwd: string;
}

export async function readActiveSessions(): Promise<Record<string, ActiveSessionEntry>> {
  try {
    const raw = await fs.readFile(ACTIVE_SESSION_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
