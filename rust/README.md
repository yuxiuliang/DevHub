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
.\devhub.exe --port 7374 --data D:\path\to\devhub-data
```

也可以继续用环境变量：

```powershell
$env:PORT = "7374"
$env:DEVHUB_DATA = "D:\path\to\devhub-data"
.\devhub.exe
```

- `--port` / `-p` 指定端口；不指定时先试 `7373`，被占用就自动尝试 `7374-7399`，启动日志会打印实际端口。
- 显式指定的端口被占用会直接报错，不会悄悄换端口；换一个 `--port` 即可。
- `--data` / `-d` 指定数据目录；默认是当前工作目录下的 `.data`。
- 优先级：命令行参数 > `PORT` / `DEVHUB_DATA` 环境变量 > 默认值。
- 只监听 `127.0.0.1`。前端用相对路径 `/api/...`，换端口后不需要改任何前端配置。
- 浏览器打开启动日志里的地址，例如 `http://127.0.0.1:7374`。
- `--help` / `--version` 查看用法和版本。

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
- 流程起点模板、复制房间流程、流程属性保存和旧版本冲突保护
- 完整设置一次保存（含成员和计划/评审分配）、事务失败回滚和活动操作保护

## 测试

```powershell
cd rust
cargo test
```

包含 git 集成测试和 REST API 契约测试（含前端常用的空 body `POST /api/tasks/:id/cancel`）。

## 验证状态（2026-11-21）

- `cargo test --offline -- --test-threads=4`：106 项通过，覆盖任务调度、取消、重启恢复、计划保存、固定成果合并、总览待办、最近日志尾读、全局停止及 API 契约，也包含设置事务回滚、并发版本冲突、活动操作保护和流程版本校验。长中文/emoji 错误输出回归确认错误摘要按完整 UTF-8 字符截尾、完整日志保留，任务失败后释放执行名额且可直接重试。Windows 上多个测试会同时创建 Git 仓库和模拟进程，建议限制测试线程数，避免资源竞争导致夹具启动超时。
- 合并恢复专项使用真实 Git/SQLite 触发器模拟「Git 已提交、任务状态保存失败」，直接重试和重启后重试都能补写任务状态、解锁下游，且不会创建重复提交。重复 squash 保留基准分支后续提交并清理临时合并状态；脏仓库、冲突和真实签名失败仍报错。
- 合并收尾的任务终态、全部依赖就绪、会话完成和对应事件使用同一个 SQLite 事务保存，COMMIT 成功且释放数据库锁后才广播；事件插入失败不会发送旧 ID。触发器、延迟外键提交失败和独立数据库观察连接回归覆盖整批回滚、无虚假广播及重试。
- 手动任务创建专项 12 项通过：严格字段/成员/依赖检查、5000 节点深链和共享分支、稀疏编号和并发创建、任务与事件原子保存、已完成会话新增工作后暂停。新请求依赖会去空格，旧任务依赖按调度器的原始 key 精确检查，避免静默修正旧数据后放行不可执行的链。
- 前端补充验证（2026-11-22）：执行提示区分就绪队列、待单独启动、已取消和无待办；已重新构建嵌入前端的单文件。真实 Node/Rust 后端验证新增和查看不启动任务，明确运行才发出一次启动请求并产出待审改动；390px、完整协作流程和重启恢复通过。
- `cargo build --release --offline`：通过，前端资源已嵌入单文件程序。
- Edge 桌面和 390px 窄屏验证通过：总览待办直接打开对应计划或任务，实时更新保留键盘焦点，切换会话不会弹出旧计划；大日志显示最近内容，向上阅读时保持位置，不同任务和运行互不串日志。
- Node 与 Rust 共用的浏览器集成脚本已跑通新建、生成计划失败重试、确认执行、自动检查、合并和重启恢复。最终 release 单文件也通过了设置原子保存、回滚、版本冲突、草稿刷新恢复和流程 CAS 的浏览器断言。测试使用临时 Git 仓库和模拟 CLI，无需模型服务。
- 本机 Edge 在页面断言后可能挂在浏览器退出阶段；相关测试会限时终止专用 Playwright driver 及其浏览器子树，Windows 仍延迟结束 Edge 时单独打印清理警告。产品断言失败仍导致测试失败。
- 真实工具的登录、模型与权限行为仍由各 CLI 提供；上述测试用于验证 DevHub 的调用和流程。

## 与 Node 版的关系

- `server/` 的 Node 版保留作为参考实现和回退方案。
- 两个版本共用同一套 REST/SSE 契约和 `web/` 前端。
- 同一个数据目录同时只允许一个实例使用，已有实例运行时第二个会提示关闭它或更换目录。
- 迁移时建议先备份 `.data`，再用 Rust 版指向同一份数据目录验证。
- 设置版本是后端返回的 opaque token。Node/Rust 的字符串编码顺序不同，切换后端后若打开旧草稿，会安全提示版本冲突；重新加载已保存设置后再调整即可。

## 已知限制

和 Node 版相同，门禁三态和打回上限已经参与执行：计划里显式绑定阶段的任务按阶段 `gate`（auto/agent/human）和 `maxLoop` 推进，升级后进收件箱；没绑定阶段的任务仍按「评审通过」。产物管理、按需检索和成本统计还未实现。
