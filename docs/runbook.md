# 运维手册

首次部署见 `deploy.md`。本手册的命令默认在部署目录 `deploy/` 下执行。容器内命令格式为：

```bash
docker compose exec app bun <脚本>
```

`<脚本>` 的路径相对于镜像中的 `/app`。

## 日常看什么

「系统状态」页（管理员）和 `/metrics` 中的关键项：

| 指标 / 页面                                                          | 正常   | 关注              | 处理                                        |
| -------------------------------------------------------------------- | ------ | ----------------- | ------------------------------------------- |
| 事件消费延迟 `ap_event_consumer_lag`                                 | < 50   | > 500 持续 5 分钟 | 见「任务卡住」                              |
| 死信 `ap_dead_letters_open`                                          | 0      | > 0               | 见「死信」                                  |
| 作业积压 `ap_jobs{status="queued"}`                                  | < 200  | 持续增长          | worker 是否在运行、`WORKER_CONCURRENCY`     |
| 合并队列最久等待 `ap_merge_queue_oldest_wait_seconds`                | < 3600 | > 3600            | 见「合并队列卡住」                          |
| 模型失败与降级 `ap_llm_calls{status!="ok"}`、`ap_llm_fallback_calls` | 低     | 快速增长          | 供应商熔断、key、预算                       |
| 沙箱超时 `ap_sandbox_exec_total{outcome="timeout"}`                  | 偶发   | 持续              | 仓库测试变慢或卡死；调 `SANDBOX_TIMEOUT_MS` |
| 磁盘水位（系统状态）                                                 | < 80%  | > 90%             | 见「磁盘满」                                |
| 沙箱（系统状态）                                                     | 无警告 | 有警告            | 执行 `deploy/sandbox-firewall.sh`           |

## 备份与恢复

**备份**：启用 `docker compose --profile backup up -d` 后每天执行一次，保留 30 天，备份写入 `deploy/backups/<UTC 时间>/`。也可以手动执行：

```bash
DATABASE_URL=… ARTIFACTS_DIR=$DATA_PATH/artifacts BACKUP_DIR=/backups deploy/backup.sh
```

**恢复流程**（顺序不能乱）：

1. 停止应用，或者准备一个新的空库：

   ```bash
   docker compose stop app
   createdb …
   ```

2. 恢复备份：

   ```bash
   DATABASE_URL=<目标库> ARTIFACTS_DIR=$DATA_PATH/artifacts deploy/restore.sh deploy/backups/<时间>
   ```

   脚本会先校验 SHA256SUMS，再执行 `pg_restore`，然后解压产物。

3. 迁移：`docker compose run --rm migrate`
4. 审计链校验：`docker compose exec app bun apps/server/src/cli/audit-verify.ts`。每个租户都应输出 `OK`。
5. 冒烟测试：
   - `curl /readyz` 返回 `ok:true`；
   - 用管理员账号登录，能看到项目；
   - 「系统状态」各项正常。
6. 恢复后的凭据必须能用**同一个** `MASTER_KEY` 解密。可以用「模型与预算 → 连通性测试」检查，或者执行 `bun run rekey`：它会逐个解密，遇到无法解密的凭据就报错。

**演练**：

```bash
PG_URL=… scripts/restore-drill.sh docs/results/restore-drill.json
```

这个脚本在一次性数据库上自动跑完上述全部步骤。2026-11-17 演练通过。建议每季度演练一次。

## 主密钥轮换

1. 生成新密钥，写入 `MASTER_KEY_V2`，**保留** `MASTER_KEY`；然后重启：`docker compose up -d app`。新写入的凭据从此用 v2 加密。
2. 重加密已有凭据：

   ```bash
   docker compose exec app bun apps/server/src/cli/rekey.ts
   ```

   输出中的 `remaining` 必须为 0，`failed` 必须为空。它会先验证能解密，再保存，可以重复执行。

3. 确认「模型与预算」的连通性测试、仓库检查都正常。
4. 新旧两个密钥都存进密码库。只要还有备份里的凭据是用 v1 加密的，`MASTER_KEY` 就**不能删**。

`JWT_SECRET` 的轮换方式：把旧值放进 `JWT_SECRET_PREVIOUS`，在 `JWT_SECRET` 中填入新值，重启；等最长的 Agent 令牌过期后（`AGENT_TOKEN_TTL_SEC`，默认 1 小时），再删掉旧值。

## 死信

事件或作业重试到上限后会进入死信。处理方式：

1. 「系统状态 → 死信」中查看错误摘要。用记录的时间去日志里查完整堆栈；也可以在「链路追踪」中查看同一追踪标识下的所有记录。
2. 修复原因（配置、外部服务、代码），然后点**重放**：作业会重新入队，事件会立即交给原消费者重跑。如果仍然失败，这条死信保持打开，并更新错误信息。
3. 确定不需要再处理的，点**丢弃**并写明原因。丢弃会写入审计。

## 任务卡住的排查路径

按顺序排查：

1. **门禁清单**：任务详情里的「门禁」显示还缺什么（评审、测试、审批，以及是否需要人工评审）。卡在缺条件上的不是故障。
2. **事件消费延迟**：「系统状态 → 事件消费者」。某个消费者延迟持续增长，说明它在处理某个事件时出错。看它的「最近错误」和死信。
3. **作业**：同页的作业积压。再在「链路追踪」中输入任务 ID，看该任务最近的作业状态：排队、运行、失败还是死信。
4. **会话**：「会话」页找到该任务的 Agent 会话，看停止原因，例如 `max_steps`、`wall_clock`、`loop_detected`、`llm_unavailable`、`harness_failed`。会话转录里能看到每一步。
5. **模型调用**：会话里的模型调用记录，或用 `/metrics` 看 `ap_llm_calls` 中的失败。供应商熔断、预算用尽（任务会被阻塞并注明原因）、key 失效（「连通性测试」）。

可用的人工手段：

- 在任务上「接管」，由人类操作；之后再「交还」给 Agent。
- 在会话页「取消会话」。
- 把任务改为阻塞并写明原因。

## 合并队列卡住

「项目 → 仓库」页的「合并队列」区块查看队首条目的状态：

- **`waiting_ci`**：在等 rebase 之后的 CI。去 GitLab 看该流水线。流水线超时后，平台会标记失败并通知。
- **`needs_human`**：rebase 有冲突，或者 CI 失败。按页面提示处理冲突（在任务分支解决后会重新入队），或者把该条目移出队列。
- **队首长时间不动且没有错误**：看「链路追踪」中合并相关的作业是否进了死信；GitLab 不可达会让仓库进入 `unreachable` 状态（在「仓库」页查看）。

## 磁盘满

1. 「系统状态 → 工作区磁盘」，或执行 `du -sh $DATA_PATH/*`。通常是 `workspaces/`、`repo-cache/` 或 `artifacts/` 占用最多。
2. **工作区**：任务完成或取消后自动回收（每 10 分钟清理一次）。残留的大目录对应仍在进行的任务，不要手动删。
3. **孤儿容器**：会被自动清理。如需手动清理：`docker ps -a --filter label=ap.sandbox=1`。
4. **启用保留期清理**：设置 `RETENTION_ENABLED=true`。它会归档并删除旧事件，删除已完成或失败的作业、已处理的死信、早已结束任务的会话转录，以及过期的登录会话。每次清理都写审计；审计日志本身不会被清理。
5. **数据库磁盘满**：先扩容，再考虑上一步的清理。不要直接删表数据，审计表有只追加的保护触发器。

## 暂停所有 Agent

在「模型与预算」页顶部的「一键暂停」中执行全局暂停（写审计），或者在 `deploy/.env` 中设置 `AGENTS_PAUSED=true` 后重启。

- 暂停后：新的唤醒不会再运行；正在运行的一轮会在下一个检查点停下；人与人之间的对话和只读操作不受影响。
- 恢复：解除暂停即可，被搁置的唤醒会继续执行。

## 升级与回滚

1. **备份**：执行 `deploy/backup.sh`，或者确认当天的自动备份已完成。
2. **拉取新版本**：

   ```bash
   git fetch --tags && git checkout vX.Y.Z
   ```

   阅读发布说明：是否有迁移、配置变更、破坏性变更。

3. **构建并迁移**：

   ```bash
   docker compose build && docker compose run --rm migrate
   ```

   迁移持有 advisory lock，多个迁移进程同时运行也是安全的。

4. **启动**：`docker compose up -d app`。停机期间，正在运行的作业最多等 25 秒完成，之后被释放给新实例继续。
5. **冒烟检查**：`/readyz` 返回 `ok:true` 且迁移版本与代码一致；能登录；「系统状态」各项正常。
6. **审计链校验**：`docker compose exec app bun apps/server/src/cli/audit-verify.ts`。

**回滚** = 恢复升级前的备份 + 检出上一个版本标签重新构建。迁移只有向前的脚本，所以不能只回滚镜像而保留新版本的库。

## 钉钉（IM）

- **钉钉群收不到回复**：
  1. 先看项目「IM 群」页，确认绑定状态和出站计数（已发 / 待发 / 死信）；
  2. 死信在「系统状态 → 死信」中，错误摘要会说明是钉钉接口错误还是限流；
  3. 修复后可以重放。
- **绑定显示“已失效”**：机器人被移出群、群解散，或应用权限被回收。把机器人拉回群后 `/bind 项目标识` 即可，原绑定记录会被复用。
- **群里 @机器人 没反应**：日志里应有 `im.stream.lease_acquired`，表示有实例持有 Stream 连接。没有的话检查 `DINGTALK_*` 配置与出站网络（`api.dingtalk.com`）。连接断开后会自动重连，并由其他实例接手。
- 细节见 `im.md`。

## 多实例

条件和逐项验证见 `multi-instance.md`。要点：

- 所有实例共享同一个 `DATA_PATH`；
- 必须接 GitLab，不能用演示用的本地 Git；
- 实例可按 `ROLE=api` 和 `ROLE=worker` 拆分。
