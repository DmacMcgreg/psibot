import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../shared/logger.ts";
import type { PendingItem } from "../shared/types.ts";
import type { QuickScanResult } from "../research/quick-scan.ts";

const log = createLogger("heartbeat:signals");
const PROJECT_ROOT = resolve(process.cwd());

interface SignalResult {
  score: number;
  signals: string[];
  autoAction: "deep_research" | "watch" | "archive" | null;
}

/**
 * Score an item using contextual intelligence signals.
 * These are deterministic checks that don't need accumulated feedback.
 */
export function scoreSignals(
  item: PendingItem,
  quickScan: QuickScanResult | null
): SignalResult {
  const signals: string[] = [];
  let score = 0;

  // --- Direct Relevance Signals ---

  // Check if item mentions a dependency from package.json
  const deps = loadDependencies();
  const textToSearch = [
    item.title,
    item.description,
    item.extracted_value,
    item.triage_summary,
    quickScan?.summary,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  for (const dep of deps) {
    if (textToSearch.includes(dep.toLowerCase())) {
      signals.push(`matches-dependency:${dep}`);
      score += 30;
    }
  }

  // Check if item addresses a workflow manifest gap
  const gaps = loadWorkflowGaps();
  for (const gap of gaps) {
    if (textToSearch.includes(gap.toLowerCase())) {
      signals.push(`addresses-workflow-gap:${gap}`);
      score += 25;
    }
  }

  // Include quick scan signals
  if (quickScan?.signals) {
    for (const sig of quickScan.signals) {
      if (!signals.includes(sig)) {
        signals.push(sig);
        if (sig.startsWith("matches-dependency")) score += 30;
        else if (sig === "security-advisory") score += 50;
        else if (sig === "rapid-growth") score += 15;
        else if (sig.startsWith("addresses-workflow-gap")) score += 25;
        else score += 10;
      }
    }
  }

  // --- Momentum Signals ---

  // Check if similar items are clustering (same platform+profile within recent triaged)
  if (quickScan?.notable) {
    signals.push("quick-scan-notable");
    score += 15;
  }

  // --- Decay Signals ---

  if (item.relevance_window) {
    const deadline = new Date(item.relevance_window);
    const now = new Date();
    const daysLeft = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (daysLeft < 3 && daysLeft > 0) {
      signals.push("approaching-deadline");
      score += 20;
    } else if (daysLeft <= 0) {
      signals.push("past-deadline");
      score -= 10;
    }
  }

  // --- Determine auto-action ---
  let autoAction: SignalResult["autoAction"] = null;

  if (score >= 40) {
    autoAction = "deep_research";
  } else if (signals.includes("past-deadline")) {
    autoAction = "archive";
  }

  log.info("Signal scoring complete", {
    itemId: item.id,
    score,
    signalCount: signals.length,
    autoAction,
    signals: signals.join(", "),
  });

  return { score, signals, autoAction };
}

// --- Helpers ---

let _depsCache: string[] | null = null;

function loadDependencies(): string[] {
  if (_depsCache) return _depsCache;
  try {
    const pkgPath = join(PROJECT_ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    _depsCache = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    return _depsCache;
  } catch {
    return [];
  }
}

let _gapsCache: string[] | null = null;

function loadWorkflowGaps(): string[] {
  if (_gapsCache) return _gapsCache;
  try {
    const manifestPath = join(PROJECT_ROOT, "knowledge/WORKFLOW.md");
    const content = readFileSync(manifestPath, "utf-8");
    // Extract bullet points from "Known Gaps & Pain Points" section
    const gapsMatch = content.match(
      /## Known Gaps & Pain Points\n([\s\S]*?)(?=\n##|\n$)/
    );
    if (!gapsMatch) return [];
    _gapsCache = gapsMatch[1]
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.replace(/^- /, "").trim().toLowerCase())
      .flatMap((gap) => {
        // Extract key phrases from each gap
        const words = gap.split(/\s+/).filter((w) => w.length > 4);
        return words.slice(0, 3);
      });
    return _gapsCache;
  } catch {
    return [];
  }
}
