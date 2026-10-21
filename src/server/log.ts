import "server-only";

type Level = "debug" | "info" | "warn" | "error";

const SECRET_KEYS = /key|token|secret|password|authorization/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

/** Structured JSON logs on stdout. Secrets are redacted by key name. */
function write(level: Level, event: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...(redact(data ?? {}) as object) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (e: string, d?: Record<string, unknown>) => {
    if (process.env.SCAPER_DEBUG) write("debug", e, d);
  },
  info: (e: string, d?: Record<string, unknown>) => write("info", e, d),
  warn: (e: string, d?: Record<string, unknown>) => write("warn", e, d),
  error: (e: string, d?: Record<string, unknown>) => write("error", e, d),
};
