# 变更记录

本文件记录本工具包（`attachments-tools`）的版本变更，**倒序**（最新在最上）。
规范见 `docs/RELEASING.md` §2。

---

## [Unreleased]

首个公开版本（拟定为 **0.1.0**），从一套内部运维脚本通用化而来。以下按「相对内部版」的差异记。

### Added

- `lib/attach-config.mjs`：路径解析层（CLI > 环境变量 > 自动探测 > 内置默认），
  并导出 `describeResolution()` / `formatResolution()` 供 `--print-config` 打印「每个值从哪来」。
- 两个 CLI 都支持 `--print-config`；`attachments-fetch.mjs` 新增 `--cache` / `--sessions-root` /
  `--objects-root` / `--workspace`（让取回与内部对账走**同一套路径注入**，不再各认一半）。
- 环境变量通道统一为 `ATTACH_*` 前缀：`ATTACH_OBJECTS_ROOT` / `ATTACH_SESSION_ROOTS` /
  `ATTACH_SCAN_CACHE` / `ATTACH_RELAY_DIRS` / `ATTACH_LOCAL_SOURCES` / `ATTACH_REPORT_DIR`；
  home / workspace 仍用 `DSH_HOME` / `DSH_WORKSPACE`。
- `scripts/verify-source.mjs`：静态验证（语法 + 配置层行为 + 脱敏扫描，支持 `BUILD_*` 注入本机标识规则）。
  注入项含 `MACHINE_NAMES` / `USER_NAMES` / `LAYOUT_ROOTS` / `SYNC_PRODUCTS` / `INTERNAL_TERMS` /
  `PERSONAL_TERMS`；扫描器还会用这些注入规则给**它自己**做一遍自检。
- `scripts/test-fixtures.mjs`：干净夹具验证（65 条断言），全部输入都是脚本现造的假 home / 假会话 /
  假对象树，落在系统临时目录，**绝不碰真实数据**。
- 合规件：`README.md`（安装三步 / 用法表 / 退出码表 / 配置表 / 安全边界 / 已知限制）/ `CHANGELOG.md` /
  `docs/RELEASING.md` / `LICENSE` / `package.json` / `.gitignore`。

### Changed

- **路径全部可注入**：home、workspace、对象根、会话根、扫描缓存、取回源、报告目录 —— 都可用 CLI
  参数或环境变量覆盖，且默认值一律**自动探测**，不写死任何与本机盘符相关的路径。
- **默认会话根不变但可替换**：仍默认扫 `sessions` + `_archived-sessions` 两棵树（归档里的历史回合同样
  会回放，只扫现役会明显低估受影响面），新增 `--sessions-root` / `ATTACH_SESSION_ROOTS` 可整体替换。
- **扫描缓存文件名中性化**：不再带内部组件名前缀，改为 `<home>/attach-scan-cache.json`（可注入）。
- **报告链路补齐**：取回报告新增 `kind` 标记与 `rollbackHint` 的稳定形态，便于机器消费与一键回滚。
- **文案彻底中性化**：去掉内部卡号、内部文档引用、内部备份体系名、事故流水与实测数字；
  「没有可用取回源」时的提示改为面向任何使用者的口径（讲清三种跨机形态与各自代价）。
- **注释改为讲「为什么」**：根因链（为什么一个缺文件会被报成传输错误）写进脚本头部，
  而不是只留一句「同步来的会话会挂」。

### Breaking（相对内部版的行为差异；都可用参数恢复）

| 项 | 内部版 | 本版 |
|---|---|---|
| home 环境变量 | 多认一个内部组件专用变量名 | 只认 `DSH_HOME`（语义相同） |
| workspace 默认 | 写死内部盘符路径 | 由 home 推导 → 否则当前工作目录 |
| 中转目录候选 | 内置两个内部盘符路径 | 只有 `<workspace>/_tmp/attachments-relay` |
| 扫描缓存默认名 | `<home>/<内部组件名>-attach-scan.json` | `<home>/attach-scan-cache.json` |
| 取回报告 `kind` | 无类型标记 | 有（`attachments-fetch` / `dsh-attachments-relay`） |
| 内部流程挂点 | 内含某内部交接流程的调用 | 不含（本包是独立 CLI） |
| 退出码 / 判定口径 | —— | **完全一致，未变** |

> 缓存文件名变了 ⇒ 首次跑新版会重建一次缓存（旧的缓存文件不会自动删除，可以自行删掉）。

### Fixed

- `attachments-fetch.mjs` 的路径注入原先只作用于「取回」一半流程，内部对账仍按默认 home 走 ⇒
  传了 `--objects-root` 时可能出现「报告说缺、补齐却写到别处」的错位；现改为**对账与取回共用同一套解析结果**。
- 注释里残留的内部盘符路径、内部文档引用与实测流水（脱敏扫描抓出后清零）。
- **夹具脚本不再偶发「莫名退出码 1」**：`scripts/test-fixtures.mjs` 原先每次都用 `fs.rmSync` 整目录删掉重建，
  在 Windows 上会偶发撞上 `EPERM`/`EBUSY`（安全软件正在扫描刚创建的文件、或上一子进程句柄未释放）⇒
  裸调用抛未捕获异常，表现是**只打印一段 node 版本号、退出码 1**，看起来像断言失败。
  现改为：① 默认只清夹具根**内容**、保留根本身（减少占用与反复重建）；② 删除带重试（`maxRetries` + `retryDelay`）；
  ③ `--clean` 才连根一起删，且删除失败会降级为「只清内容」继续跑；④ 顶层 `uncaughtException` 处理器给出**可照做**的提示。

---

## 版本号约定

见 `docs/RELEASING.md` §1。
