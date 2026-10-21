import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkRobots, detectBotWall, parseRetryAfter, withHostTurn } from "@/server/fetcher/politeness";
import { isPrivateAddress } from "@/server/fetcher/network-guard";

describe("bot-wall detection", () => {
  it("recognises an Amazon robot check and stops", () => {
    expect(detectBotWall(fs.readFileSync(path.join(__dirname, "fixtures", "captcha.html"), "utf8"), 200)).toMatch(/robot check/);
  });
  it("recognises 429 and ignores normal pages", () => {
    expect(detectBotWall("<p>ok</p>", 429)).toMatch(/429/);
    expect(detectBotWall("<p>ok</p>", 200)).toBeNull();
  });
});

describe("per-host turns", () => {
  it("spaces requests to the same host", async () => {
    const times: number[] = [];
    const task = async () => { times.push(Date.now()); };
    await Promise.all([withHostTurn("a.test", 150, task), withHostTurn("a.test", 150, task), withHostTurn("a.test", 150, task)]);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(110);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(110);
  });
  it("runs different hosts in parallel", async () => {
    const started = Date.now();
    await Promise.all(["b1.test", "b2.test", "b3.test"].map((h) => withHostTurn(h, 1000, async () => undefined)));
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("robots.txt", () => {
  const robots = "User-agent: *\nDisallow: /private\nCrawl-delay: 7\n\nUser-agent: Scaper\nDisallow: /no-scaper";
  const fetchText = async () => ({ status: 200, text: robots });
  it("allows and disallows by path and agent", async () => {
    expect(await checkRobots("https://r1.test/public", "Scaper", fetchText)).toMatchObject({ allowed: true });
    expect((await checkRobots("https://r1.test/no-scaper/x", "Scaper", fetchText)).allowed).toBe(false);
    expect((await checkRobots("https://r2.test/private/x", "Other", fetchText))).toMatchObject({ allowed: false, crawlDelaySeconds: 7 });
  });
  it("treats a missing file as allow-all and a 5xx as disallow", async () => {
    expect((await checkRobots("https://r3.test/x", "Scaper", async () => ({ status: 404, text: "" }))).allowed).toBe(true);
    expect((await checkRobots("https://r4.test/x", "Scaper", async () => ({ status: 503, text: "" }))).allowed).toBe(false);
  });
});

describe("helpers", () => {
  it("parses Retry-After", () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
  it("detects private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "142.250.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("decodeBody", async () => {
  const { decodeBody } = await import("@/server/fetcher/http");
  it("uses the declared charset", () => {
    expect(decodeBody(Buffer.from("₹100"), "text/html; charset=utf-8")).toBe("₹100");
    expect(decodeBody(Buffer.from([0xa3, 0x35]), "text/html; charset=iso-8859-1")).toBe("£5");
    expect(decodeBody(Buffer.from('<meta charset="iso-8859-1"><p>\xa3</p>', "latin1"), null)).toContain("£");
  });
});
