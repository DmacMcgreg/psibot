import { createLogger } from "../shared/logger.ts";

const log = createLogger("output-template");

/**
 * Render an output template against an agent result.
 *
 * Templates use `{{placeholder}}` substitution. The agent's `result` text is
 * treated as JSON first; if parse fails, the raw text is returned unchanged
 * (template is a no-op — the agent produced plain prose, not structured data).
 *
 * Nested access: `{{summary.headline}}` walks a dotted path. Missing keys
 * render as empty string.
 *
 * Arrays: `{{#each items}}- {{name}}: {{value}}{{/each}}` iterates.
 */
export function applyOutputTemplate(template: string, result: string): string {
  let data: unknown;
  try {
    const firstBrace = result.indexOf("{");
    const lastBrace = result.lastIndexOf("}");
    const candidate = firstBrace !== -1 && lastBrace > firstBrace ? result.slice(firstBrace, lastBrace + 1) : result;
    data = JSON.parse(candidate);
  } catch {
    log.info("Template fallback: result is not JSON, returning raw text");
    return result;
  }

  try {
    const withBlocks = renderEachBlocks(template, data);
    const withVars = renderVariables(withBlocks, data);
    return withVars;
  } catch (err) {
    log.error("Template render failed, returning raw text", { error: String(err) });
    return result;
  }
}

function renderEachBlocks(template: string, data: unknown): string {
  const eachRe = /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
  return template.replace(eachRe, (_m, pathExpr: string, body: string) => {
    const items = getPath(data, pathExpr.trim());
    if (!Array.isArray(items)) return "";
    return items.map((item) => renderVariables(body, item)).join("");
  });
}

function renderVariables(template: string, data: unknown): string {
  return template.replace(/\{\{([^}#/][^}]*)\}\}/g, (_m, pathExpr: string) => {
    const val = getPath(data, pathExpr.trim());
    if (val === undefined || val === null) return "";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  });
}

function getPath(data: unknown, path: string): unknown {
  if (path === "." || path === "this") return data;
  const parts = path.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
