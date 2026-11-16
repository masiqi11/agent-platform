# ADR-0005：S4 模型层与船长的实现取舍

- 状态：已采纳（2026-11-16）
- 相关：DEV-SPEC §8（模型层）、§9（运行时）、§10（船长）、LLM-13、ADR-0003

## 背景

S4 要求：模型网关（路由/回退/熔断/预算/计量/脱敏/出口策略）、脚本化模型作为一等公民供 CI 使用、船长（追问、提议、分配、摘要、决策、全局问答），真实模型只用本机 `gemma4:e2b`（`think:false`）。

## 决定与偏差

1. **脚本模型以「供应商」形式登记**：每个初始化的租户自动有一个 `scripted://` 供应商，脚本 `demo / nonsense / text_tools / rogue` 各对应一个模型（`scripted:<名>`），可在「模型与预算」页设为租户默认。全新安装、未配置 `LLM_*` 时默认模型就是 `scripted:demo`，因此 CI、e2e、演示无需任何外部模型。测试可用 `registerScript` 注册额外脚本。
2. **`model_provider.dialect` 列（`openai` | `ollama`）**：文档只描述 OpenAI 兼容接口。实测 Ollama 的 OpenAI 兼容端点无法关闭思考（ADR-0003），所以增加原生 `/api/chat` 方言（`think:false`、`format:json`、`num_ctx`、NDJSON 流）。`model` 表增加 `supports_streaming`、`think_off`。
3. **散文追问兜底**：gemma4:e2b 经常把追问写在正文里而不调用 `ask_question`。船长检测到正文中的问句时会生成一张问题卡，并在 `blocks.fallback=true` 中标记；同理，明确请求但模型未调用 `propose_task` 时生成兜底提议（`payload.fallback=true`）。这些兜底在真实模型报告里单独计为「兜底」，不计为模型能力。
4. **文本工具调用解析**：模型能力登记为 `toolMode=none/text` 时，从正文中解析 `<tool_call>{…}</tool_call>` / JSON 代码块，计量里记录 `toolMode`。
5. **`search_knowledge` 先返回「未检索到依据」**：知识库在 S7，S4 只注册工具与权限，结果恒为 `NO_EVIDENCE_TEXT`，以保证船长不编造依据（INV-04）。
6. **预算周期只实现 `total`**：`budget` 行按租户/项目/Agent 记录累计上限；按日/按月周期留到 S8（生产化）。超额时原子预留失败 → `budget.exceeded` 事件、系统提示（每小时最多一次）、Maintainer 收件箱、会话挂起。
7. **摘要 JSON 一次修复**：校验失败时发一次 `<purpose>.repair` 调用；仍失败则用启发式摘要（模型名记为 `<model>+heuristic`），并过滤引用不存在 seq 的条目（TRAP-15）。
8. **全局船长检索用字符 n-gram 相似度**：S7 前没有向量库，问答在项目目录与群摘要上做相似度检索；检索不到即返回「未检索到依据」，模型给出的来源必须在检索结果中，否则丢弃。

## 后果

- CI 全部走脚本模型，确定且快；真实模型只在 `bun test/ollama/s4-scenario.ts` 中运行，结果写入 `docs/results/s4-ollama.json`，并区分「模型」与「兜底」。
- 兜底让主流程在小模型上可用，但掩盖了模型能力不足；报告必须如实标注。
