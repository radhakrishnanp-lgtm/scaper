export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SCAPER_SCHEDULER === "off") return;
  const { startScheduler } = await import("./server/scheduler");
  startScheduler();
}
