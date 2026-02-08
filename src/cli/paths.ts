import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

export const PROJECT_ROOT = join(import.meta.dir, "..", "..");
export const PSIBOT_DIR = join(HOME, ".psibot");
export const LOG_DIR = join(PSIBOT_DIR, "logs");
export const PID_FILE = join(PSIBOT_DIR, "psibot.pid");
export const STDOUT_LOG = join(LOG_DIR, "psibot.out.log");
export const STDERR_LOG = join(LOG_DIR, "psibot.err.log");
export const LAUNCHER_SCRIPT = join(PSIBOT_DIR, "launcher.sh");
export const PLIST_LABEL = "com.psibot.daemon";
export const PLIST_PATH = join(
  HOME,
  "Library",
  "LaunchAgents",
  "com.psibot.daemon.plist",
);
