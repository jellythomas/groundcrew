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
async function resolveProjectDir() {
    // Retry up to 3s waiting for the hook to write the marker file
    for (let i = 0; i < 6; i++) {
        try {
            const projectDir = readFileSync(MARKER_FILE, "utf-8").trim();
            if (projectDir && existsSync(projectDir)) {
                return projectDir;
            }
        }
        catch {
            // Not yet written
        }
        if (i < 5)
            await new Promise((r) => setTimeout(r, 500));
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
let sessionId = null;
let sessionDir = null;
/**
 * Derive a short repo slug from the project directory.
 * /Users/mekari/projects/mekari_credit → "mekari_credit"
 */
function deriveRepoName(projectDir) {
    return path.basename(projectDir).replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}
/**
 * Generate a repo-prefixed session ID.
 * e.g. "mekari_credit-a1b2c3d4"
 */
function generateSessionId() {
    const hex = crypto.randomBytes(4).toString("hex");
    return `${repoName}-${hex}`;
}
/**
 * Resolve paths on MCP server startup.
 * Does NOT create a session — that happens when `start` is called.
 */
export async function initPaths() {
    PROJECT_DIR = await resolveProjectDir();
    repoName = deriveRepoName(PROJECT_DIR);
    // Ensure centralized dirs exist
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
}
/**
 * Create a new session. Called when the `start` tool is invoked.
 * Creates ~/.groundcrew/sessions/<repo>-<hex>/ and registers in active-sessions.json.
 */
export async function createSession() {
    if (sessionId)
        return sessionId; // already created, reuse
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
 * Remove this session from active-sessions.json. Called on shutdown.
 */
export async function cleanupSession() {
    if (!sessionId)
        return;
    try {
        const activeSessions = await readActiveSessions();
        delete activeSessions[sessionId];
        await fs.writeFile(ACTIVE_SESSION_FILE, JSON.stringify(activeSessions, null, 2));
    }
    catch {
        // Best effort
    }
}
export function getSessionId() {
    if (!sessionId)
        throw new Error("No active session. Call the 'start' tool first to create a session.");
    return sessionId;
}
export function getSessionDir() {
    if (!sessionDir)
        throw new Error("No active session. Call the 'start' tool first to create a session.");
    return sessionDir;
}
export function getQueueFile() {
    return path.join(getSessionDir(), "queue.json");
}
export function getFeedbackFile() {
    return path.join(getSessionDir(), "feedback.md");
}
export function getSessionFile() {
    return path.join(getSessionDir(), "session.json");
}
export function getStatusFile() {
    return path.join(getSessionDir(), "status.json");
}
export function getGroundcrewDir() {
    return GROUNDCREW_HOME;
}
export function getHistoryFile() {
    return HISTORY_FILE;
}
export function getActiveSessionsFile() {
    return ACTIVE_SESSION_FILE;
}
export function getRepoName() {
    return repoName;
}
export function getProjectDir() {
    return PROJECT_DIR;
}
export async function readActiveSessions() {
    try {
        const raw = await fs.readFile(ACTIVE_SESSION_FILE, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
