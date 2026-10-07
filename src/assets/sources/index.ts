export { youtubeSource } from "./youtube.ts";
export { tabSource } from "./tabs.ts";
export { githubSource, inboxSource } from "./inbox.ts";
export { researchSource } from "./research.ts";
export * from "./types.ts";

import { youtubeSource } from "./youtube.ts";
import { tabSource } from "./tabs.ts";
import { githubSource, inboxSource } from "./inbox.ts";
import { researchSource } from "./research.ts";
import type { Source, SourceKind } from "./types.ts";

export const SOURCES: Record<SourceKind, Source> = {
  youtube: youtubeSource,
  tab: tabSource,
  github: githubSource,
  inbox: inboxSource,
  research: researchSource,
};
