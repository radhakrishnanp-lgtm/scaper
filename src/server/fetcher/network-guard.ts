import "server-only";
import dns from "node:dns/promises";
import net from "node:net";
import { FetchError } from "./errors";

function isPrivateIPv4(ip: string) {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function isPrivateIPv6(ip: string) {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("::ffff:")) return isPrivateIPv4(v.slice(7));
  return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

export function isPrivateAddress(ip: string) {
  return net.isIPv4(ip) ? isPrivateIPv4(ip) : net.isIPv6(ip) ? isPrivateIPv6(ip) : false;
}

/**
 * Stops the scraper (and the AI agent, which can pick URLs) from reaching
 * localhost, your router or cloud metadata endpoints unless you allow it in Settings.
 * This matters most once Scaper runs on a VPS.
 */
export async function assertPublicUrl(url: string, allowPrivate: boolean) {
  if (allowPrivate) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new FetchError("private", "Local and private network addresses are blocked. Turn on \"Allow private network\" in Settings to scrape them.");
  }
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) {
    throw new FetchError("private", `${host} points to a private network address, which is blocked by default. You can allow it in Settings.`);
  }
}
