# 多 Agent 多人协作开发平台

人和 AI Agent 在同一个项目群里协作：讨论需求 → 船长 Agent 提议任务 → 开发 / 评审 / 测试 Agent 执行 → 人审批合并，全程可审计。
设计与需求见 [`docs/DEV-SPEC-v0.3.md`](docs/DEV-SPEC-v0.3.md)，进度见 [`docs/PROGRESS.md`](docs/PROGRESS.md)。

## 当前状态

已完成阶段 S0–S5（身份/内核、项目群聊、任务看板审批收件箱、模型层与船长、代码执行链路）与 S6（评审、测试、门禁、合并队列：主场景十步在脚本模型 + 本地仓库下全自动通过，第 4–8 步已在真实 GitLab CE + Runner 上通过）；S7 知识库主体已完成（代码/文档/决策索引、三路混合检索、带引用的项目船长与全局船长跨项目问答；30 题评测 `bun run kb:eval`）；S8–S9（生产化、钉钉）尚未开始。详见 `docs/PROGRESS.md`。

## 技术栈

Bun 1.4 · Turborepo · TypeScript 7 · Elysia 2（rc）· drizzle 1.0（rc）· PostgreSQL 16 + pgvector · better-auth · React 19 · TanStack Router/Query · Eden treaty · Tailwind v4 + shadcn/ui · oxlint/oxfmt · bun test + Playwright。版本与偏差记录在 `docs/adr/`。

## 快速开始

前置：Bun ≥ 1.4、PostgreSQL 16（带 pgvector 更好）。

```bash
bun install

# 1. 准备数据库（任选其一）
docker compose -f deploy/docker-compose.dev.yml up -d      # 用 Docker 起 Postgres
# 或使用已有的 Postgres，自建库：createdb agent_platform

# 2. 配置环境变量
cp apps/server/.env.example apps/server/.env
#   编辑 DATABASE_URL、AUTH_SECRET（≥32 位随机串）、VAULT_MASTER_KEY 等；不要把真实密钥提交到仓库

# 3. 迁移并启动（API + worker + Vite 开发服务器）
bun run migrate
bun run dev
```

打开 <http://localhost:5173>，首次访问会进入「首启引导」创建团队与第一个管理员。开发环境登录页提供一键登录。

## 常用命令

| 命令                                          | 作用                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `bun run dev`                                 | 启动服务端（API + worker）与前端开发服务器                                                                |
| `bun run build`                               | 构建全部包（前端产物由服务端静态托管）                                                                    |
| `bun run start`                               | 生产方式启动（`ROLE=api` / `worker` / `all`）                                                             |
| `bun run typecheck` / `lint` / `format:check` | 质量检查                                                                                                  |
| `bun run test`                                | 单元与集成测试（需要 `TEST_DATABASE_URL` 指向可建库的 Postgres）                                          |
| `bun run e2e`                                 | Playwright 端到端（自动建临时库 `agent_platform_e2e`，需先 `bun run build`）                              |
| `bun run seed`                                | 写入 S5 演示项目 DPAY / DBILL（本地仓库 + dev/reviewer/tester Agent；需 `DATABASE_URL`、`SEED_PASSWORD`） |
| `bun run kb:eval`                             | 知识库评测：建索引后对演示项目 30 题算 recall@5（需 `DATABASE_URL`、`SEED_PASSWORD`；先 `bun run seed`）  |
| `bun run --cwd apps/server seed:demo`         | 写入【演示数据】项目（需 `DATABASE_URL`、`SEED_PASSWORD`），仅用于体验与截图                              |
| `bun run audit:verify`                        | 校验审计哈希链                                                                                            |

## 本地模型（可选）

真实模型测试使用本机 Ollama 的 `gemma4:e2b`（CPU，关闭思考），理由与基准见 `docs/adr/0003-local-llm-gemma4-e2b.md`。CI 和默认测试使用脚本化模型，不依赖任何外部模型。

- **不配置任何模型**：租户默认模型是 `scripted:demo`（脚本化船长，会追问、提议、写摘要），可直接体验全部流程。
- **接入本机 Ollama**：在 `apps/server/.env` 设置 `LLM_BASE_URL=http://127.0.0.1:11434`、`LLM_MODEL=gemma4:e2b`。端口 11434 自动使用 Ollama 原生 `/api/chat` 并关闭思考。也可以在「管理 → 模型与预算」里登记供应商、测试连通性、设租户默认模型、设预算、一键暂停所有 Agent。
- **真实模型场景**（不在 CI 中）：`cd apps/server && bun test/ollama/s4-scenario.ts`，需要 `TEST_DATABASE_URL` 与 Ollama；结果写入 `docs/results/s4-ollama.json`，区分模型原生结果与兜底结果。
- 设计取舍见 `docs/adr/0005-s4-model-layer-and-captain.md`。

## 代码执行（S5）

- **仓库**：在「项目 → 仓库」绑定。本地仓库（开发/演示/离线）建在 `DATA_DIR/local-scm` 下，Issue、MR、CI 由平台模拟；GitLab 需要项目地址与 Developer 级令牌（`api` scope），绑定前做连通性与权限检查，绑定后只显示一次 webhook 地址与密钥。GitLab 适配器目前只用假服务验证过。
- **沙箱**：开发默认 `SANDBOX=process`（子进程，无网络隔离，仅开发用）；生产必须 `SANDBOX=docker`，并设置 `SANDBOX_IMAGE`。沙箱里没有任何平台凭据，推送由控制面在沙箱外完成。
- **体验主流程前半段**：`SEED_PASSWORD=… bun run seed` 后用 `owner@xinghe.test` 登录，在「支付服务」主群 @船长 说“支付服务最近超时，帮我查一下”，确认提议后开发 Agent 会在 `task/<编号>` 分支上修复、推送、开 MR；评审 Agent 提两条意见，开发 Agent 返工；评审通过后测试 Agent 在独立环境测试；之后在「收件箱」批准合并审批，合并队列完成合并、关闭 Issue，船长在群里发完成摘要。全程不需要模型密钥（脚本模型）。
- 设计取舍见 `docs/adr/0006-s5-code-execution.md`、`docs/adr/0007-s6-review-test-merge.md`。
- **知识库**：`bun run seed` 后仓库在后台建索引。项目「知识库」页可问项目船长、看三路检索如何命中；工作台「问全局船长」问“超时相关的计费逻辑在哪个仓库哪个文件”，会询问计费服务的船长并给出可点击的引用。演示用确定性嵌入 `scripted:embed`。**换真实嵌入模型**：本地起 Ollama 并拉取 `embeddinggemma`（多语言，768 维，推荐）或 `nomic-embed-text`，在「管理 → 模型与预算」登记供应商、用途选「嵌入模型」，再在「知识库嵌入」里切换，所有索引会后台全量重建。对比评测：`OLLAMA_URL=… EMBED_MODEL=embeddinggemma bun test/kb/embed-eval.ts`（在 `apps/server` 下运行）。
- **真实 GitLab 实测**：`scripts/gitlab-local.sh up` 在 docker 里起 GitLab CE + Runner（约 4 GB 内存，首次启动 3–5 分钟），建好演示项目、受保护分支（推送 Maintainers、合并 Developers + Maintainers）、Developer 项目令牌和 Runner，并打印运行 `test/gitlab/s6-gitlab.ts` 的命令；`down` 删除容器。也可以对已有 GitLab 用手动工作流 `gitlab-e2e`（仓库密钥 `GITLAB_E2E_URL` / `GITLAB_E2E_TOKEN`）。

## 目录

```
apps/server   Elysia 服务端：路由、领域模块、内核（事件/作业/审计/凭据）、实时 WS
apps/web      React 前端：页面、组件、Playwright 用例
packages/shared  前后端共享：权限矩阵、状态机、事件与契约
deploy/       docker compose 与环境变量示例
docs/         开发文档、ADR、进度、基准数据
screenshots/  Playwright 生成的明暗主题截图
```
