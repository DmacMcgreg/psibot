import { describe, expect, it } from "bun:test";
import { buildReauthMessage, oauthDashboardUrl } from "./oauth.ts";

/**
 * Regression guard: every OAuth-expiry message must carry the DASHBOARD link
 * (Connect buttons live there), never the vault root or a raw authorize path.
 * David corrected this repeatedly via memory prose; this pins it in code.
 *
 * Config is injected explicitly — never loadConfig() here: memoizing the
 * global config from a test breaks fleet-reader.test.ts, which must win the
 * first config read.
 */
const vault = {
  OAUTH_VAULT_URL: "https://vault.example.test",
  OAUTH_VAULT_API_KEY: "k123",
};
const noVault = { OAUTH_VAULT_URL: "", OAUTH_VAULT_API_KEY: "" };

describe("oauth reauth messaging", () => {
  it("dashboard url points at /dashboard with the key, never the root", () => {
    expect(oauthDashboardUrl(vault)).toBe("https://vault.example.test/dashboard?key=k123");
  });

  it("reauth message names the service and includes the dashboard link", () => {
    const msg = buildReauthMessage("YouTube discovery", vault);
    expect(msg).toContain("YouTube discovery");
    expect(msg).toContain("https://vault.example.test/dashboard?key=k123");
  });

  it("degrades gracefully when the vault is not configured", () => {
    expect(oauthDashboardUrl(noVault)).toBe("");
    expect(buildReauthMessage("Google", noVault)).toContain("not configured");
  });
});
