# 变更记录（仓级）

本文件**只记结构级变更**：新增 / 删除子目录、仓名变更、许可变更、发布流程变更。

两个子目录（`closure/` / `attachments/`）各自的功能变更**记在各自目录的 `CHANGELOG.md`**，不在这里汇总 ——
两边的版本号与退出码各自独立、变更节奏不同，汇总必然重复且容易不同步（理由见 README §3）。

---

## [Unreleased]

### Added

- 仓建立（`dsh-diagnostic-tools`，许可 **MIT**），两个子目录首次合仓：
  - `closure/` —— 依赖闭包体检 4 件（解耦检查 / 闭包指向体检 / 修法 / 共享判据库），首个公开版本 **0.1.0**
    （内容变更见 `closure/CHANGELOG.md`）；
  - `attachments/` —— 会话图片附件对账二件（只读对账 + 按需取回），首个公开版本 **0.1.0**
    （内容变更见 `attachments/CHANGELOG.md`）。
- 仓级件：`README.md` / `LICENSE` / `CHANGELOG.md` / `docs/RELEASING.md` / `.gitignore`。
