import { createAuth, type Auth } from "./auth";
import type { Config } from "./config";
import { createDatabase, type Database } from "./db";
import { createAudit } from "./core/audit";
import { createVault } from "./core/crypto";
import { createConsumerRunner, createEvents } from "./core/events";
import { createIdempotency } from "./core/idempotency";
import { newId } from "./core/ids";
import { createJobs } from "./core/jobs";
import { addRedactionValue, configureLogger } from "./core/logger";
import { createLocalObjectStore, createS3ObjectStore } from "./core/object-store";
import { createRateLimiter } from "./core/rate-limit";
import { createIdentity } from "./modules/identity/service";
import { createRealtime } from "./modules/realtime/service";
import { createAuditQuery } from "./modules/audit/service";
import { createProjects } from "./modules/projects/service";
import { createChat } from "./modules/chat/service";
import { createAgents } from "./modules/agents/service";
import { createTasks } from "./modules/tasks/service";
import { createInbox } from "./modules/inbox/service";
import { createProposals } from "./modules/proposals/service";
import { createApprovals } from "./modules/approvals/service";
import { createLlm } from "./modules/llm/service";
import { createRuntime } from "./modules/runtime/service";
import { createCaptain } from "./modules/captain/service";
import { createSandbox, type Sandbox } from "./modules/sandbox/service";
import { createRepos } from "./modules/repos/service";
import { createWorkspaces } from "./modules/workspaces/service";
import { createDevAgent } from "./modules/devagent/service";
import { createHarness } from "./modules/harness/service";
import { createDelivery } from "./modules/delivery/service";
import { createSystem } from "./modules/system/service";
import { createQuality } from "./modules/quality/service";
import { createQa } from "./modules/qa/service";
import { createMergeQueue } from "./modules/mergequeue/service";
import { createKnowledge } from "./modules/knowledge/service";

export interface ServiceOptions {
  /** Worker/consumer owner id (unique per process). */
  owner?: string;
  db?: Database;
  llm?: import("./modules/llm/service").LlmOptions;
  /** Override the sandbox (tests). */
  sandbox?: Sandbox;
  /** fetch used for SCM REST calls (tests point it at a fake GitLab). */
  scmFetch?: typeof fetch;
}

export function createServices(config: Config, opts: ServiceOptions = {}) {
  configureLogger({
    level: config.logLevel,
    secrets: [config.auth.secret, config.jwt.secret, ...Object.values(config.masterKeys), config.llmBootstrap?.apiKey ?? "", config.dingtalk?.clientSecret ?? "", config.auth.oidc?.clientSecret ?? ""],
  });
  const owner = opts.owner ?? `${process.pid}-${newId("wrk")}`;
  const db = opts.db ?? createDatabase(config.databaseUrl, config.dbPoolMax);
  const events = createEvents(db);
  const audit = createAudit(db);
  const jobs = createJobs(db, { owner });
  const consumers = createConsumerRunner(db, { owner });
  const idempotency = createIdempotency(db);
  const rateLimiter = createRateLimiter(db);
  const vault = createVault(config.masterKeys, config.currentKeyVersion);
  const objectStore = config.s3 ? createS3ObjectStore(config.s3) : createLocalObjectStore(config.dirs.artifacts);
  let auth: Auth | undefined;
  const identity = createIdentity({ config, db, audit, events, rateLimiter, getAuth: () => auth! });
  auth = createAuth(config, db, {
    onUserCreated: (u, g) => identity.onUserCreated(u, g),
    onLogin: identity.onLogin,
    rateLimitLogin: identity.rateLimitLogin,
  });
  const realtime = createRealtime({ db, identity });
  const auditQuery = createAuditQuery({ db, audit, identity });

  const projects = createProjects({ db, audit, events, identity });
  const chat = createChat({ config, db, audit, events, identity, projects, objectStore, rateLimiter });
  const agents = createAgents({ db, audit, events, identity, projects });
  const tasks = createTasks({ db, audit, events, identity, projects, chat });
  const inbox = createInbox({ db, events, identity });
  const proposals = createProposals({ db, audit, events, identity, projects, chat, tasks, inbox });
  const approvals = createApprovals({ db, audit, events, identity, projects, tasks, inbox });
  const llm = createLlm({ config, db, audit, events, identity, vault }, opts.llm);
  const runtime = createRuntime({ config, db, audit, events, identity, owner });
  const captain = createCaptain({ config, db, audit, events, jobs, identity, projects, chat, tasks, proposals, inbox, llm, runtime, realtime });
  proposals.hooks.afterAccept = (ctx, p, ids) => captain.afterAccept(ctx, p, ids);
  const sandbox = opts.sandbox ?? createSandbox(config);
  const repos = createRepos({ config, db, audit, events, identity, projects, vault, fetch: opts.scmFetch });
  const workspaces = createWorkspaces({ config, db, audit, events, identity, repos, sandbox, objectStore, jobs });
  const harness = createHarness({ config, db, sandbox, runtime, llm });
  const devAgent = createDevAgent({ config, db, audit, events, jobs, identity, tasks, repos, workspaces, llm, runtime, harness });
  const delivery = createDelivery({ config, db, audit, events, jobs, identity, repos, workspaces });
  const system = createSystem({ db, identity, audit, sandbox, workspaces, jobs, consumers });
  const quality = createQuality({ db, audit, events, identity, tasks, approvals, repos });
  const qa = createQa({ db, audit, events, jobs, identity, tasks, repos, workspaces, quality, llm, runtime, sandbox, objectStore, harness });
  const mergeQueue = createMergeQueue({ config, db, audit, events, jobs, identity, tasks, repos, workspaces, delivery, quality, inbox });
  quality.hooks.enqueueMerge = (ctx, t, sha) => mergeQueue.enqueue(ctx, t, sha);
  quality.hooks.dequeue = (ctx, taskId, reason) => mergeQueue.dequeue(ctx, taskId, reason);
  mergeQueue.hooks.afterMerged = (ctx, taskId) => captain.completionSummary(ctx, taskId);
  const knowledge = createKnowledge({ config, db, audit, events, jobs, identity, projects, repos, workspaces, llm, runtime });
  captain.kbHooks.federated = (ctx, q) => knowledge.federated(ctx, q);

  const base = {
    config,
    db,
    owner,
    events,
    audit,
    jobs,
    consumers,
    idempotency,
    rateLimiter,
    vault,
    objectStore,
    identity,
    auth,
    realtime,
    auditQuery,
    projects,
    chat,
    agents,
    tasks,
    inbox,
    proposals,
    approvals,
    llm,
    runtime,
    captain,
    sandbox,
    repos,
    workspaces,
    devAgent,
    harness,
    delivery,
    system,
    quality,
    qa,
    mergeQueue,
    knowledge,
    addRedactionValue,
  };
  return base;
}
export type Services = ReturnType<typeof createServices>;
