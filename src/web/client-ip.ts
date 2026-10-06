import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

/**
 * Client-address resolution for the dashboard, Mini App and webhook allowlists.
 *
 * The address comes from the TCP socket, never from a header alone. The one
 * exception is a loopback peer: that is a local reverse proxy (`tailscale
 * serve`/Funnel), which drops any client-sent X-Forwarded-For and sets it to the
 * real source address, so its X-Forwarded-For is trusted. X-Real-IP is never
 * read — tailscale serve passes a client's value through untouched.
 */

export function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.");
}

/** "::ffff:1.2.3.4" (IPv4 on a dual-stack socket) → "1.2.3.4". */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  return trimmed.startsWith("::ffff:") && trimmed.includes(".") ? trimmed.slice(7) : trimmed;
}

/** The socket peer, or null when the request did not arrive through Bun.serve. */
function socketPeer(c: Context): string | null {
  try {
    const address = getConnInfo(c).remote.address;
    return address ? normalizeIp(address) : null;
  } catch {
    return null; // no Bun server in c.env (e.g. app.request() without one)
  }
}

/**
 * The requesting client's IP, or null when it cannot be determined — callers
 * must treat null as untrusted. Behind a loopback proxy, X-Forwarded-For is
 * walked right to left and the first non-loopback hop wins: hops further left
 * were supplied by the client and can be forged.
 */
export function clientIp(c: Context): string | null {
  const peer = socketPeer(c);
  if (!peer || !isLoopback(peer)) return peer;

  const hops = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map(normalizeIp)
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isLoopback(hops[i])) return hops[i];
  }
  return peer;
}

/** Loopback or tailnet. An unknown client (null) is never allowlisted. */
export function ipAllowlisted(ip: string | null, tailscalePrefix: string): boolean {
  if (!ip) return false;
  return isLoopback(ip) || (tailscalePrefix.length > 0 && ip.startsWith(tailscalePrefix));
}
