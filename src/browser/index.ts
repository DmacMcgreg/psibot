import { createLogger } from "../shared/logger.ts";

const log = createLogger("browser");

interface BrowserResult {
  success: boolean;
  output: string;
  error?: string;
}

export async function runBrowserTask(
  instruction: string,
  url?: string
): Promise<BrowserResult> {
  const args = ["--headless"];
  if (url) {
    args.push("--url", url);
  }
  args.push("--instruction", instruction);

  log.info("Running browser task", { instruction: instruction.slice(0, 100), url });

  try {
    const proc = Bun.spawn(["agent-browser", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      log.error("Browser task failed", { exitCode, stderr: stderr.slice(0, 500) });
      return {
        success: false,
        output: stdout,
        error: stderr || `Exit code: ${exitCode}`,
      };
    }

    log.info("Browser task completed", { outputLength: stdout.length });
    return { success: true, output: stdout };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Browser task error", { error: message });
    return { success: false, output: "", error: message };
  }
}

export async function takeScreenshot(url: string): Promise<Buffer | null> {
  const result = await runBrowserTask(
    `Navigate to this URL and take a screenshot. Return the screenshot.`,
    url
  );

  if (!result.success) {
    return null;
  }

  // agent-browser may output base64-encoded screenshot data
  const base64Match = result.output.match(
    /data:image\/png;base64,([A-Za-z0-9+/=]+)/
  );
  if (base64Match) {
    return Buffer.from(base64Match[1], "base64");
  }

  return null;
}
