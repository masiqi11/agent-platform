# Main 合入后自动审查

现有 `ci` 在 push main 后运行完整测试；`Main review` 监听其 completed 事件。
CI 完成后自动读取失败 Job/步骤，并使用 DeepSeek 官方 `deepseek-flash` 审查两次 main push 之间的差异。
不需要定时轮询。响应时间包含 CI 执行与 GitHub runner 排队时间。

## 启用

1. 将本变更合入默认分支。
2. 在 Settings → Secrets and variables → Actions 添加 `DEEPSEEK_API_KEY`。
3. 确保仓库允许 GitHub Actions，工作流的 `issues: write` 权限可用。

不需要个人 GitHub token；使用工作流自动提供的 `GITHUB_TOKEN`。
Secret 缺失时仍报告 CI 失败，但 AI 审查明确标记未执行，工作流失败提醒配置。
监控器只使用 Node 标准库，不安装或执行被审查的变更，不把 Secret 注入项目测试。
模型使用非思考模式，避免当前项目多轮思考字段兼容问题；本工具仅单轮审查。

## 行为与限制

- 仅处理同仓库 main 的 push CI，忽略 PR 和取消的运行。
- CI 失败 Issue 明确标为“失败记录，原因待确认”，附日志链接，不冒称已确认产品缺陷。
- AI 最多发布3项、置信度至少0.9的P1/P2发现，标记待维护者验证；只接受位于本次新增行上的发现。
- 已有相同指纹更新评论；相同SHA重跑不重复评论。提供已有Issue内容（含#8）给模型，允许引用原Issue更新。
- 按前一个 main push CI 的SHA比较，覆盖多提交push；第一次没有历史CI时只比较父提交并作为初始基线。
- 每轮最多80k字符diff，过滤环境文件、密钥文件、锁文件和图片；GitHub compare API也可能截断文件列表。摘要报告纳入文件数，不能把未纳入文件视作通过。
- 模型发现不是确定性测试结论；语义去重受模型判断影响，维护者仍需核实。不会自动关闭Issue、改业务代码或部署。
- 不运行额外付费的真实模型业务场景；项目原有CI负责测试。需要此类场景时另行配置预算及测试专用凭据。

验证：`node --test scripts/review/*.test.mjs`。
