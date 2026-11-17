# 新机器安装验证（S8 退出标准）

- 日期：2026-11-17
- 做法：从干净的 git clone 出发，逐字按 `docs/deploy.md` 操作。使用生产配置（`NODE_ENV=production`、docker 沙箱、https `PUBLIC_URL`），并使用真实镜像构建和真实 compose。

## 结果

| 步骤 | 结果 |
| --- | --- |
| `cp deploy/.env.example deploy/.env`，按文档生成密钥，填写 `DATA_PATH`、`DOCKER_GID` | 通过 |
| `docker compose build` | **发现并修复 2 个问题**（见下），修复后通过 |
| `docker compose up -d`：依次启动 postgres → migrate → app | 通过：`/readyz` 返回 `ok`，迁移版本与代码一致，web 与 worker 都已启动 |
| 创建首个管理员（初始化接口） | 通过 |
| 系统状态 | 数据库、迁移正常；沙箱为 `docker 29.9.2`。说明 app 容器内的 docker CLI 经挂载的 socket（宿主机 docker 组）驱动宿主机 docker |
| 生产行为 | 没有令牌时 `/metrics` 返回 404；返回 HSTS 与 `X-Frame-Options: DENY`；生产配置校验生效 |

## 安装验证中发现并修复的问题

1. **运行镜像里没有 docker CLI**：生产强制使用 docker 沙箱，但应用调用 `docker` 时找不到命令。现在镜像从固定版本的 `docker:29.0.4-cli` 复制 CLI。
2. **沙箱挂载路径**：宿主机 docker 按宿主机路径解析 `-v <工作区>:/workspace`。现在 compose 把数据目录以相同路径挂入 app 容器（`DATA_PATH`），并通过 `group_add` 加入宿主机的 docker 组。
3. **TLS 检查代理下 `bun install` 失败**（`SELF_SIGNED_CERT_IN_CHAIN`）：新增可选的构建 secret `BUILD_CA_FILE`，只在构建时使用，不会进入镜像。
4. **compose 拒绝项目目录外的构建 secret**：连默认的 `/dev/null` 也会被拒绝，这会让**所有人**的 `docker compose build` 失败。默认值改为 `deploy/build-ca.empty`。

## 尚未完成

真实模型 + 真实 GitLab 的十步主场景（S8-7）：

- 驱动脚本 `apps/server/test/gitlab/s8-install-real.ts` 已写好。它只经公开的 HTTP 接口操作已部署的实例，由脚本扮演人类完成提问、补充、确认提议、批准合并这四个动作。
- 本次运行受阻于两点：
  - 模型中转站当天所有模型都返回 `No available accounts`（503）；
  - 本地 GitLab 是 http，而生产环境要求 GitLab 使用 https（这是正确的行为）。
- 恢复后的做法：给 GitLab 配上 TLS（自签证书，绑定时填 CA 证书），然后重跑脚本。运行时用 `LLM_RECORD_FILE` 录下模型回复，作为 `scripted:replay` 的回放夹具。
