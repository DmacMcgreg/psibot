import {
  PLIST_LABEL,
  LAUNCHER_SCRIPT,
  STDOUT_LOG,
  STDERR_LOG,
} from "./paths.ts";

export function generatePlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${LAUNCHER_SCRIPT}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${STDOUT_LOG}</string>

  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>
</dict>
</plist>
`;
}

export function generateLauncher(bunPath: string, projectRoot: string): string {
  const tailscalePath = "/opt/homebrew/bin/tailscale";
  return `#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Ensure Tailscale Funnel is configured for webhook port (idempotent, runs in background)
${tailscalePath} funnel --bg 8443 2>/dev/null || true

exec "${bunPath}" --cwd "${projectRoot}" src/index.ts
`;
}
