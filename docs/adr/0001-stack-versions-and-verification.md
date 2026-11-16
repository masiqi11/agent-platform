# ADR-0001 技术栈版本与 §5.1 验证项（V1–V10）

- 状态：已接受（2026-11-16）
- 背景：§5.1 指定了全部依赖版本，并要求在 S0 对 V1–V10 风险点做验证。

## 版本（全部按文档锁定，无偏离）

| 组件 | 版本 |
| --- | --- |
| Bun | 1.4.4 |
| Turborepo | 2.11.11 |
| TypeScript | 7.0.2 |
| Elysia | 2.0.0-rc.3（@elysia/openapi 2.0.0-rc.1、@elysia/cors 2.0.0-rc.1、@elysia/static 2.0.0-rc.0） |
| typebox | 1.4.7 |
| drizzle-orm / drizzle-kit | 1.0.0-rc.5 |
| Postgres | 16.16 + pgvector 0.8.7（本机真实实例） |
| better-auth | 1.7.25 |

额外引入的对等依赖：`exact-mirror`、`openapi-types`（Elysia 2 rc 的 peer，缺失时启动报错）。

## 验证结果

| 编号 | 内容 | 结果 | 证据 |
| --- | --- | --- | --- |
| V1 | Eden treaty 端到端类型 | 待 S1 前端接入后补 | — |
| V2 | TS 7 `tsc` 对整个 monorepo 类型检查 | ✅ 服务端 `tsc -p` 0 错误 | `bun run typecheck` |
| V3 | drizzle ALS 事务上下文 | ✅ | `test/kernel.test.ts` |
| V4 | better-auth 挂载到 Elysia（`/api/auth/*`，`parse: "none"`） | ✅ | `test/identity.test.ts` |
| V5 | Elysia WebSocket | ✅ 需 `.use(websocket())`（`elysia/websocket`），否则构建路由时报错 | `test/realtime.test.ts` |
| V6 | 子进程进程组终止 | 待 S5 | — |
| V7 | LISTEN/NOTIFY 跨连接 | ✅ | `test/kernel.test.ts`、`test/realtime.test.ts` |
| V8 | 连接池空闲断开不崩溃（TRAP-12） | ✅ | `test/kernel.test.ts` |
| V9 | 手写迁移不被 `drizzle-kit generate` 覆盖 | ✅ 生成器输出 "No schema changes" | 手工验证 |
| V10 | 原始请求体（Webhook 验签） | ✅ `parse: "none"` 可拿到原始体 | 探针 |

## Elysia 2 rc 与文档示例的差异（实现时遵循的写法）

- 路由签名为 `(path, hook, handler)`，hook 在 handler **之前**；旧顺序直接抛错。
- `derive` 需要显式作用域 `"plugin"` 才能传播到 `.use()` 它的模块。
- 错误类：`ValidationError`、`ParseError`、`NotFound`（不是 `NotFoundError`），在 `onError` 中用 `instanceof` 判定。

## better-auth 1.7 注意点

- 邮箱注册路径会吞掉 DB hook 中抛出的错误（防枚举，返回伪成功）。因此自助注册闸门（§9.4 signup mode）放在 `hooks.before` 中间件里，DB hook 仍保留作为 OIDC 路径的纵深防御。
- 撤销会话用 `internalAdapter.deleteUserSessions(userId)`。
