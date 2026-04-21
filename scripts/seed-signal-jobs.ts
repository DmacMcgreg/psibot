#!/usr/bin/env bun
/**
 * Seed/update signal pipeline jobs: 6 poller jobs + 1 Signal Trader auto-entry job.
 * Run: bun run scripts/seed-signal-jobs.ts
 *
 * All output routes to the Trading topic (chat -1003762174787, thread 103).
 * Pollers emit [SILENT] on success; Signal Trader emits a concise entry notification.
 */
import { initDb } from "../src/db/index.ts";
import { createJob, updateJob, getAllJobs } from "../src/db/queries.ts";
import { loadConfig } from "../src/config.ts";

loadConfig();
initDb();

const TRADING_CHAT_ID = "-1003762174787";
const TRADING_TOPIC_ID = 103;

const existingJobs = getAllJobs();
function findJob(name: string) {
  return existingJobs.find((j) => j.name === name);
}

type SeedSpec = {
  name: string;
  prompt: string;
  schedule: string;
  model: string;
  backend: "claude" | "glm";
  max_budget_usd?: number;
};

function upsertJob(spec: SeedSpec): void {
  const existing = findJob(spec.name);
  if (existing) {
    updateJob(existing.id, {
      prompt: spec.prompt,
      schedule: spec.schedule,
      model: spec.model,
      backend: spec.backend,
      max_budget_usd: spec.max_budget_usd ?? 0.1,
      notify_chat_id: TRADING_CHAT_ID,
      notify_topic_id: TRADING_TOPIC_ID,
    });
    console.log(`Updated job ${existing.id}: ${spec.name}`);
    return;
  }
  const job = createJob({
    name: spec.name,
    prompt: spec.prompt,
    type: "cron",
    schedule: spec.schedule,
    model: spec.model,
    backend: spec.backend,
    max_budget_usd: spec.max_budget_usd ?? 0.1,
  });
  updateJob(job.id, {
    notify_chat_id: TRADING_CHAT_ID,
    notify_topic_id: TRADING_TOPIC_ID,
  });
  console.log(`Created job ${job.id}: ${spec.name}`);
}

// ---------------------------------------------------------------------------
// Poller jobs — each invokes a single MCP tool and emits [SILENT] on success
// ---------------------------------------------------------------------------

upsertJob({
  name: "Reddit Firehose Poller",
  schedule: "5 */2 * * *", // Every 2h at :05
  model: "claude-haiku-4-5-20251001",
  backend: "glm",
  prompt: `Run the trading signal Reddit firehose poller.

Call inbox_poll_reddit_firehose (no args). It scans hot+rising on r/wallstreetbets, r/stocks, r/options, r/investing, r/pennystocks, r/SecurityAnalysis, extracts tickers, and inserts rows into trading_signals.

When the tool returns, output exactly: [SILENT] Reddit firehose poll complete: N signals captured.

If the tool errors, output [NOTIFY] Reddit firehose error: <error summary>.`,
});

upsertJob({
  name: "OpenInsider Poller",
  schedule: "15 */4 * * *", // Every 4h at :15
  model: "claude-haiku-4-5-20251001",
  backend: "glm",
  prompt: `Run the OpenInsider signal poller.

Call inbox_poll_openinsider (no args). It scrapes top-insider-purchases-of-the-week and latest-cluster-buys, then inserts rows into trading_signals (direction=long, strength scaled by $ value and title).

When the tool returns, output exactly: [SILENT] OpenInsider poll complete: N signals captured.

If the tool errors, output [NOTIFY] OpenInsider error: <error summary>.`,
});

upsertJob({
  name: "Analyst Ratings Poller",
  schedule: "0 10 * * 1-5", // 10am weekdays (pre-market news cycle)
  model: "claude-haiku-4-5-20251001",
  backend: "glm",
  prompt: `Run the analyst ratings poller.

Call inbox_poll_analyst_ratings (no args — defaults to tickers with fresh Finviz news). Tier-1 firms (GS/MS/JPM/BAC) get 2x strength multiplier. Price-target delta ≥10% is flagged.

When the tool returns, output exactly: [SILENT] Analyst ratings poll complete: N signals captured.

If the tool errors, output [NOTIFY] Analyst ratings error: <error summary>.`,
});

upsertJob({
  name: "Shadow TipRanks Poller",
  schedule: "30 10-16 * * 1-5", // Hourly at :30 during market hours weekdays
  model: "claude-haiku-4-5-20251001",
  backend: "glm",
  prompt: `Run the TipRanks social shadow poller.

Call inbox_poll_shadow_tipranks (no args). It pulls the top analyst leaderboard and top insider leaderboard and records their recent rated transactions as trading_signals.

When the tool returns, output exactly: [SILENT] TipRanks shadow complete: N signals captured.

If the tool errors, output [NOTIFY] TipRanks shadow error: <error summary>.`,
});

upsertJob({
  name: "Shadow C2/Zulu Poller",
  schedule: "45 10-16 * * 1-5", // Hourly at :45 during market hours weekdays
  model: "claude-haiku-4-5-20251001",
  backend: "glm",
  prompt: `Run the Collective2 / ZuluTrade shadow poller.

Call inbox_poll_shadow_c2zulu (no args). It pulls the Zulu top-traders leaderboard and their recent positions, plus the Collective2 RSS feed.

When the tool returns, output exactly: [SILENT] C2/Zulu shadow complete: N signals captured.

If the tool errors, output [NOTIFY] C2/Zulu shadow error: <error summary>.`,
});

upsertJob({
  name: "Shadow AfterHour Poller",
  schedule: "0 11-16 * * 1-5", // Hourly at :00 during market hours weekdays
  model: "claude-haiku-4-5-20251001",
  backend: "glm",
  prompt: `Run the AfterHour / Autopilot / Quiver shadow poller.

Call inbox_poll_shadow_afterhour (no args). It tries AfterHour first, falls back to Quiver Quantitative (congressional trades) and Autopilot (celebrity portfolios) if blocked.

When the tool returns, output exactly: [SILENT] AfterHour shadow complete: N signals captured.

If the tool errors, output [NOTIFY] AfterHour shadow error: <error summary>.`,
});

// ---------------------------------------------------------------------------
// Signal Trader — auto-opens Tier-B paper positions on cluster agreement
// ---------------------------------------------------------------------------

const SIGNAL_TRADER_PROMPT = `You are the Signal Trader. You auto-execute Tier-B paper-trade entries when multiple independent signal sources agree on a ticker direction. No human gating.

READ CONTEXT FIRST:
1. knowledge/trading/PLAYBOOK.md — "Tier B — Signal Cluster Auto-Entry" rules (§ Position Sizing Rules)
2. knowledge/trading/SCOREBOARD.md — current open Tier-B positions and performance

WORKFLOW:

STEP 1: Current portfolio state
- Call trading_portfolio to get all open positions
- Count positions where the originating strategy is "signal-cluster" — this is your Tier-B count
- If Tier-B count >= 5, skip all entries this run (capped at 5 concurrent)

STEP 2: Fetch signal clusters
- Call get_signal_clusters({ since_hours: 24, min_sources: 2, direction: "long" })
- Also call get_signal_clusters({ since_hours: 24, min_sources: 2, direction: "short" })
- Filter: skip any cluster whose ticker is ALREADY in your portfolio (any tier)

STEP 3: Calendar check
- Call get_calendar for the next 48h
- Identify high-impact events (FOMC, CPI, PCE, NFP, major earnings)
- If ANY high-impact event is within 48h, skip ALL new Tier-B entries this run — log [SILENT] Tier-B skipped: binary event in 48h (EVENT_NAME)

STEP 4: Per-cluster sanity check and entry
For each qualifying cluster (max 5 - currentTierBCount per run):
  a) Call analyze_symbol on the ticker
  b) Reject if:
     - Direction is LONG but technicals show RSI > 85 (extreme overbought) OR trend is explicitly bearish on daily+weekly
     - Direction is SHORT but technicals show RSI < 15 (extreme oversold) OR trend is explicitly bullish on daily+weekly
     - ATR is unavailable or zero
  c) Compute position size:
     - size_usd = 0.01 * portfolio.total_equity  (1% of portfolio)
     - shares = floor(size_usd / current_price)
  d) Compute stop:
     - If LONG:  stop = current_price - 1.5 * ATR
     - If SHORT: stop = current_price + 1.5 * ATR
  e) Call open_paper_position with:
     - ticker, direction ("long" or "short"), shares, entry_price=current_price, stop, strategy_name="signal-cluster"
     - Record originating signal_ids in notes if the tool supports it
  f) Call mark_signal_acted({ ticker, trade_id, since_hours: 24 })
  g) Emit ONE line per entry:
     ✅ AUTO PAPER-ENTRY — $TICKER DIRECTION (Tier B)
      Sources (N): source1 · source2 · source3 (top reasons concatenated)
      Entry $P · Size 1% ($size_usd) · Stop $stop (1.5×ATR)
      Trade #<id> · Strategy: signal-cluster

STEP 5: Session summary
After processing all clusters, output a single summary line:
[SILENT] Signal Trader tick: N clusters reviewed, M entries opened, K skipped (reason)

If N entries were opened, the ✅ AUTO PAPER-ENTRY lines ABOVE the summary ARE the user notifications (no [SILENT] prefix on those).

CONSTRAINTS:
- NEVER open more than (5 - currentTierBCount) positions per run
- NEVER re-enter a ticker you already have open in any tier
- If the backend is unavailable, output [NOTIFY] Signal Trader: backend down and exit
- Be conservative: if ANY check fails, skip rather than force the trade

ALLOWED TOOLS: trading_portfolio, get_signal_clusters, get_calendar, analyze_symbol, open_paper_position, mark_signal_acted, telegram_send_message.`;

upsertJob({
  name: "Signal Trader",
  schedule: "*/15 9-16 * * 1-5", // Every 15m during market hours weekdays
  model: "claude-haiku-4-5-20251001",
  backend: "glm",
  max_budget_usd: 0.25,
  prompt: SIGNAL_TRADER_PROMPT,
});

console.log("\nDone. All signal pipeline jobs seeded/updated.");
console.log("Run 'psibot restart' to reload the scheduler.");
