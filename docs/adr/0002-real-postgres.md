# ADR-0002 测试与开发使用真实 Postgres 16

- 状态：已接受（2026-11-16）
- 决定：开发与测试均使用本机真实 PostgreSQL 16.16 + pgvector 0.8.7；每个测试文件创建独立数据库并迁移（`test/helpers.ts`）。未使用 PGlite，因此无需 PGlite 偏离说明。
- 安装：Debian 镜像不可用时改用 `mirror.leaseweb.net` + PGDG `trixie-pgdg`。
- 凭据只存在于被 gitignore 的 `apps/server/.env`；仓库只提供 `.env.example`。
