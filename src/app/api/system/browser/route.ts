import { z } from "zod";
import { handler, rateLimit, readJson } from "@/server/api";
import { browserStatus, startBrowserInstall, testBrowser } from "@/server/fetcher/browser-setup";
import { audit } from "@/server/repo/events";

export const dynamic = "force-dynamic";

/** Browser mode set-up: which browser runs, whether it is installed, and the install's progress. */
export const GET = handler(async () => browserStatus());

const schema = z.object({ action: z.enum(["install", "test"]) });

export const POST = handler(async (req) => {
  const { action } = await readJson(req, schema);
  if (action === "install") {
    rateLimit("browser:install", 3, 1);
    audit("browser.install_started", {});
    return startBrowserInstall();
  }
  rateLimit("browser:test", 10, 2);
  return { test: await testBrowser(), status: browserStatus() };
});
