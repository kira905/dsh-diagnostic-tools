# 变更记录（仓级）

本文件**只记结构级变更**：新增 / 删除子目录、仓名变更、许可变更、发布流程变更。

两个子目录（`closure/` / `attachments/`）各自的功能变更**记在各自目录的 `CHANGELOG.md`**，不在这里汇总 ——
两边的版本号与退出码各自独立、变更节奏不同，汇总必然重复且容易不同步（理由见 README §3）。

---

## [0.1.4] - 2026-10-16

### Changed

- 🔴 **许可变更（本仓级；两个子目录同步）**：**自本版起仓根与两个子目录均为 `AGPL-3.0-only` + 商业授权（双许可）**（此前 `v0.1.0` ~ `v0.1.3` 的全部历史 tag 为 **MIT**）。五处口径同步改：仓根 `LICENSE` / `closure/LICENSE` / `attachments/LICENSE`（三份同文本，换成 GNU AGPL-3.0 官方全文）+ 仓根 README 中英双份的「许可」段 + 两个子目录的 `package.json#license`（`MIT` → `AGPL-3.0-only`）；两个子目录 README 的「许可与发布状态」段同步。子目录版本 `0.1.0` → **`0.1.1`**（许可变更）。⚠️ 术语必须读准：**AGPL 本身不禁商用**（AGPL / MIT / Apache 本身都不禁商用，AGPL 只要求**衍生作品也开源**）；「+ 商业授权」= **双许可** —— 「要么按 AGPL 衍生开源、要么取得商业授权」。已按 MIT 发布的版本授权**收不回**，变更只约束**未来版本**。
- **宿主兼容区间（如实说明 · 子包不声明 peer）**：两个子目录都是**独立 CLI 工具**（不 `import` 任何 `@deepseek-ai/dsh-*` 包）⇒ **不声明 `peerDependencies`**（声明会误导成"与宿主版本绑定"）。实测环境如实写进 README：**在隔离实例（端口 3090，主包 `0.2.0-rc.2`）里真跑过** —— `closure-check.mjs --home <隔离 home>` **rc=0（判定干净）**、`attachments-audit.mjs --home <隔离 home> --quiet` **rc=0（无缺失）**。
- **本轮无代码与行为改动**（推送内容为 `LICENSE` ×3 + 三个 `package.json` + `README.md` / `README.en.md` / 两个子目录 README + 本文件）。

## [0.1.3] - 2026-10-12

### Changed

- **本轮文档更新（本次发版内容）**：仓根新增**英文 README**（`README.en.md`，与中文 `README.md` 内容对等、章节 1:1）—— 补齐文档仓《发布说明》§4.8「组件仓 README 英文必备」的语言政策欠账（开源主档待办 24）；中文 README 顶部加英文版互链。本轮**无代码与行为改动**（推送内容为改动后的 `README.md` + 新增 `README.en.md`；两个子目录的版本号与退出码均未变）。

## [0.1.2] - 2026-09-28

### Changed

- **本轮文档更新（本次发版内容）**：仓根 README 新增**「设计依据」节**（回链文档仓的具体章节）；「相关组件」互链节补入两件新发布的伴生组件。本轮**无代码与行为改动**（推送内容仅 `README.md`；两个子目录的版本号与退出码均未变）。

## [0.1.1] - 2026-09-22

### Changed

- **本轮文档更新（本次发版内容）**：仓根 README 新增「相关组件」互链节；`closure/README.md` 与 `attachments/README.md` 各补「宿主版本适用性（2026-09-21 静态审计）」节（含一处如实标注的可能漏报）。本轮**无代码与行为改动**（推送内容仅 `README.md`；两个子目录的版本号与退出码均未变）。

## [0.1.0] - 2026-09-21

### Added

- 仓建立（`dsh-diagnostic-tools`，许可 **MIT**），两个子目录首次合仓：
  - `closure/` —— 依赖闭包体检 4 件（解耦检查 / 闭包指向体检 / 修法 / 共享判据库），首个公开版本 **0.1.0**
    （内容变更见 `closure/CHANGELOG.md`）；
  - `attachments/` —— 会话图片附件对账二件（只读对账 + 按需取回），首个公开版本 **0.1.0**
    （内容变更见 `attachments/CHANGELOG.md`）。
- 仓级件：`README.md` / `LICENSE` / `CHANGELOG.md` / `docs/RELEASING.md` / `.gitignore`。
