import {
  appendFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

function getLogFilePath(): string {
  return process.env.OPENCODE_MEM_LOG_FILE || join(homedir(), ".opencode-mem", "opencode-mem.log");
}

function getLogDirPath(): string {
  const logFile = getLogFilePath();
  const lastSlash = Math.max(logFile.lastIndexOf("/"), logFile.lastIndexOf("\\"));
  return lastSlash === -1 ? "." : logFile.slice(0, lastSlash);
}

const MAX_LOG_SIZE = 5 * 1024 * 1024;

const GLOBAL_LOGGER_KEY = Symbol.for("opencode-mem.logger.initialized");

function rotateLog() {
  const logFile = getLogFilePath();
  try {
    if (!existsSync(logFile)) return;
    const stats = statSync(logFile);
    if (stats.size < MAX_LOG_SIZE) return;

    const oldLog = logFile + ".old";
    if (existsSync(oldLog)) unlinkSync(oldLog);
    renameSync(logFile, oldLog);
  } catch {}
}

function ensureLoggerInitialized() {
  if ((globalThis as any)[GLOBAL_LOGGER_KEY]) return;
  const logDir = getLogDirPath();
  const logFile = getLogFilePath();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  rotateLog();
  writeFileSync(logFile, `\n--- Session started: ${new Date().toISOString()} ---\n`, {
    flag: "a",
  });
  (globalThis as any)[GLOBAL_LOGGER_KEY] = true;
}

export function log(message: string, data?: unknown) {
  ensureLoggerInitialized();
  const logFile = getLogFilePath();
  const timestamp = new Date().toISOString();
  const line = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  appendFileSync(logFile, line);
}

/**
 * Render an unknown thrown value into a diagnostic string, walking the `.cause`
 * chain so a wrapper like `new Error("Migration failed", { cause })` surfaces the
 * ROOT error (e.g. `getaddrinfo ENOTFOUND ...`) instead of a generic message.
 *
 * The plugin previously logged `String(err)` / `err.message` at several sites, which
 * dropped `.cause` and reduced real failures to `Migration failed: <unknown>`. Route
 * error logging through this so the actual cause is never masked again.
 */
export function formatError(err: unknown): string {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) {
      chain.push(`${cur.name}: ${cur.message}`);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      try {
        chain.push(typeof cur === "string" ? cur : JSON.stringify(cur));
      } catch {
        chain.push(String(cur));
      }
      cur = undefined;
    }
  }
  return chain.length ? chain.join(" <- caused by: ") : String(err);
}
