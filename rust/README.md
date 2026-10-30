# DevHub Rust 后端（实验）

用 Rust 重写 hub，复用 `../web` 的现有前端和同一套 REST/SSE 契约。目标是一个不需要 Node.js 的 Windows 单文件 exe。

## 构建

```powershell
cd rust
cargo build --release
# 产物：rust\target\release\devhub.exe
```

- 默认 target 是 `x86_64-pc-windows-gnu`，需要本机有 GCC（当前环境已具备）。
- 单文件分发建议加静态 CRT，并在干净 Windows 机器上验证：
  ```powershell
  $env:RUSTFLAGS = "-C target-feature=+crt-static"
  cargo build --release
  ```
- 前端资源通过 `rust-embed` 嵌入 exe；release 构建不需要带 `web/` 目录。

## 运行

```powershell
$env:PORT = "7373"
$env:DEVHUB_DATA = "D:\path\to\devhub-data"
.\devhub.exe
```

- 默认端口 `7373`，只监听 `127.0.0.1`。
- 默认数据目录是当前工作目录下的 `.data`；建议用 `DEVHUB_DATA` 明确指定。
- 浏览器打开 `http://127.0.0.1:7373`。

## 配置

`.data/env.json`（已 gitignore，不提交）：

```json
{
  "WORKBUDDY_API_KEY": "…",
  "HTTPS_PROXY": "http://127.0.0.1:7890",
  "DEVHUB_DSH_PATH": "C:\\path\\to\\dsh.cmd",
  "DEVHUB_AGY_PATH": "C:\\path\\to\\agy.exe"
}
```

不在 `PATH` 上的 CLI 用 `DEVHUB_DSH_PATH` / `DEVHUB_AGY_PATH` 指定绝对路径。仓库里不内置任何人的本机路径。

## 已移植

- SQLite schema / 房间 / 成员 / 任务 / 决策 / 评审 / 事件
- Planner、执行、评审、合并、取消、暂停、归档/恢复
- git worktree、diff、squash merge
- 5 个 CLI 适配器（claude / codex / opencode / agy / dsh）与 JSONL 解析
- SSE 实时事件、静态资源嵌入、目录浏览 `/api/fs`
- 流程起点模板、复制房间流程、流程属性保存

## 测试

```powershell
cd rust
cargo test
```

包含 git 集成测试和 REST API 契约测试（含前端常用的空 body `POST /api/tasks/:id/cancel`）。

## 与 Node 版的关系

- `server/` 的 Node 版保留作为参考实现和回退方案。
- 两个版本共用同一套 REST/SSE 契约和 `web/` 前端。
- **不要同时用 Node 版和 Rust 版写同一个 `.data/devhub.db`**；SQLite WAL 下会出现锁竞争和状态不一致。
- 迁移时建议先备份 `.data`，再用 Rust 版指向同一份数据目录验证。

## 已知限制

和 Node 版相同：门禁/回边目前主要是流程标注，重启恢复、artifact 模型、按需检索 CLI、成本统计等还没有做。Rust 版优先保证核心链路和 API 契约一致。
