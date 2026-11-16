import type { Services } from "../services";

/** Registers every module's consumers, job handlers and cron jobs. Grows per stage. */
export async function registerHandlers(s: Services): Promise<void> {
  s.consumers.register(s.inbox.consumer);
  // Timers: proposal expiry/reminders, approval timeouts, blocked-task escalation (working hours).
  s.jobs.register("flow.sweep", async () => {
    await s.proposals.sweep();
    await s.approvals.sweep();
  });
  await s.jobs.enqueue("flow.sweep", {}, { cron: "every:60000", dedupeKey: "cron:flow.sweep" });
}
