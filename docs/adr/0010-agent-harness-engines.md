# ADR-0010：Agent 绑定执行引擎（Claude Code / Codex / OpenCode / pi）

- 状态：已采纳，H0–H4 已实现（2026-11-17）
- 相关：§8（模型网关）、§12.5（Agent）、SBX-01…10、INV-08、INV-10、INV-17、LLM-01…13、ADR-0006、ADR-0009

## 背景与决定

平台的开发、评审、测试 Agent 目前用平台自己写的循环（模型网关 + 沙箱工具）。成熟的编码 harness（Claude Code、Codex、OpenCode、pi）在读写代码、执行命令、管理上下文方面更成熟。

**决定：每个 Agent 可以绑定一个执行引擎**，例如「开发 · 小码 = OpenCode」「测试 · 测测 = Claude Code」，也可以继续用内置引擎。几条原则：

- **只用这些工具的 harness，不用它们的订阅登录**：模型统一走平台登记的 API 供应商。
- **harness 拿不到真实 key**：它的模型地址指向平台的模型代理，使用会话级短期令牌，计量、预算、脱敏、出域检查都在代理上照常执行。
- **git 仍由平台负责**：harness 只改工作区，平台负责提交、密钥扫描、推送、开 MR。之后照常进入现有的评审、测试、门禁和合并队列。
- **结论只能通过平台工具提交**：评审和测试结论必须通过平台工具（MCP）的 `submit_review` / `submit_test_result` 提交，所以职责分离（INV-08）和「结论绑定提交」不受影响。

## H0 技术验证结果（2026-11-17，本机实测）

在演示支付仓库（带超时缺陷）上，用 OpenAI 兼容中转站的 API key 让四个 harness 以无界面模式修复缺陷，模型都是 `claude-opus-5-5`。

| harness     | 版本    | 启动方式                                                                                                      | 模型接口                      | 结果                           |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------ |
| Claude Code | 2.1.326 | `claude -p … --output-format stream-json --verbose`，`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`               | Anthropic `/v1/messages`      | 85 s，19 轮，测试全过          |
| Codex       | 0.169.0 | `codex exec --json`，`CODEX_HOME/config.toml` 中自定义 `model_providers`，`wire_api = "responses"`，`env_key` | OpenAI `/v1/responses`        | 60 s，测试全过                 |
| OpenCode    | 1.19.5  | `opencode run --format json`，`OPENCODE_CONFIG` 指定 `@ai-sdk/openai-compatible` 供应商                       | OpenAI `/v1/chat/completions` | 187 s，35 次工具调用，测试全过 |
| pi          | 1.5.2   | `pi --mode json -p … --provider … --tools …`，`~/.pi/agent/models.json`                                       | OpenAI `/v1/chat/completions` | 170 s，29 次工具调用，测试全过 |

事件样本保存在 `apps/server/test/fixtures/harness/*.jsonl`：已去掉路径和域名，不含 key；pi 的样本删减了逐 token 的流式更新。

### 平台工具（MCP）注入：四个都可用

我用一个最小的 stdio MCP 服务提供 `get_task`，返回一个模型无法猜到的口令，四个 harness 都能调用并取回口令。

| harness     | 配置方式                                                                                                 | 注意事项                                          |
| ----------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Claude Code | `--mcp-config` 文件 + `--strict-mcp-config`；在 `--allowedTools` 里列出 `mcp__platform__…`               | 无                                                |
| Codex       | `[mcp_servers.platform]`，并给每个工具加 `[mcp_servers.platform.tools.<name>] approval_mode = "approve"` | 审批策略为 `never` 时，MCP 工具默认被拦截         |
| OpenCode    | 配置里写 `mcp.platform = { type: "local", command: [...] }`                                              | 无                                                |
| pi          | `~/.pi/agent/mcp.json`，并设置 `"exposure": "direct"`                                                    | 默认暴露方式是 `codemode`，模型直接看不到这个工具 |

### 发现，以及对设计的约束

1. **必须使用干净的环境变量**：子进程继承宿主会话的 `CLAUDE_*` 环境变量时，Claude Code 报认证错误；改用 `env -i` 只传必要的变量后才正常。平台沙箱本来就会构造干净环境，必须保持。
2. **非交互运行必须关闭 stdin**：Codex 会等待 stdin 输入（"Reading additional input from stdin…"），所以必须用 `< /dev/null` 启动。
3. **harness 会绕过自身的工具限制**：Codex 的 MCP 调用被审批策略拦截后，它改用 shell 直接运行 MCP 服务拿到了数据。所以 harness 的配置只是便利层，权限必须由平台服务端执行：每次调用平台工具都校验会话令牌、角色和任务；沙箱网络只放行平台代理；凭据不进沙箱。
4. **用量格式各不相同**：Claude Code 的 result 里有 `total_cost_usd`，Codex 在 `turn.completed` 里给 usage，OpenCode 在每个 `step_finish` 里给 tokens，pi 在每条 assistant 消息里给 usage。平台计费以模型代理的计量为准，harness 自报的数字只作参考。
5. **用中转站时的特殊配置**：pi 的 key 在配置里必须写成 `$ENV` 引用；Codex 在 `/tmp` 下运行时会提示无法创建辅助程序，不影响结果。

## 实现（H1–H4）

| 部分        | 位置                                                                            | 要点                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型代理    | `/llm/v1/{chat/completions,responses,messages}`                                 | 只认 Agent 会话令牌（`Bearer` 或 `x-api-key`），会话必须在运行中；模型强制为 Agent 配置的模型；出域、熔断、预算、脱敏、计量与内置引擎一致。供应商需登记支持的接口（`apis`），不支持该接口的供应商不会被选中                                                                                              |
| 平台工具    | `POST /mcp`（MCP streamable HTTP，JSON 响应）                                   | 每个角色只列出固定的工具：开发 `get_task / add_task_comment / block_task / search_knowledge / ask_project_captain`，评审 `get_task / get_diff / submit_review / …`，测试 `get_task / run_tests / submit_test_result / …`。git、MR、提交评审不在其中。调用经 `runtime.invokeTool`，权限检查与内置引擎相同 |
| 适配器      | `modules/harness/adapters.ts`                                                   | 每个引擎的启动命令、配置文件和事件解析。令牌只以环境变量 `PLATFORM_LLM_TOKEN` 引用，不写入任何文件；角色限制（评审、测试只读，评审只能跑 git 只读命令）只是第二道防线                                                                                                                                    |
| 执行        | `modules/harness/service.ts`                                                    | 在工作区运行，HOME 为 `<工作区>/.sandbox-home`（已加入 `.git/info/exclude`），事件实时写入会话转录；运行上下文存在会话上，MCP 请求可以落到任何进程                                                                                                                                                       |
| 开发        | `devagent`                                                                      | 引擎只改代码；之后由平台提交、推送（密钥扫描）、开 MR、等 CI；CI 通过即以引擎总结提交评审，CI 失败则带着失败信息重跑；返工续接引擎会话。引擎失败、没有改动、或自己 `block_task` 时本轮结束                                                                                                               |
| 评审 / 测试 | `qa`                                                                            | 在该提交的独立只读检出中运行；结论只能经 MCP 提交，平台检查是否有绑定该提交、由该 Agent 给出的结论                                                                                                                                                                                                       |
| 配置        | Agent `engine` 字段、`modelPolicy.reasoning`；`GET /projects/:id/model-options` | 推理强度映射：Claude Code `--effort`，Codex `model_reasoning_effort`（max→xhigh），OpenCode `--variant`，pi `--thinking`。船长只能用内置引擎                                                                                                                                                             |
| 界面        | Agent 编辑框                                                                    | 引擎选项卡 → 该引擎能用的模型（其余置灰并写明原因）→ 推理强度 Low/High/Max                                                                                                                                                                                                                               |

### 实现中的发现

6. **中转站的流式并行工具调用会打乱参数**（与 ADR-0009 #2 同源）：真实 pi 第一次跑开发流程时，74 轮中有 21 轮是参数损坏的工具调用；部分分片既无 id、又共用 index，无法在代理端还原。现在 Chat 接口的流式请求由代理以非流式取回，再按调用逐个生成流返回给引擎；修复后 0 损坏。
7. **docker 沙箱暂不支持外部引擎**：引擎需要访问平台的模型代理和 MCP，而 docker 沙箱目前没有网络（出口白名单在 S8）。外部引擎目前要求 process 沙箱，生产部署前需要补上 S8。
8. **HOME 曾可能被提交**：`git add -A` 会把引擎的配置和缓存一起提交。现在每个工作区和检出都把 `.sandbox-home/` 写入 `.git/info/exclude`，并有回归测试。

### 验证

- CI：`test/h2-harness.test.ts` 用假 pi（`test/fixtures/harness/fake-pi.ts`，与真实 pi 同样经代理、MCP 和环境变量令牌工作）跑通开发 → MR → CI → 评审 → 测试，以及「无改动」「引擎自行阻塞」「非运行会话令牌被拒」；`e2e/h4-engine.spec.ts` 覆盖选择器。
- 真实运行（`claude-opus-5-5`，经中转站，模型只走平台代理）：

  | 引擎                                                | 角色   | 结果                                                                                                          | 文件                                  |
  | --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
  | pi                                                  | 开发   | 120 秒到评审中，CI 通过，10 次模型调用 0 失败                                                                 | `docs/results/h2-pi-opus55.json`      |
  | Codex                                               | 开发   | 119 秒到评审中，CI 通过，3 次模型调用（Responses）0 失败                                                      | `docs/results/h3-codex-opus55.json`   |
  | OpenCode（小码）+ 内置（审审）+ Claude Code（测测） | 主场景 | 修复 → MR → CI → 评审通过 → 测试通过 → 合并队列 → 完成，3.4 分钟，23 次模型调用 0 失败，`main` 上超时为 3_000 | `docs/results/s6-harness-opus55.json` |

  未做：Claude Code 作为开发、Codex / OpenCode 作为评审或测试的真实组合；返工续接（评审打回后续接引擎会话）只在假引擎上验证过——本轮真实评审都一次通过。

## 实施计划

| 阶段  | 内容                                                                                                                                                           | 退出标准                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| H0 ✅ | 四个 harness 跑通无界面模式、MCP 注入，保存事件样本                                                                                                            | 见上                                                            |
| H1 ✅ | 平台模型代理：`/llm/v1/messages`、`/llm/v1/responses`、`/llm/v1/chat/completions`，使用会话令牌，并做计量、预算、脱敏、出域检查；第一阶段只做同格式透传        | 用 curl 和四个 harness 经代理调用中转站成功，用量正确入账       |
| H2 ✅ | 执行引擎框架：Agent 增加 `engine` 字段，适配器把各家事件统一写入会话转录；平台 MCP 服务通过 HTTP 提供并用会话令牌鉴权；提交和推送接入现有流程；CI 用假 harness | CI 用假 harness 跑通主场景；真实 harness 跑通一次               |
| H3 ✅ | 补齐四个适配器；返工续接（`claude --resume`、`codex exec resume`、`opencode --session`、pi 会话目录）；评审和测试角色只读，结论只能经平台工具提交              | 四个引擎各自跑通                                                |
| H4 ✅ | 界面：Agent 编辑页选择执行引擎、会话检查器显示 harness 事件；沙箱镜像预装固定版本的 harness；文档                                                              | 「小码 = OpenCode、测测 = Claude Code」用真实模型跑通完整主场景 |
