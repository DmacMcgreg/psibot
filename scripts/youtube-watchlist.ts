/**
 * One YouTube watchlist run, without the agent: calls the same handler job 12
 * used (youtube_process_playlist with retry_failed), so the re-auth latch and
 * the summary text stay identical. Command-center's apps/youtube-watchlist
 * schedules this every 3 hours and owns the alerts.
 *
 *   bun --cwd <psibot repo> scripts/youtube-watchlist.ts
 *
 * Prints one JSON line on stdout: { ok, counts, text }. Exit 0 when the run
 * finished (even with failed videos), 1 when the handler reported an error.
 */
import { youtubeProcessPlaylistTool } from "../src/agent/youtube-playlist-tool.ts";
import { initDb } from "../src/db/index.ts";
import { loadConfig } from "../src/config.ts";

loadConfig();
initDb();

const res = await youtubeProcessPlaylistTool().handler({ retry_failed: true }, {});
const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
const m = text.match(/\((\d+) new, (\d+) skipped, (\d+) moved, (\d+) failed\)/);
const counts = m
  ? { processed: +m[1], skipped: +m[2], moved: +m[3], failed: +m[4] }
  : null;

console.log(JSON.stringify({ ok: !res.isError, counts, text }));
process.exit(res.isError ? 1 : 0);
