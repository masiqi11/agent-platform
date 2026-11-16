# ADR-0003 真实模型测试使用本地 Ollama `gemma4:e2b`（CPU，关闭思考）

- 状态：已接受（2026-11-16）
- 背景：用户要求真实模型测试用本地 Ollama + Gemma 4 小模型（CPU）。随后指示：不必最小，可对 e2b / e4b 及内存允许的更大模型做基准，按速度与结构化输出质量取舍。
- 用户最终决定（2026-11-16 18:47 UTC+8）：**CPU 太慢，停止对 `gemma4:12b`、`gemma4:e4b` 的基准，所有真实模型运行只用 `gemma4:e2b`**；12b 与 e4b 已 `ollama stop` 并 `ollama rm`。

## 环境

- Ollama 0.40.16，8 vCPU / 15 GB RAM / 无 GPU。
- 由于代理把 registry 重定向到非公网 IP，`ollama pull` 被拒；改为 curl 从 `registry.ollama.ai` 下载 blob 放入 `~/.ollama/models`（模型内容与 pull 相同）。

## 基准（`scripts/bench-ollama.ts`，每项 2 次）

任务：①按 schema 输出任务提议 JSON；②原生工具调用 `propose_task`；③≤120 字中文摘要 + 追问。

| 模型 / 模式 | JSON | 工具调用 | 摘要 | 生成速度 |
| --- | --- | --- | --- | --- |
| e2b，默认（思考开启，OpenAI 兼容端点） | 2/2，均 92 s | 2/2（原生），均 73 s | 2/2，均 51 s | ≈9–10 tok/s |
| **e2b，`think:false`（原生 /api/chat）** | **2/2，均 26 s** | **2/2（原生），均 12 s** | **2/2，均 16 s** | ≈6–8 tok/s（与构建任务争用 CPU） |
| e4b | 首轮请求在模型未就绪时失败（0/2，属于环境错误而非模型质量）；按用户决定未重测 | — | — | — |
| 12b | 按用户决定未测 | — | — | — |

原始数据：`docs/bench/ollama-2026-11-16-openai-compat-run1.json`、`docs/bench/ollama-2026-11-16-nothink.json`。

## 决定

- 真实模型：`gemma4:e2b`，**关闭思考**（结构化输出质量不降，延迟降到 1/3～1/6，满足「船长回复约 60 s 内」）。
- 适配器走 Ollama 的 OpenAI 兼容端点 `http://127.0.0.1:11434/v1`，并在请求里传 `reasoning_effort: "none"`／原生端点 `think:false`（以实测可用者为准，见 PROGRESS 运行日志）。
- 能力注册（LLM-02）：`tools: true`（原生工具调用 4/4 可靠）、`jsonMode: true`、`vision: false`、`contextWindow: 8192`（为 CPU 内存与速度设定的保守值）、`streaming: true`；同时保留文本工具调用解析（`parseTextToolCalls`）作为降级。
- CI 与默认测试仍用脚本化模型（LLM-13）；真实模型结果在 PROGRESS 中单独、如实记录。
- 不使用任何第三方中转密钥。
