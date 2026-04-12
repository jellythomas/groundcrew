import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import crypto from "crypto";

const GROUNDCREW_DIR = ".groundcrew";
const SESSIONS_DIR = path.join(GROUNDCREW_DIR, "sessions");
const ACTIVE_SESSION_FILE = path.join(GROUNDCREW_DIR, "active-sessions.json");

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
  sessionId = generateSessionId();
  sessionDir = path.join(SESSIONS_DIR, sessionId);

  await fs.mkdir(sessionDir, { recursive: true });

  // Register this session in active-sessions.json
  const activeSessions = await readActiveSessions();
  activeSessions[sessionId] = {
    started: new Date().toISOString(),
    pid: process.pid,
    cwd: process.cwd(),
  };
  await fs.mkdir(GROUNDCREW_DIR, { recursive: true });
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
