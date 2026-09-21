# 变更记录

本文件记录本子目录（`dsh-diagnostic-tools` 仓的 `closure/`）的版本变更，**倒序**（最新在最上）。
子目录版本号与 `attachments/` **各自独立**；仓级只记结构级变更，见 [`../CHANGELOG.md`](../CHANGELOG.md)。
规范见 `docs/RELEASING.md` §2。

---

## [Unreleased]

首个公开版本（拟定为 **0.1.0**），从一套内部体检工具通用化而来。以下按「相对内部版」的差异记。

### Added

- `lib/runtime-config.mjs`：路径与污染特征的统一解析层（CLI > 环境变量 > 自动探测 > 内置默认），
  并提供 `describeResolution()` 供 CLI 的 `--print-config` 打印「每个值从哪来」。
- 三个 CLI 全部支持 `--print-config`（排障用）与 `--help`。
- `scripts/verify-source.mjs`：静态验证（语法 + 配置层行为 + 脱敏扫描，支持 `BUILD_*` 注入本机标识规则）。
  注入项含 `MACHINE_NAMES` / `USER_NAMES` / `LAYOUT_ROOTS` / `SYNC_PRODUCTS` / `INTERNAL_TERMS` /
  `PERSONAL_TERMS`；扫描器还会用这些注入规则给**它自己**做一遍自检（防止规则文件夹带同一批标识）。
- `scripts/test-fixtures.mjs`：干净夹具验证（4 种判定 + dry-run 不回退 + 污染特征可注入 + 自动探测），
  夹具固定路径 + 幂等复用，被安全软件拦截时按项 `SKIP` 而非连锁失败。
- 合规件：`README.md`（含 R1–R5 规则表）/ `CHANGELOG.md` / `docs/RELEASING.md` / `LICENSE` / `examples/`。

### Changed

- **路径全部可注入**：链接层、期望闭包根、全局 npm 顶层、备份目录、扫描根、profile 依赖目录、词表、
  适配层唯一源与校验器 —— 都可用 CLI 参数或环境变量覆盖。
- **默认值改为自动探测**：期望闭包根不再依赖某个平台专属路径（Windows 的 `%APPDATA%\npm` 只是候选之一，
  并补了 POSIX 常见位置）；扫描根默认 `cwd/tools`。
- **污染特征可注入**：`--pollution-pattern`（可重复）/ `CLOSURE_POLLUTION_PATTERNS` 整体替换内置特征；
  非法正则**抛错拒绝执行**（判据坏了不许跑出「干净」结论）。
- **R5 解耦出可选件**：不再静态 `import` 内部的适配层同步器；改用 `--adapter-verifier` 注入校验器模块
  （或自动探测），未配置时 R5 显示 ⚪ 跳过、不影响退出码。
- **R4 词表可注入**：`--vocab <file>` 合并自定义事件名/服务名。
- **报告文案中性化**：去掉内部文档路径、卡号、事故流水与内部组件名；说明文字改为面向任何使用者的口径。
- **默认污染特征改为形态判据**：不再写死某个具体测试安装名，改为「路径里出现形如 `*-test` 的目录段」
  （外加通用的 `canary`）—— 名字是各环境自己的事，要收紧或替换用 `--pollution-pattern` 注入。
- **注入值分隔符扩为 `,` / `;` / `|`**：多值最终拼成一条正则，三种写法语义相同，怎么写都不会静默失效。
- **Windows 专属兜底改为平台判定**：删除链接的 `rd` 兜底只在 `win32` 下尝试。
- 回滚清单**不再记录主机名**等环境标识。

### Breaking（相对内部版的行为差异；都可用参数恢复）

| 项 | 内部版 | 本版 |
|---|---|---|
| JSON 报告 | 默认写固定路径 | 默认**不写文件**（`--json <path>` 显式开启） |
| profile 侧扫描 | 默认扫一个固定包名 | 默认**空**（`--profile-pkgs a,b` 开启） |
| R5 | 恒开（绑定内部同步器） | 需配置校验器，否则 ⚪ 跳过 |
| 修法备份目录 | 内部归档目录 | 包内 `.backups/`（已 gitignore；`--archive-root` 可改） |
| 默认污染特征 | 写死某个具体测试安装名 | **形态判据**：名字形如 `*-test` 的目录段 / `canary`（`--pollution-pattern` 可恢复任意口径） |
| 退出码 | 与内部口径一致 | 一致（R5 未配置时不再计为失败） |

### Fixed

- **扫描器不再夹带私人称呼与内部专有名**：原先这两类以明文写在它的规则表里（等于换个地方公开），
  现改为 `BUILD_PERSONAL_TERMS` / `BUILD_INTERNAL_TERMS` **注入**，并新增「扫描器自检」断言。
- **注入值用竖线分隔不再静默失效**：`envList` 原先只按 `,` / `;` 拆分，用户按正则习惯写 `A|B` 时
  整串会被转义成一个字面量 ⇒ 规则哑火、扫描假装通过；分隔符现扩为 `,` / `;` / `|`。
- 默认污染特征里写死的本机测试安装名已移除（见 Changed / Breaking）。
- 报告与注释里残留的内部文档引用与固定路径（脱敏扫描抓出后清零）。
- `repoRoot`/归档根的推导改用「脚本自身目录」而非固定盘符路径（跨机、跨目录可搬运）。
