import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Link guard (2026-10-03): fc1328c landed agent code importing GLM_CLI_ENV
// and calling toolBundle.setRunContext without their defining halves, and the
// entry imports modules that lived only as untracked working-tree files —
// every clean checkout died at module load before one suite assertion ran,
// while working-tree runs stayed green. A `bun build --target=bun` of the
// agent entry fails with exit 1 on BOTH defect shapes ("Could not resolve"
// for a missing module, "No matching export" for a missing named export), so
// this boot smoke makes the next orphaned landing fail red here instead of
// only in a fresh clone.

describe("agent entry link guard", () => {
  test(
    "bun build --target=bun links src/agent/index.ts with no module errors",
    () => {
      const repoRoot = resolve(import.meta.dir, "../..");
      const outfile = join(tmpdir(), `agent-link-guard-${process.pid}.js`);
      const proc = Bun.spawnSync(
        ["bun", "build", "--target=bun", `--outfile=${outfile}`, "src/agent/index.ts"],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      const output = proc.stdout.toString() + proc.stderr.toString();
      if (proc.exitCode !== 0) {
        throw new Error(
          `agent entry does not link on a clean tree — a committed import lacks its committed half:\n${output}`,
        );
      }
      expect(output).not.toMatch(/Could not resolve|No matching export|ModuleNotFound/);
    },
    60_000,
  );
});
