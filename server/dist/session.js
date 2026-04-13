import fs from "fs/promises";
import { getSessionDir, getSessionFile, getStatusFile } from "./paths.js";
export async function readSession() {
    try {
        const raw = await fs.readFile(getSessionFile(), "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return {
            sessionId: "",
            started: new Date().toISOString(),
            tasksCompleted: 0,
            status: "active",
        };
    }
}
export async function updateSession(updates) {
    await fs.mkdir(getSessionDir(), { recursive: true });
    const session = await readSession();
    Object.assign(session, updates, { lastActivity: new Date().toISOString() });
    // Calculate active minutes
    const startTime = new Date(session.started).getTime();
    session.activeMinutes = Math.round((Date.now() - startTime) / (1000 * 60));
    await fs.writeFile(getSessionFile(), JSON.stringify(session, null, 2));
    return session;
}
export async function reportStatus(taskId, message, progress) {
    await fs.mkdir(getSessionDir(), { recursive: true });
    const report = {
        taskId,
        message,
        timestamp: new Date().toISOString(),
        progress,
    };
    // Append to status log
    let reports = [];
    try {
        const raw = await fs.readFile(getStatusFile(), "utf-8");
        reports = JSON.parse(raw);
    }
    catch {
        // Fresh file
    }
    reports.push(report);
    await fs.writeFile(getStatusFile(), JSON.stringify(reports, null, 2));
    // Update session
    const session = await updateSession({ currentTask: taskId });
    // Check session health
    let warning;
    if (session.activeMinutes && session.activeMinutes >= 120) {
        warning =
            "Session has been active for 2+ hours. Quality may degrade. Consider starting a fresh session.";
    }
    else if (session.activeMinutes && session.activeMinutes >= 90) {
        warning =
            "Session approaching 90 minutes. Consider creating a checkpoint soon.";
    }
    return { session, warning };
}
export async function incrementCompleted() {
    const session = await readSession();
    await updateSession({ tasksCompleted: session.tasksCompleted + 1 });
}
export async function parkSession() {
    await updateSession({ status: "parked", currentTask: undefined });
}
export async function endSession() {
    await updateSession({ status: "ended", currentTask: undefined });
}
export async function getStatus() {
    const session = await readSession();
    let reports = [];
    try {
        const raw = await fs.readFile(getStatusFile(), "utf-8");
        reports = JSON.parse(raw);
    }
    catch {
        // No reports yet
    }
    return { session, reports };
}
