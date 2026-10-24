import "server-only";
import path from "node:path";
import { z } from "zod";

const schema = z
  .object({
    SCAPER_DATA_DIR: z.string().default("./data"),
    SCAPER_APP_PASSWORD: z.string().optional().default(""),
    SCAPER_SESSION_SECRET: z.string().optional().default(""),
    PLAYWRIGHT_EXECUTABLE_PATH: z.string().optional().default(""),
    SCAPER_SCHEDULER: z.enum(["on", "off"]).default("on"),
    SCAPER_ALLOWED_HOSTS: z.string().optional().default(""),
    // Where you open Scaper, for links in alerts (bot approvals, bot pages).
    SCAPER_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
    // Google endpoints for Sheets sync (overridable for tests and corporate proxies).
    SCAPER_GOOGLE_TOKEN_URL: z.string().url().default("https://oauth2.googleapis.com/token"),
    SCAPER_SHEETS_API_URL: z.string().url().default("https://sheets.googleapis.com/v4"),
  })
  .superRefine((v, ctx) => {
    if (v.SCAPER_APP_PASSWORD && v.SCAPER_SESSION_SECRET.length < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["SCAPER_SESSION_SECRET"],
        message: "must be at least 32 characters when SCAPER_APP_PASSWORD is set",
      });
    }
  });

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\nSee .env.example.`);
  }
  return { ...parsed.data, dataDir: path.resolve(parsed.data.SCAPER_DATA_DIR) };
}

export const env = load();
