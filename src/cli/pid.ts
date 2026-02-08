import { PID_FILE } from "./paths.ts";
import { existsSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";

export function writePid(pid: number): void {
  writeFileSync(PID_FILE, String(pid), "utf-8");
}

export function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const content = readFileSync(PID_FILE, "utf-8").trim();
  const pid = parseInt(content, 10);
  if (Number.isNaN(pid) || pid <= 0) return null;
  return pid;
}

export function removePid(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // File may not exist, that's fine
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err) {
      // EPERM means process exists but we lack permission
      if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    }
    return false;
  }
}

export function getRunningPid(): number | null {
  const pid = readPid();
  if (pid === null) return null;
  if (isProcessRunning(pid)) return pid;
  // Stale PID file - clean it up
  removePid();
  return null;
}
