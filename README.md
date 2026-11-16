# 多 Agent 多人协作开发平台

人和 AI Agent 在同一个项目群里协作：讨论需求 → 船长 Agent 提议任务 → 开发 / 评审 / 测试 Agent 执行 → 人审批合并，全程可审计。
设计与需求见 [`docs/DEV-SPEC-v0.3.md`](docs/DEV-SPEC-v0.3.md)，进度见 [`docs/PROGRESS.md`](docs/PROGRESS.md)。

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

| 命令                                          | 作用                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `bun run dev`                                 | 启动服务端（API + worker）与前端开发服务器                                   |
| `bun run build`                               | 构建全部包（前端产物由服务端静态托管）                                       |
| `bun run start`                               | 生产方式启动（`ROLE=api                                                      | worker | all`） |
| `bun run typecheck` / `lint` / `format:check` | 质量检查                                                                     |
| `bun run test`                                | 单元与集成测试（需要 `TEST_DATABASE_URL` 指向可建库的 Postgres）             |
| `bun run e2e`                                 | Playwright 端到端（自动建临时库 `agent_platform_e2e`，需先 `bun run build`） |
| `bun run --cwd apps/server seed:demo`         | 写入【演示数据】项目（需 `DATABASE_URL`、`SEED_PASSWORD`），仅用于体验与截图 |
| `bun run audit:verify`                        | 校验审计哈希链                                                               |

## 本地模型（可选）

真实模型测试使用本机 Ollama 的 `gemma4:e2b`（CPU，关闭思考），理由与基准见 `docs/adr/0003-local-llm-gemma4-e2b.md`。CI 和默认测试使用脚本化模型，不依赖任何外部模型。

## 目录

```
apps/server   Elysia 服务端：路由、领域模块、内核（事件/作业/审计/凭据）、实时 WS
apps/web      React 前端：页面、组件、Playwright 用例
packages/shared  前后端共享：权限矩阵、状态机、事件与契约
deploy/       docker compose 与环境变量示例
docs/         开发文档、ADR、进度、基准数据
screenshots/  Playwright 生成的明暗主题截图
```
