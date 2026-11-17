import { log } from "../core/logger";
import { RetryLater } from "../core/jobs";
import type { Services } from "../services";

/** Registers every module's consumers, job handlers and cron jobs. Grows per stage. */
export async function registerHandlers(s: Services): Promise<void> {
  s.consumers.register(s.inbox.consumer);
  s.consumers.register(s.captain.consumer);
  s.consumers.register(s.devAgent.consumer);
  s.consumers.register(s.delivery.consumer);
  s.consumers.register(s.quality.consumer);
  s.consumers.register(s.qa.consumer);
  s.consumers.register(s.mergeQueue.consumer);
  s.consumers.register(s.knowledge.consumer);
  s.consumers.register(s.im.consumer);
  // §12.3 IM gateway: inbound events and outbound deliveries are jobs (retries, dead letters).
  s.jobs.register("im.inbound", async (p, { job }) => {
    await s.im.handleInbound(p as unknown as Parameters<typeof s.im.handleInbound>[0], job.traceId ?? job.id);
  });
  s.jobs.register("im.deliver", async (p, { job }) => {
    await s.im.deliver(String((p as { deliveryId: string }).deliveryId), job);
  });
  s.jobs.register(
    "kb.index",
    async (p) => {
      const x = p as { projectId: string; repoId: string; full?: boolean };
      await s.knowledge.indexRepo({ projectId: x.projectId, repoId: x.repoId, full: Boolean(x.full) });
    },
    30 * 60_000,
  );
  s.jobs.register("kb.warm", async (p) => {
    await s.knowledge.indexWarm(String((p as { projectId: string }).projectId));
  });
  s.jobs.register("kb.weekly", async () => {
    await s.knowledge.weekly();
  });
  s.jobs.register(
    "qa.turn",
    async (p, { job }) => {
      await s.qa.turn(p as Parameters<typeof s.qa.turn>[0], job.traceId ?? job.id);
    },
    30 * 60_000,
  );
  s.jobs.register(
    "merge.process",
    async (p) => {
      await s.mergeQueue.process(String((p as { projectId: string }).projectId));
    },
    30 * 60_000,
  );
  s.jobs.register("ci.sha_run", async (p) => {
    await s.workspaces.runShaPipeline(p as Parameters<typeof s.workspaces.runShaPipeline>[0]);
  });
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
    await s.mergeQueue.sweep();
  });
  await s.jobs.enqueue("flow.sweep", {}, { cron: "every:60000", dedupeKey: "cron:flow.sweep" });
  await s.jobs.enqueue("kb.weekly", {}, { cron: "every:604800000", dedupeKey: "cron:kb.weekly", runAt: new Date(Date.now() + 604_800_000) });
  await s.jobs.enqueue("workspace.sweep", {}, { cron: "every:600000", dedupeKey: "cron:workspace.sweep", runAt: new Date(Date.now() + 60_000) });
  // §8.5 retention: off unless RETENTION_ENABLED; daily, first run an hour after start.
  s.jobs.register("ops.retention", async () => {
    if (!s.config.retention.enabled) return;
    const r = await s.system.retention();
    log.info("retention.done", r);
  });
  if (s.config.retention.enabled) await s.jobs.enqueue("ops.retention", {}, { cron: "every:86400000", dedupeKey: "cron:ops.retention", runAt: new Date(Date.now() + 3_600_000) });
}
