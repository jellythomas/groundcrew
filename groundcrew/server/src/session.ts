import fs from "fs/promises";
import { getSessionDir, getSessionFile, getStatusFile } from "./paths.js";

export interface SessionData {
  sessionId: string;
  started: string;
  tasksCompleted: number;
  status: "active" | "parked" | "ended";
  currentTask?: string;
  lastActivity?: string;
  activeMinutes?: number;
}

export interface StatusReport {
  taskId: string;
  message: string;
  timestamp: string;
  progress?: string;
}

export async function readSession(): Promise<SessionData> {
  try {
    const raw = await fs.readFile(getSessionFile(), "utf-8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return {
      sessionId: "",
      started: new Date().toISOString(),
      tasksCompleted: 0,
      status: "active",
    };
  }
}

export async function updateSession(
  updates: Partial<SessionData>
): Promise<SessionData> {
  await fs.mkdir(getSessionDir(), { recursive: true });
  const session = await readSession();
  Object.assign(session, updates, { lastActivity: new Date().toISOString() });

  // Calculate active minutes
  const startTime = new Date(session.started).getTime();
  session.activeMinutes = Math.round(
    (Date.now() - startTime) / (1000 * 60)
  );

  await fs.writeFile(getSessionFile(), JSON.stringify(session, null, 2));
  return session;
}

export async function reportStatus(
  taskId: string,
  message: string,
  progress?: string
): Promise<{ session: SessionData; warning?: string }> {
  await fs.mkdir(getSessionDir(), { recursive: true });

  const report: StatusReport = {
    taskId,
    message,
    timestamp: new Date().toISOString(),
    progress,
  };

  // Append to status log
  let reports: StatusReport[] = [];
  try {
    const raw = await fs.readFile(getStatusFile(), "utf-8");
    reports = JSON.parse(raw);
  } catch {
    // Fresh file
  }
  reports.push(report);
  await fs.writeFile(getStatusFile(), JSON.stringify(reports, null, 2));

  // Update session
  const session = await updateSession({ currentTask: taskId });

  // Check session health
  let warning: string | undefined;
  if (session.activeMinutes && session.activeMinutes >= 120) {
    warning =
      "Session has been active for 2+ hours. Quality may degrade. Consider starting a fresh session.";
  } else if (session.activeMinutes && session.activeMinutes >= 90) {
    warning =
      "Session approaching 90 minutes. Consider creating a checkpoint soon.";
  }

  return { session, warning };
}

export async function incrementCompleted(): Promise<void> {
  const session = await readSession();
  await updateSession({ tasksCompleted: session.tasksCompleted + 1 });
}

export async function parkSession(): Promise<void> {
  await updateSession({ status: "parked", currentTask: undefined });
}

export async function getStatus(): Promise<{
  session: SessionData;
  reports: StatusReport[];
}> {
  const session = await readSession();
  let reports: StatusReport[] = [];
  try {
    const raw = await fs.readFile(getStatusFile(), "utf-8");
    reports = JSON.parse(raw);
  } catch {
    // No reports yet
  }
  return { session, reports };
}
