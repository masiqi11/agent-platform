import { RetryLater } from "../core/jobs";
import type { Services } from "../services";

/** Registers every module's consumers, job handlers and cron jobs. Grows per stage. */
export async function registerHandlers(s: Services): Promise<void> {
  s.consumers.register(s.inbox.consumer);
  s.consumers.register(s.captain.consumer);
  s.consumers.register(s.devAgent.consumer);
  s.consumers.register(s.delivery.consumer);
  s.jobs.register(
    "dev.turn",
    async (p, { job }) => {
      await s.devAgent.turn(p as Parameters<typeof s.devAgent.turn>[0], job.traceId ?? job.id);
    },
    30 * 60_000,
  );
  s.jobs.register("ci.local_run", async (p) => {
    await s.workspaces.runLocalCi(p as Parameters<typeof s.workspaces.runLocalCi>[0]);
  });
  s.jobs.register("ci.poll", async (p, { job }) => {
    const r = await s.workspaces.pollCi(p as Parameters<typeof s.workspaces.pollCi>[0]);
    // Polling fallback: keep checking (bounded by the job's age) until the pipeline is terminal.
    if (!r.done && Date.now() - job.createdAt.getTime() < 6 * 3600_000) throw new RetryLater(30_000, "pipeline not finished");
  });
  s.jobs.register("issue.sync", async (p) => {
    await s.delivery.syncIssue(String((p as { taskId: string }).taskId));
  });
  s.jobs.register("task.cleanup", async (p) => {
    await s.delivery.cleanupCancelled(String((p as { taskId: string }).taskId));
  });
  s.jobs.register("workspace.sweep", async () => {
    await s.workspaces.sweep();
    await s.devAgent.sweep();
  });
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
  await s.jobs.enqueue("workspace.sweep", {}, { cron: "every:600000", dedupeKey: "cron:workspace.sweep", runAt: new Date(Date.now() + 60_000) });
}
