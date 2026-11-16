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

export interface ServiceOptions {
  /** Worker/consumer owner id (unique per process). */
  owner?: string;
  db?: Database;
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
    addRedactionValue,
  };
  return base;
}
export type Services = ReturnType<typeof createServices>;
