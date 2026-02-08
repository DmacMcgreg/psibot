import { existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_ROOT,
  LOG_DIR,
  LAUNCHER_SCRIPT,
  PLIST_LABEL,
  PLIST_PATH,
  PSIBOT_DIR,
  STDOUT_LOG,
  STDERR_LOG,
} from "./paths.ts";
import { getRunningPid, removePid } from "./pid.ts";
import { generatePlist, generateLauncher } from "./plist.ts";

function getUid(): number {
  return process.getuid?.() ?? 501;
}

function serviceTarget(): string {
  return `gui/${getUid()}/${PLIST_LABEL}`;
}

function domainTarget(): string {
  return `gui/${getUid()}`;
}

function isInstalled(): boolean {
  return existsSync(PLIST_PATH);
}

function exec(cmd: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

export async function install(): Promise<void> {
  const bunPath = Bun.which("bun");
  if (!bunPath) {
    console.error("Error: bun executable not found in PATH");
    process.exit(1);
  }

  const entryPoint = join(PROJECT_ROOT, "src", "index.ts");
  if (!existsSync(entryPoint)) {
    console.error(`Error: entry point not found: ${entryPoint}`);
    process.exit(1);
  }

  // Create dirs
  mkdirSync(LOG_DIR, { recursive: true });

  // If already installed, bootout first
  if (isInstalled()) {
    console.log("Existing installation found, removing...");
    exec(["launchctl", "bootout", serviceTarget()]);
  }

  // Write launcher script (avoids launchd WorkingDirectory + Bun getcwd deadlock)
  const launcher = generateLauncher(bunPath, PROJECT_ROOT);
  writeFileSync(LAUNCHER_SCRIPT, launcher, "utf-8");
  chmodSync(LAUNCHER_SCRIPT, 0o755);
  console.log(`Launcher written: ${LAUNCHER_SCRIPT}`);

  // Generate and write plist
  const plist = generatePlist();
  writeFileSync(PLIST_PATH, plist, "utf-8");
  console.log(`Plist written: ${PLIST_PATH}`);

  // Bootstrap the service
  const result = exec(["launchctl", "bootstrap", domainTarget(), PLIST_PATH]);
  if (result.exitCode !== 0 && !result.stderr.includes("already bootstrapped")) {
    console.error(`launchctl bootstrap failed: ${result.stderr}`);
    process.exit(1);
  }

  console.log("LaunchAgent installed and bootstrapped");
  console.log(`  Bun: ${bunPath}`);
  console.log(`  Project: ${PROJECT_ROOT}`);
  console.log(`  Logs: ${LOG_DIR}`);
}

export async function uninstall(): Promise<void> {
  if (!isInstalled()) {
    console.log("LaunchAgent not installed");
    return;
  }

  // Bootout the service
  const result = exec(["launchctl", "bootout", serviceTarget()]);
  if (result.exitCode !== 0 && !result.stderr.includes("could not find service")) {
    console.error(`launchctl bootout warning: ${result.stderr.trim()}`);
  }

  // Remove plist
  try {
    unlinkSync(PLIST_PATH);
  } catch {
    // May already be gone
  }

  // Clean PID file
  removePid();

  console.log("LaunchAgent uninstalled");
}

export async function start(): Promise<void> {
  if (!isInstalled()) {
    console.error("Error: LaunchAgent not installed. Run 'psibot install' first.");
    process.exit(1);
  }

  const pid = getRunningPid();
  if (pid !== null) {
    console.log(`Already running (PID ${pid})`);
    return;
  }

  const result = exec(["launchctl", "kickstart", serviceTarget()]);
  if (result.exitCode !== 0) {
    console.error(`launchctl kickstart failed: ${result.stderr.trim()}`);
    process.exit(1);
  }

  // Wait briefly for process to start and write PID
  await Bun.sleep(2000);

  const newPid = getRunningPid();
  if (newPid !== null) {
    console.log(`Started (PID ${newPid})`);
  } else {
    console.log("Started (PID file not yet written, check 'psibot status' shortly)");
  }
}

export async function stop(): Promise<void> {
  const pid = getRunningPid();
  if (pid === null) {
    console.log("Not running");
    return;
  }

  // Send SIGTERM via launchctl
  if (isInstalled()) {
    exec(["launchctl", "kill", "SIGTERM", serviceTarget()]);
  } else {
    // Direct kill if not managed by launchctl
    process.kill(pid, "SIGTERM");
  }

  // Poll for exit up to 10 seconds
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    if (getRunningPid() === null) {
      console.log("Stopped");
      return;
    }
  }

  // Force kill
  console.log("Graceful shutdown timed out, sending SIGKILL...");
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may have exited between checks
  }
  removePid();
  console.log("Killed");
}

export async function restart(): Promise<void> {
  await stop();
  await start();
}

export async function status(): Promise<void> {
  const pid = getRunningPid();
  const installed = isInstalled();

  console.log(`LaunchAgent: ${installed ? "installed" : "not installed"}`);
  console.log(`Status:      ${pid !== null ? `running (PID ${pid})` : "stopped"}`);

  if (installed) {
    const result = exec(["launchctl", "print", serviceTarget()]);
    if (result.exitCode === 0) {
      // Extract useful lines from launchctl print
      const lines = result.stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("pid =") ||
          trimmed.startsWith("state =") ||
          trimmed.startsWith("last exit code =")
        ) {
          console.log(`  ${trimmed}`);
        }
      }
    }
  }

  console.log(`Logs:        ${LOG_DIR}`);
}

export async function logs(args: string[]): Promise<void> {
  let logFile = STDOUT_LOG;
  const tailArgs: string[] = [];
  let lineCount = "50";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--err") {
      logFile = STDERR_LOG;
    } else if (arg === "-f" || arg === "--follow") {
      tailArgs.push("-f");
    } else if (arg === "-n" && i + 1 < args.length) {
      lineCount = args[++i];
    }
  }

  if (!existsSync(logFile)) {
    console.log(`Log file not found: ${logFile}`);
    return;
  }

  tailArgs.push("-n", lineCount);

  const proc = Bun.spawn(["tail", ...tailArgs, logFile], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
