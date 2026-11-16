import type { Services } from "../services";

/** Registers every module's consumers, job handlers and cron jobs. Grows per stage. */
export async function registerHandlers(s: Services): Promise<void> {
  s.consumers.register(s.inbox.consumer);
  s.consumers.register(s.captain.consumer);
  s.jobs.register("captain.turn", async (p, { job }) => {
    await s.captain.turn(p as Parameters<typeof s.captain.turn>[0], job.traceId ?? job.id);
  });
  s.jobs.register("captain.summary", async (p, { job }) => {
    await s.captain.summarize(p as Parameters<typeof s.captain.summarize>[0], job.traceId ?? job.id);
  });
  // Timers: proposal expiry/reminders, approval timeouts, blocked-task escalation (working hours).
  s.jobs.register("flow.sweep", async () => {
    await s.proposals.sweep();
    await s.approvals.sweep();
    await s.captain.sweep();
  });
  await s.jobs.enqueue("flow.sweep", {}, { cron: "every:60000", dedupeKey: "cron:flow.sweep" });
}
