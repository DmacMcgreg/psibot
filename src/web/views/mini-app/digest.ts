import { miniAppLayout } from "./shell.ts";
import {
  escapeHtml,
  escapeAttr,
  pageHeader,
  emptyState,
  errorState,
  listRow,
  button,
  formatAgo,
} from "./components.ts";

// ---------------------------------------------------------------------------
// Weekly Digest reader — lists archived knowledge/digests/*.md newest-first,
// and renders a single digest via the same markdown-toggle approach used by
// Library synthesis pages (data-md rendered / raw <pre> toggle).
// ---------------------------------------------------------------------------

export interface DigestFile {
  /** ISO week label, e.g. "2026-W27" (filename without extension). */
  week: string;
  /** knowledge-relative path, e.g. "knowledge/digests/2026-W27.md". */
  path: string;
  mtime: number;
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------

export interface DigestListPageOpts {
  files: DigestFile[];
}

export function tmaDigestListPage(opts: DigestListPageOpts): string {
  const { files } = opts;

  const rows = files
    .map((f) =>
      listRow({
        title: f.week,
        meta: formatAgo(f.mtime),
        href: `/tma/digest/${encodeURIComponent(f.week)}`,
        chevron: true,
      }),
    )
    .join("\n");

  const body = `
    ${pageHeader("Weekly Digest", {
      subtitle: `${files.length} digest${files.length === 1 ? "" : "s"} archived`,
      actions: `<a href="/tma/more" class="tma-link" style="font-size:var(--fs-sm);">← More</a>`,
    })}
    ${
      files.length === 0
        ? emptyState(
            "📬",
            "No digests yet",
            "The weekly digest publishes Friday 5pm ET. Archived digests appear here.",
          )
        : rows
    }
  `;
  return miniAppLayout("digest", body, false);
}

// ---------------------------------------------------------------------------
// Single digest view
// ---------------------------------------------------------------------------

export interface DigestFileViewOpts {
  file: DigestFile;
  content: string | null;
}

export function tmaDigestFileViewPage(opts: DigestFileViewOpts): string {
  const { file, content } = opts;
  const body = `
    ${pageHeader(`Digest ${file.week}`, {
      subtitle: file.path,
      actions: `<a href="/tma/digest" class="tma-link" style="font-size:var(--fs-sm);">← Digests</a>`,
    })}
    ${
      content !== null
        ? `<div class="tma-section">
            <div data-md-toggle-root>
              <div class="md-rendered tma-md" data-md data-md-src="${escapeAttr(content)}" style="padding:0 var(--sp-4);"></div>
              <pre class="md-raw tma-mono" style="display:none; white-space:pre-wrap; margin:0 var(--sp-4); padding:var(--sp-3); border-radius:var(--rad-md); background:var(--tma-bg-secondary);">${escapeHtml(content)}</pre>
            </div>
            <div style="padding:var(--sp-2) var(--sp-4);">
              ${button("Raw", { small: true, kind: "secondary", onclick: "toggleMdView(this)" })}
            </div>
          </div>`
        : errorState("Could not load this digest.", `/tma/digest/${encodeURIComponent(file.week)}`)
    }
  `;
  return miniAppLayout("digest", body, false);
}
