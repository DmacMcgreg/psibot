import { Hono } from "hono";

export function createAuthRoutes() {
  const app = new Hono();

  // OAuth flows are now handled by the external OAuth vault.
  // This route is kept for backwards compatibility but redirects to vault info.
  app.get("/auth/youtube/callback", (c) => {
    return c.html(renderPage("YouTube OAuth Moved", `
      <div style="color: #3b82f6; font-size: 48px; margin-bottom: 16px;">&#8594;</div>
      <p style="color: #3b82f6; font-size: 18px; margin-bottom: 8px;">YouTube OAuth is now managed by the OAuth vault.</p>
      <p style="color: #6b7280;">Use the vault dashboard to connect Google/YouTube.</p>
    `));
  });

  return app;
}

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #111827; color: #f9fafb;">
  <div style="text-align: center; padding: 32px;">
    ${body}
  </div>
</body>
</html>`;
}
