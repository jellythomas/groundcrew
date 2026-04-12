import fs from "fs/promises";
import { existsSync, watch, type FSWatcher } from "fs";
import path from "path";
import { ensureGroundcrewDir } from "./queue.js";

const GROUNDCREW_DIR = ".groundcrew";
const FEEDBACK_FILE = path.join(GROUNDCREW_DIR, "feedback.md");

let lastFeedbackModified = 0;

export async function initFeedbackFile(): Promise<void> {
  await ensureGroundcrewDir();
  if (!existsSync(FEEDBACK_FILE)) {
    await fs.writeFile(
      FEEDBACK_FILE,
      "<!-- Write your feedback below. Save the file to send it to the agent. -->\n\n"
    );
  }
  try {
    const stat = await fs.stat(FEEDBACK_FILE);
    lastFeedbackModified = stat.mtimeMs;
  } catch {
    lastFeedbackModified = 0;
  }
}

export async function getFeedback(timeoutMs: number): Promise<string | null> {
  await initFeedbackFile();

  // Check if file has been modified since last read
  try {
    const stat = await fs.stat(FEEDBACK_FILE);
    if (stat.mtimeMs > lastFeedbackModified) {
      lastFeedbackModified = stat.mtimeMs;
      const content = await fs.readFile(FEEDBACK_FILE, "utf-8");
      const cleaned = stripComments(content).trim();
      if (cleaned.length > 0) {
        // Clear the file after reading
        await fs.writeFile(
          FEEDBACK_FILE,
          "<!-- Feedback received. Write new feedback below. -->\n\n"
        );
        return cleaned;
      }
    }
  } catch {
    // File doesn't exist yet, will create and watch
  }

  // Block — watch for changes
  return new Promise<string | null>((resolve) => {
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      watcher?.close();
      if (timer) clearTimeout(timer);
    };

    const checkFeedback = async () => {
      try {
        const stat = await fs.stat(FEEDBACK_FILE);
        if (stat.mtimeMs > lastFeedbackModified) {
          lastFeedbackModified = stat.mtimeMs;
          const content = await fs.readFile(FEEDBACK_FILE, "utf-8");
          const cleaned = stripComments(content).trim();
          if (cleaned.length > 0) {
            await fs.writeFile(
              FEEDBACK_FILE,
              "<!-- Feedback received. Write new feedback below. -->\n\n"
            );
            cleanup();
            resolve(cleaned);
          }
        }
      } catch {
        // Ignore mid-write errors
      }
    };

    watcher = watch(FEEDBACK_FILE, { persistent: true }, () => {
      checkFeedback();
    });

    timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}
