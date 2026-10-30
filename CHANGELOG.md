# Changelog

## v0.1.0 — 2026-10-30

首个可运行版本。

### Added

- **本机多 agent 协作台**：会话、成员、任务、决策、评审、事件时间线；一个需求一个会话，上下文隔离。
- **Planner + 人工确认**：Planner 输出 JSON 计划，确认后才创建任务；可在弹窗里改标题、说明、负责人、类型、验收。
- **worktree 隔离 + 人工合并**：每个 code 任务独立 git worktree / 分支；评审通过后人工点合并，合并全局串行。
- **评审回路**：Reviewer 只读门禁；最多 2 轮，第 2 轮不通过升级为需人工。
- **SSE 实时看板**：任务卡显示成员、CLI、运行时长、当前动作；断线重连后全量同步。
- **流程画布**：阶段节点、门禁、产物、回边；负责人下拉、下一步复选框、简单/高级模式；起点模板和复制会话流程。
- **会话设置 / 归档 / 恢复**：改名、改需求、换计划者/评审者、增删成员、停用成员；归档只读。
- **5 个 CLI 适配**：Claude Code、Codex、OpenCode、Antigravity (agy)、DeepSeek Harness；JSONL 事件解析。
- **Rust 单文件版（实验）**：`rust/` 下的 axum + tokio + rusqlite + rust-embed 实现，复用同一套 REST/SSE 契约和 `web/` 前端；release `devhub.exe` 约 4.52 MB，不需要 Node.js。

### Known limitations

- 门禁 / 回边目前主要是流程标注，评审和合并仍在任务抽屉里手动操作。
- 重启恢复、空产出判失败、合并冲突回流、全局停止、artifact 模型、按需检索 CLI、成本统计尚未实现。
- Rust 版已完成 API/UI/SSE 验证；单任务执行链路已验证 spawn/解析/日志/失败状态（opencode 因 provider 429 未产出改动）；真实 agent 的 review/merge 全链路还需要一次成功任务确认。
- 仅 Windows；worktree 只隔离代码，不隔离网络和系统。
