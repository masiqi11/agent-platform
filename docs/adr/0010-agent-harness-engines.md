# ADR-0010：Agent 绑定执行引擎（Claude Code / Codex / OpenCode / pi）

- 状态：已采纳，实施中（2026-11-17）
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

## 实施计划

| 阶段  | 内容                                                                                                                                                           | 退出标准                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| H0 ✅ | 四个 harness 跑通无界面模式、MCP 注入，保存事件样本                                                                                                            | 见上                                                            |
| H1    | 平台模型代理：`/llm/v1/messages`、`/llm/v1/responses`、`/llm/v1/chat/completions`，使用会话令牌，并做计量、预算、脱敏、出域检查；第一阶段只做同格式透传        | 用 curl 和四个 harness 经代理调用中转站成功，用量正确入账       |
| H2    | 执行引擎框架：Agent 增加 `engine` 字段，适配器把各家事件统一写入会话转录；平台 MCP 服务通过 HTTP 提供并用会话令牌鉴权；提交和推送接入现有流程；CI 用假 harness | CI 用假 harness 跑通主场景；真实 harness 跑通一次               |
| H3    | 补齐四个适配器；返工续接（`claude --resume`、`codex exec resume`、`opencode --session`、pi 会话目录）；评审和测试角色只读，结论只能经平台工具提交              | 四个引擎各自跑通                                                |
| H4    | 界面：Agent 编辑页选择执行引擎、会话检查器显示 harness 事件；沙箱镜像预装固定版本的 harness；文档                                                              | 「小码 = OpenCode、测测 = Claude Code」用真实模型跑通完整主场景 |
