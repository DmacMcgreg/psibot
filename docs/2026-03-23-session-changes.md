# Session Changes — March 23, 2026

## 1. YouTube → Research Pipeline Connection

**Files changed:** `src/youtube/process.ts`, `src/shared/types.ts`

After a YouTube video is processed and stored (transcript analyzed, embeddings generated, topics indexed), it's now automatically inserted into the `pending_items` table as a capture with `source: "youtube"`. From there it flows through the same triage → research pipeline as Reddit saves and GitHub stars.

- Added `"youtube"` to the `CaptureSource` union type
- After `processAndStoreVideo()` completes (not skipped), inserts a pending item with the video URL, title, and first 500 chars of the markdown summary
- Failure to insert doesn't block video processing (try/catch with warning log)

## 2. Budget Enforcement Disabled

**Files changed:** `src/agent/index.ts`, `src/scheduler/executor.ts`

Budget limits were causing recurring `budget_exceeded` failures on jobs (Reddit Poller, GitHub Poller, Research Pipeline). Since David is on Claude Max (unlimited) and uses free GLM models for triage, budgets serve no purpose.

Changes:
- `maxBudgetUsd` no longer passed to the Claude Agent SDK's `query()` call (commented out, not deleted)
- Executor no longer passes `maxBudgetUsd` to AgentService (commented out)
- Executor no longer checks `result.costUsd >= job.max_budget_usd` to set `budget_exceeded` status — all completed runs are now `"success"`
- The `max_budget_usd` column, DB schema, types, and UI display are all left intact for reference

## 3. Rich Content Extraction for Triage

**Files changed:** `src/triage/index.ts`

Previously, triage only had the HTML `<title>` and `<meta description>` from capture time. For Reddit galleries, link posts, and many other URLs this was empty or useless, leading to blind categorization.

Now triage fetches actual content before calling GLM:

**Reddit posts** (detected by platform or URL):
- Fetches the Reddit `.json` API endpoint for full post selftext
- Extracts top 5 comments with author and score
- Detects linked external URLs (non-reddit) and fetches their content too
- Handles gallery URLs by converting `/gallery/ID` → `/comments/ID`

**Other URLs:**
- Fetches up to 100KB of HTML body
- Strips tags, scripts, styles, nav, footer
- Returns up to 3000 chars of clean text

All content is passed to the GLM triage prompt.

## 4. Improved Triage Categories

**Files changed:** `src/triage/index.ts`

The triage prompt now includes explicit category definitions instead of leaving it to the model to guess:

| Category | Definition | What happens |
|---|---|---|
| `research` | Genuinely important content connecting to HIGH priority interests. New tools, techniques, frameworks, papers. | Triggers research pipeline for deep dive |
| `reference` | Useful bookmarkable resource with actual substance — docs, tutorials, libraries. | Stays in DB as searchable record |
| `actionable` | Requires user action — sign up, try, respond, buy, fix. | Stays in DB |
| `entertainment` | Memes, jokes, casual content without substance. | Stays in DB |
| `not_worth_keeping` | Irrelevant, spam, low-quality, inaccessible content. | Marked as deleted |

Key prompt improvements:
- "Analyze based on ACTUAL CONTENT, not just the title"
- "If content could not be extracted or is empty/inaccessible, set category to not_worth_keeping"
- Summary must include "specific details from the content, not just the title"
- Tags array returned (including subreddit for Reddit items)

## 5. No More NotePlan Notes at Triage Time

**Files changed:** `src/triage/index.ts`

Previously, every triaged item that wasn't `not_worth_keeping` got a stub NotePlan note created immediately in the mapped folder. This cluttered `30 - Resources` with ~130 useless one-liner notes like "No summary available."

Now:
- Triage only updates the DB record (priority, category, summary, tags)
- NO NotePlan notes are created during triage
- Notes are only created by the research pipeline after actual research is done
- The `createNotePlanNote` function, `CATEGORY_FOLDER_MAP`, `NOTEPLAN_BASE`, and related filesystem imports were removed

## 6. NaN Priority Fix

**Files changed:** `src/triage/index.ts`

Priority values were sometimes `NaN` when the GLM response couldn't be parsed as a number. Added explicit `Number.isFinite()` guard — defaults to 3 if parsing fails.

## 7. Subreddit Stored in Profile Field

**Files changed:** `src/capture/reddit.ts`

The Reddit capture now stores the subreddit name in the `profile` field of `pending_items`. Previously this field was unused for Reddit captures. The triage prompt also receives the subreddit and always includes it as a tag.

## 8. Resource Stubs Cleanup

**Script:** `scripts/cleanup-resource-stubs.ts`

One-time migration:
- Moved 133 auto-generated stub files from `30 - Resources/` root to `@Trash/30 - Resources/`
- Reset all 133 corresponding `pending_items` records to `status = "pending"` (cleared priority, category, triage_summary, noteplan_path)
- These will be re-triaged with the improved content extraction
- Curated subdirectories left untouched: `agent-automation-platforms/`, `ai-sdk/`, `dev-backend/`, `dev-frontend/`, `imitation-of-christ/`

## 9. Triage Job Re-enabled

The Inbox Triage job (#33) had status `"failed"` — re-enabled to `"enabled"`. Runs every 30 minutes with cron `*/30 * * * *`.

## Test Results

Ran 5 items through the new triage. Quality comparison:

| Item | Before | After |
|---|---|---|
| Raycast in 2026 | reference, NaN priority, "No summary" | not_worth_keeping, P4, detailed reasoning |
| GeminiAI profile pics | reference, NaN priority, "No summary" | entertainment, P4, identifies it as fun demo |
| Hetzner attacks | reference, NaN priority, "No summary" | reference, P2, cites specific security recommendations |
| Next.js CLI | reference, NaN priority, "No summary" | reference, P2, names specific tools (drizzle, better-auth) |
| OpenCode Black | reference, NaN priority, "No summary" | research, P2, quotes pricing and usage patterns |

## Pending

- 128 remaining items in `pending` status awaiting re-triage (triage job processes 50 per run)
- 228 items in `triaged` status with old-quality categorization (could be reset if needed)
- Curated subdirectories in `30 - Resources/` need tag/category system (future work)
