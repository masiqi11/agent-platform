# ADR-0006：S5 代码执行链路的实现取舍

- 状态：已采纳（2026-11-16）
- 相关：DEV-SPEC §12.7（工作区与 Git）、§12.10（会话）、§12.12（沙箱）、§18 S5、V6、INV-05/10/16/17、TRAP-5/7/9

## 背景

S5 要求：SCM 抽象（本地裸仓库 + GitLab）、任务工作区、沙箱（docker 与 process）、开发 Agent 能自动建工作区、修复、推送、开 MR、提交评审；worker 崩溃后会话能恢复，且不重复推送、不重复开 MR。

## 决定与偏差

1. **V6 已验证（本机真实 docker 29）**。`process` 沙箱用 `setsid` 让子进程成为进程组组长（调用方不是组长时 `setsid` 原地 exec，pid 不变），超时后 `kill(-pid)` 杀掉整组（含孙进程）；输出边读边截断（每路 1 MB，完整日志上限 10 MB 进对象存储）。`docker` 沙箱：非 root、只读根 + `/workspace` 可写、`--cap-drop ALL`、`no-new-privileges`、pid/内存/CPU 限额、`--network none`、可选 `--runtime runsc`，记录镜像摘要；超时 `docker rm -f`。测试 `s5-sandbox.test.ts` 在有 docker 与镜像时真实运行，否则跳过并在 PROGRESS 中标注。
2. **宿主 root 时容器用 65532 用户，工作区放宽为 a+rwX**。只放宽工作区，不放宽其他目录。宿主非 root 时容器沿用宿主 uid。
3. **出口白名单暂不生效（SBX-03 部分）**：容器始终 `--network none`；项目的 `egressAllowlist` 会传入并记录警告。按域名放行需要出口代理，留到 S8，与沙箱隔离评审一起做。
4. **git 只在控制面（宿主）运行**，沙箱里没有 git 凭据，也没有远端地址：工作区克隆自本地镜像缓存，`origin` 指向镜像；推送用显式 URL + 一次性 askpass（令牌只在该次 git 进程的环境变量里，脚本文件用完即删），自定义 CA 用 `GIT_SSL_CAINFO` 指向临时文件。宿主 git 与全局/系统配置隔离（`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`），否则 Agent 提交会继承宿主的身份或签名配置——开发中实际遇到过。
5. **本地 SCM 在仓库侧也强制 INV-10**：本地裸仓库装 `pre-receive` 钩子，受保护分支只接受带 `AP_MERGE_QUEUE=1` 的推送（S6 合并队列使用）。平台侧在推送前另做一次检查并写「被拒」审计。本地仓库只能位于 `LOCAL_SCM_DIR` 下，不能绑定任意宿主路径。
6. **Issue 同步按标记标签收敛**：每个任务的 Issue 带标签 `ap::<KEY>-<number>`；找不到 iid 时先按标签查找，避免中断重试后重复建 Issue。同步任务每个触发事件一份（正在运行的同步不会吞掉之后的变更），按任务串行，且结果收敛，多跑无害。GitLab 侧改标题/描述只回流为任务评论提示（`platform_wins`）。
7. **CI 状态的唯一写入点 `applyCi`**：按 sha 单调——终态不被迟到的非终态覆盖，重复上报无效，非当前 head 的 sha 忽略；同一 sha 只有「新的流水线」（重跑，GIT-补5）才能改写终态。`pipeline.completed` 每个（sha、状态、流水线）只发一次。
8. **唤醒规则（TRAP-5）**：开发 Agent 只在任务仍处于 `ready` 时因分配被唤醒，去重键按（任务、Agent）；`创建即分配 → 就绪` 只产生一次唤醒。CI 完成、打回、测试失败各有自己的去重键，并按任务串行执行。
9. **会话恢复靠幂等而不是精确重放**：推送前用 `ls-remote` 判断远端分支是否已是当前 head；`commit.pushed`、`mr.opened`、`pipeline.completed` 等事件带幂等键，`events.emit` 遇到重复键改为空操作并返回原事件（之前会让整个事务失败）。MR 创建遇到已存在（本地或 GitLab 409）即复用。检查点记录阶段、已推送的 sha、MR；即使检查点在崩溃时丢失，重放也不会产生副作用重复。
10. **脚本化开发模型**根据 `<state>`（工作区实时状态）和本轮工具结果做决定，不依赖历史转录，所以恢复后的会话能接着走。它按演示仓库里 `FIXME … 应改为 N` 的提示修复——这是「演示用确定性脚本」，不代表模型能力；真实模型走同一套工具。
11. **GitLab 只用假服务验证**：`s5-scm.test.ts` 用内存假 GitLab 覆盖 409 复用、405/406/422 有限重试、收敛同步、401、webhook（令牌、幂等、回环抑制）。真实 GitLab CE + Runner 的验证留到 S6 的手动工作流；在此之前标注「已实现、未经真实 GitLab 验证」。
12. **默认工具名统一为注册表名称**（`commit`、`push`、`open_merge_request` 等）；旧名称 `git_commit / git_push / open_mr / propose_assignment` 作为别名继续生效。
13. **演示项目键为 `DPAY` / `DBILL`**，避免与用户或其他演示数据的 `PAY` 冲突；`bun run seed` 幂等。

## 后果

- 主场景前半段（分配 → 修复 → MR → CI → 评审中）在 CI 里用脚本模型 + 本地 SCM 全自动通过，浏览器端也有 Playwright 覆盖。
- 生产仍需：出口代理（白名单生效）、沙箱隔离评审、真实 GitLab 验证、多仓库任务（P1）。
