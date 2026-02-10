import { Hono } from "hono";
import { exchangeCodeForTokens } from "../../youtube/api.ts";
import { createLogger } from "../../shared/logger.ts";

const log = createLogger("web:auth");

export function createAuthRoutes() {
  const app = new Hono();

  app.get("/auth/youtube/callback", async (c) => {
    const code = c.req.query("code");
    const error = c.req.query("error");

    if (error) {
      log.error("OAuth error", { error });
      return c.html(renderPage("YouTube Authorization Failed", `
        <div style="color: #dc2626; font-size: 48px; margin-bottom: 16px;">&#10007;</div>
        <p style="color: #dc2626; font-size: 18px; margin-bottom: 8px;">Authorization was denied or failed.</p>
        <p style="color: #6b7280;">Error: ${escapeHtml(error)}</p>
        <p style="color: #6b7280; margin-top: 16px;">You can close this tab and try again.</p>
      `));
    }

    if (!code) {
      return c.html(renderPage("YouTube Authorization Failed", `
        <div style="color: #dc2626; font-size: 48px; margin-bottom: 16px;">&#10007;</div>
        <p style="color: #dc2626; font-size: 18px;">No authorization code received.</p>
        <p style="color: #6b7280; margin-top: 16px;">You can close this tab and try again.</p>
      `));
    }

    try {
      await exchangeCodeForTokens(code);
      log.info("YouTube OAuth completed successfully");

      return c.html(renderPage("YouTube Connected", `
        <div style="color: #16a34a; font-size: 48px; margin-bottom: 16px;">&#10003;</div>
        <p style="color: #16a34a; font-size: 18px; margin-bottom: 8px;">YouTube connected successfully!</p>
        <p style="color: #6b7280;">You can close this tab.</p>
      `));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Token exchange failed", { error: message });

      return c.html(renderPage("YouTube Authorization Failed", `
        <div style="color: #dc2626; font-size: 48px; margin-bottom: 16px;">&#10007;</div>
        <p style="color: #dc2626; font-size: 18px; margin-bottom: 8px;">Token exchange failed.</p>
        <p style="color: #6b7280;">${escapeHtml(message)}</p>
        <p style="color: #6b7280; margin-top: 16px;">You can close this tab and try again.</p>
      `));
    }
  });

  return app;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #111827; color: #f9fafb;">
  <div style="text-align: center; padding: 32px;">
    ${body}
  </div>
</body>
</html>`;
}
