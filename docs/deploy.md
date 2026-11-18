# 部署文档

本文面向**私有化部署**：在一台新机器上，从零到跑通主场景。日常运维（备份恢复、轮换、故障排查、升级）见 `runbook.md`。

> ⚠ **主密钥 `MASTER_KEY` 不在任何备份里。** 它加密了全部凭据（模型 key、GitLab 令牌）。丢失主密钥，这些凭据都无法恢复，只能逐个重新录入。安装完成后，请立刻把 `deploy/.env` 里的密钥存进密码库。

## 1. 准备

| 项         | 要求                                                           |
| ---------- | -------------------------------------------------------------- |
| 操作系统   | Linux x86-64（Ubuntu 22.04+/Debian 12+ 已验证）                |
| 软件       | Docker 24+（含 compose 插件）、git、openssl                    |
| 网络       | 能访问 GitLab（自建或 gitlab.com）与模型供应商；对用户开放 443 |
| 域名与证书 | 一个 https 域名（生产强制 https）                              |

起步资源建议（10 个项目、20 人、同时运行约 10 个 Agent 任务）：

| 资源             | 起步                   | 说明                                                                                                   |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| CPU / 内存       | 8 核 / 16 GB           | 沙箱容器默认每个 2 核 / 1 GB，按并发任务数估算                                                         |
| 数据库磁盘       | 50 GB SSD              | 50 万条消息 + 10 万个知识库分块约 3 GB；预留审计日志与事件的增长                                       |
| `DATA_PATH` 磁盘 | 200 GB                 | 工作区（每个进行中的任务一份检出）、仓库镜像缓存、产物（测试日志、补丁）。磁盘水位在「系统状态」页查看 |
| 备份磁盘         | 数据库 + 产物大小 × 30 | 默认保留 30 天                                                                                         |

## 2. 获取代码并配置

```bash
git clone <本仓库地址> agent-platform && cd agent-platform
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

编辑 `deploy/.env`，至少填写以下几项：

```bash
PUBLIC_URL=https://agents.example.com
POSTGRES_PASSWORD=$(openssl rand -base64 24)
BETTER_AUTH_SECRET=$(openssl rand -base64 48)
JWT_SECRET=$(openssl rand -base64 48)
MASTER_KEY=$(openssl rand -base64 48)      # 立刻另存到密码库
DATA_PATH=/srv/agent-platform/data
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
```

然后创建数据目录：

```bash
sudo mkdir -p /srv/agent-platform/data && sudo chown 1000:1000 /srv/agent-platform/data
```

生产启动时会校验配置，以下任一情况都会拒绝启动：

- 密钥为空，或仍是开发默认值；
- `PUBLIC_URL` 不是 https；
- `SANDBOX` 不是 docker；
- `AUTH_SIGNUP_MODE=open`；
- 开启了开发登录。

## 3. 沙箱与 docker

生产环境的 Agent 和测试命令都在 docker 沙箱里运行：

- 非 root 用户、只读根文件系统、丢弃全部 capabilities；
- 有资源限额，默认无网络；
- 不注入凭据。

平台容器通过挂载宿主机的 `/var/run/docker.sock` 来启动沙箱容器。

**风险**：能控制平台进程的人，等于能控制宿主机（docker socket 等价 root）。按安全程度从高到低，有三种部署方式：

1. **独立的 runner 主机**：平台和沙箱分开部署，平台机上不跑别的服务。
2. **rootless docker**：用非 root 用户运行 dockerd，再把它的 socket 挂给平台。
3. **默认方式（本 compose）**：挂载宿主机 socket。适用于平台独占的机器。

对应的隔离评审见 `security/sandbox-isolation-review.md`。在满足评审中的条件之前，**只在受信任的内部仓库上运行**。

沙箱镜像需要包含被管仓库所用的工具链，以及 git。在「项目设置 → 仓库」中按仓库配置；`SANDBOX_IMAGE` 是默认值。`SANDBOX_IMAGE_ALLOW` 限定可用的镜像来源。

### 外部执行引擎（Claude Code / Codex / OpenCode / pi，可选）

这些引擎需要访问平台的模型代理和平台工具，因此要为它们配置一个只能到达平台的网络：

```bash
# deploy/.env
SANDBOX_NETWORK=ap-sandbox
# 启动后由平台创建这个 internal 网络（也可以先手动创建：docker network create --internal ap-sandbox）
sudo SANDBOX_NETWORK=ap-sandbox PORT=3000 deploy/sandbox-firewall.sh   # 只放行平台端口；需要每次开机后执行
```

如果没执行防火墙脚本，「系统状态 → 沙箱」会一直显示警告。引擎需要预装在沙箱镜像里，模型用平台登记的 API 供应商（见 ADR-0010）。

## 4. 启动

如果公司网络的代理会做 TLS 检查，构建时 `bun install` 会报 `SELF_SIGNED_CERT_IN_CHAIN`。这时把代理的 CA 证书（PEM 格式）复制为 `deploy/build-ca.pem`，并在 `deploy/.env` 中设置 `BUILD_CA_FILE=./build-ca.pem`。证书文件必须放在 `deploy/` 目录里，因为 compose 不允许从其它目录读取构建 secret。证书只在构建时通过 BuildKit secret 使用，不会进入镜像。

```bash
cd deploy
docker compose build
docker compose up -d                  # postgres → migrate（一次性）→ app
docker compose ps                     # app 为 healthy
curl -fsS http://127.0.0.1:3000/readyz   # {"ok":true,"db":true,"migration":"…"}
```

可选：启用每日备份（保留 30 天，备份写入 `deploy/backups/`）：

```bash
docker compose --profile backup up -d
```

## 5. 反向代理（TLS、WebSocket、请求体上限、超时）

nginx 示例：

```nginx
server {
  listen 443 ssl http2;
  server_name agents.example.com;
  ssl_certificate     /etc/ssl/agents.example.com/fullchain.pem;
  ssl_certificate_key /etc/ssl/agents.example.com/privkey.pem;

  client_max_body_size 30m;          # 附件上限 MAX_UPLOAD_MB（默认 25）+ 余量

  location /ws {                      # 实时推送
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 300s;          # 模型流式回复与外部引擎的模型代理请求较慢
    proxy_buffering off;              # 流式（SSE）不缓冲
  }
}
server { listen 80; server_name agents.example.com; return 301 https://$host$request_uri; }
```

平台在 https 下会返回 HSTS 头。`/metrics` 只供内网的 Prometheus 抓取，可在代理上屏蔽对外访问。

## 6. 创建首个管理员

打开 `https://agents.example.com`。首次访问会进入「初始化」页面：填写团队名称、你的姓名、邮箱和密码。这个账号就是**所有者**。

之后在「成员与邀请」中邀请其他人（默认只允许邀请注册）。

## 7. 接入模型

进入「模型与预算 → 添加供应商」，填写以下内容：

- OpenAI 兼容的 base URL、key、模型名；
- 该供应商支持的接口：Chat Completions / Responses / Anthropic Messages。外部执行引擎会按接口筛选可用模型。

保存后点「连通性测试」，再点「设为默认」。

- 内网的模型服务（如 Ollama）需要加入 `OUTBOUND_ALLOW`，例如 `10.0.5.20:11434`。否则会被出站防护拒绝。
- 不想让数据出域的项目，在项目设置里勾选「只允许本地模型」。

## 8. 绑定 GitLab

1. 在 GitLab 为平台创建一个机器人账号，并给它一个 **project access token**，权限为 `api` + `write_repository`，角色为 Developer。默认分支保持受保护；平台只推任务分支，合并经合并队列完成。
2. 在平台「项目 → 仓库 → 绑定仓库」中，填写项目地址和令牌，然后先做连通检查。
3. 把页面上只显示一次的 webhook 地址和密钥，配置到 GitLab 项目的 Webhooks：勾选 Issues、Merge requests、Pipelines、Comments。
4. 内网 GitLab 需要加入 `OUTBOUND_ALLOW`（例如 `gitlab.internal`）。如果使用自签证书，在绑定时把 CA 证书（PEM）粘贴到「CA 证书」一栏。

## 9. 跑通主场景

在项目群里 @船长，描述一个问题：

1. 船长会追问细节，然后给出带验收标准的任务提议。
2. 确认提议后，开发 Agent 建分支、修复、推送并开 MR。
3. CI 通过后，评审 Agent 评审、测试 Agent 测试。
4. 合并审批需要人点「批准」，之后合并队列完成合并。
5. 船长在群里发完成总结。

全过程可以在任务详情的「代码 / 证据 / 审批」中查看，也可以在「系统状态 → 链路追踪」中用任务 ID 查出整条链路。

## 10. 接入钉钉 / 飞书（可选）

**钉钉**：

1. 在钉钉开放平台创建企业内部应用并添加机器人，消息接收选择 Stream 模式（不需要公网回调地址）。
2. 在 `deploy/.env` 中填写 `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` / `DINGTALK_ROBOT_CODE`，然后重启。

**飞书**：

1. 创建企业自建应用并启用机器人能力。
2. 事件订阅的请求地址填 `https://<域名>/api/v1/webhooks/feishu`，使用飞书时反向代理必须放行这个路径。
3. 在 `deploy/.env` 中填写 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY`，然后重启。

两者可以同时启用。成员绑定身份、群绑定、命令与真机验证清单见 `im.md`。

## 11. 安装后检查清单

- [ ] `MASTER_KEY` 已存入密码库，并且**不和**数据库备份放在一起
- [ ] 「系统状态」各项为正常：数据库、迁移版本、事件消费、沙箱（无警告）、磁盘
- [ ] 每日备份已启用，并且演练过一次恢复（`runbook.md`「备份与恢复」）
- [ ] Prometheus 抓取 `/metrics`（`METRICS_TOKEN`），并按 `runbook.md` 配置告警阈值
- [ ] `AUTH_SIGNUP_MODE` 与 OIDC 配置符合公司要求
