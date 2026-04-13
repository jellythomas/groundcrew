import fs from "fs/promises";
import { existsSync, watch } from "fs";
import { getSessionDir, getFeedbackFile } from "./paths.js";
let lastFeedbackModified = 0;
export async function initFeedbackFile() {
    await fs.mkdir(getSessionDir(), { recursive: true });
    const feedbackFile = getFeedbackFile();
    if (!existsSync(feedbackFile)) {
        await fs.writeFile(feedbackFile, "<!-- Write your feedback below. Save the file to send it to the agent. -->\n\n");
    }
    try {
        const stat = await fs.stat(feedbackFile);
        lastFeedbackModified = stat.mtimeMs;
    }
    catch {
        lastFeedbackModified = 0;
    }
}
export async function getFeedback(timeoutMs) {
    const feedbackFile = getFeedbackFile();
    await initFeedbackFile();
    // Check if file has been modified since last read
    try {
        const stat = await fs.stat(feedbackFile);
        if (stat.mtimeMs > lastFeedbackModified) {
            lastFeedbackModified = stat.mtimeMs;
            const content = await fs.readFile(feedbackFile, "utf-8");
            const cleaned = stripComments(content).trim();
            if (cleaned.length > 0) {
                await fs.writeFile(feedbackFile, "<!-- Feedback received. Write new feedback below. -->\n\n");
                return cleaned;
            }
        }
    }
    catch {
        // File doesn't exist yet, will create and watch
    }
    // Block — watch for changes
    return new Promise((resolve) => {
        let watcher;
        let timer;
        const cleanup = () => {
            watcher?.close();
            if (timer)
                clearTimeout(timer);
        };
        const checkFeedback = async () => {
            try {
                const stat = await fs.stat(feedbackFile);
                if (stat.mtimeMs > lastFeedbackModified) {
                    lastFeedbackModified = stat.mtimeMs;
                    const content = await fs.readFile(feedbackFile, "utf-8");
                    const cleaned = stripComments(content).trim();
                    if (cleaned.length > 0) {
                        await fs.writeFile(feedbackFile, "<!-- Feedback received. Write new feedback below. -->\n\n");
                        cleanup();
                        resolve(cleaned);
                    }
                }
            }
            catch {
                // Ignore mid-write errors
            }
        };
        watcher = watch(feedbackFile, { persistent: true }, () => {
            checkFeedback();
        });
        timer = setTimeout(() => {
            cleanup();
            resolve(null);
        }, timeoutMs);
    });
}
function stripComments(text) {
    return text.replace(/<!--[\s\S]*?-->/g, "");
}
