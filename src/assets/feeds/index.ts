/**
 * The asset feeds and their schedules (America/Toronto). The runner in
 * `../feed-runner.ts` schedules each one with croner.
 */

import type { FeedStats } from "./common.ts";
import { runCanadaBuys } from "./canadabuys.ts";
import { runOntarioFunding } from "./ontario-funding.ts";
import { runGcNews } from "./gc-news.ts";
import { runIrapLeads } from "./irap-leads.ts";
import { runHuggingFace } from "./huggingface.ts";
import { runGithub } from "./github.ts";
import { runHackerNews } from "./hackernews.ts";
import { runSkillsSh } from "./skills-sh.ts";
import { runKaggle } from "./kaggle.ts";

export interface FeedDef {
  name: string;
  /** croner pattern, America/Toronto. */
  schedule: string;
  /** Nominal interval, used to catch up on start after downtime. */
  everyHours: number;
  run: () => Promise<FeedStats>;
}

export const FEEDS: FeedDef[] = [
  // CanadaBuys rebuilds its files around 06:15 ET.
  { name: "canadabuys", schedule: "15 1,7,13,19 * * *", everyHours: 6, run: () => runCanadaBuys() },
  { name: "gc-news", schedule: "45 2,8,14,20 * * *", everyHours: 6, run: () => runGcNews() },
  { name: "ontario-funding", schedule: "30 7 * * *", everyHours: 24, run: () => runOntarioFunding() },
  { name: "huggingface", schedule: "0 9,21 * * *", everyHours: 12, run: () => runHuggingFace() },
  { name: "github", schedule: "20 9,21 * * *", everyHours: 12, run: () => runGithub() },
  { name: "hackernews", schedule: "40 9,21 * * *", everyHours: 12, run: () => runHackerNews() },
  { name: "skills-sh", schedule: "0 10 * * *", everyHours: 24, run: () => runSkillsSh() },
  { name: "kaggle", schedule: "20 10 * * *", everyHours: 24, run: () => runKaggle() },
  // Disclosure data updates quarterly; weekly is plenty.
  { name: "irap-leads", schedule: "0 8 * * 1", everyHours: 24 * 7, run: () => runIrapLeads() },
];

export { readFeedState, FEEDS_STATE_KEY, KEEP_SCORE } from "./common.ts";
export type { FeedStats } from "./common.ts";
