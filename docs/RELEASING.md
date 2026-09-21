# 发布流程（仓级 RELEASING）

本文件说明**这个仓怎么发版本**。子目录各自的版本策略、变更记录规范与检查单写在
各子目录的 `docs/RELEASING.md`（`closure/docs/RELEASING.md` · `attachments/docs/RELEASING.md`），
本文件不重复它们，只讲**仓级**的部分。

---

## 1. 两套版本号，互不牵动

| 层级 | 版本号 | 什么时候动 | 记在哪 |
|---|---|---|---|
| **仓级** | 无独立版本号，用 **tag** 记录结构状态（如 `v0.1.0`） | 只在**结构级**变化时打：新增 / 删除子目录、仓名变更、许可变更、发布流程变更 | 本仓 `CHANGELOG.md` |
| **子目录级** | `MAJOR.MINOR.PATCH`（SemVer） | 各自的功能变更 | `closure/CHANGELOG.md` · `attachments/CHANGELOG.md` |

**tag 策略**：一个 tag 记录"这一整套当时是什么状态"。打 tag 时，在 tag 说明里列出
两个子目录**当时的版本号**（例如 `v0.1.0`：closure 0.1.0 / attachments 0.1.0），
否则将来无法从 tag 反推内容。**不动子目录内容的结构级改动也要打 tag**（否则使用者无法定位）。

## 2. 发布前检查单

按顺序跑，任一项不过就不发。**两个子目录各跑一遍**（不是只跑一次）：

```bash
node closure/scripts/verify-source.mjs closure
node closure/scripts/test-fixtures.mjs
node attachments/scripts/verify-source.mjs attachments
node attachments/scripts/test-fixtures.mjs
```

- [ ] 上面四条全过；
- [ ] **带本机标识注入**再各跑一次 `verify-source`（`BUILD_MACHINE_NAMES` / `BUILD_USER_NAMES` /
      `BUILD_LAYOUT_ROOTS` / `BUILD_SYNC_PRODUCTS` / `BUILD_INTERNAL_TERMS` / `BUILD_PERSONAL_TERMS`）——
      不注入时只跑通用形态规则，**内部专有名与个人称呼没有可枚举的形态，只有注入才能拦住**；
- [ ] `git grep -nE "[A-H]:[\\\\/]"` 只应命中文档里的通用示例；
- [ ] 两个子目录的 `CHANGELOG.md` 已写、日期已填；
- [ ] 两个子目录的 `LICENSE` 与仓根 `LICENSE` **同文本**（都是 MIT）——**改许可必须三处一起改**；
- [ ] 子目录 `package.json` 的 `version` 与其 `CHANGELOG.md` 一致；
- [ ] 仓级 `CHANGELOG.md` 的 `[Unreleased]` 已按本次结构状态整理；
- [ ] 打 tag 时在说明里写明两个子目录的版本号（见 §1）。

## 3. 发布步骤

```bash
# 1) 子目录内容变更：各自改 package.json 的 version + 各自的 CHANGELOG
# 2) 结构级变更：整理仓级 CHANGELOG 的 [Unreleased]
# 3) 全套验证（见 §2）
# 4) 提交与打 tag（tag 说明里带子目录版本号）
git add -A
git commit -m "release: v0.1.0（closure 0.1.0 / attachments 0.1.0）"
git tag -a v0.1.0 -m "v0.1.0 — closure 0.1.0 / attachments 0.1.0"
git push origin main --tags
```

**只发 Release，不发 npm。** 本仓零依赖、无构建步骤，`git clone` 后 `node <脚本>.mjs` 即可运行；
发 npm 需要包名可用性核查与长期可用性承诺，等有外部使用者明确要求再评估。

## 4. 双端发布（Gitee 镜像 + GitHub）的实测坑

来自同一条开源支线的先例，仍适用：

1. **Gitee 建仓后默认是私有** —— 即便建仓请求里写了 `private: false`，实测建出来的仍是私有仓
   （匿名 API 一律 `404 Not Found Project`）。必须再显式 `PATCH /api/v5/repos/{owner}/{repo}`，
   **且必须带 `name` 字段**。
2. **空仓不能设公开**：内容推上去之前调那个 PATCH 会返回
   `422 {"error":{"base":["空仓库不支持设置为公开仓库"]}}` ⇒ **先 push，再 PATCH 公开**。
3. **权威判据 = 匿名视角**：带 token 读得到 ≠ 公开。匿名 `GET /api/v5/repos/{owner}/{repo}`
   返回 `private: false` 且匿名能取到文件内容才算数。
4. **重打过的 tag 推送会被拒**（提示像认证失败，其实是 non-fast-forward）→ **只对 tag 用 `--force`**，
   分支仍走非快进保护。
5. **Gitee 不因 push 自动建仓**：目标仓不存在时 push 直接 `404 not found`，建仓只能走 API 或网页。

## 5. 子目录单独取用

每个子目录都被设计成**单独复制出去也能用**（自带 README / LICENSE / CHANGELOG / RELEASING）。
若你只需要其中一个，按该子目录 README 的说明取用即可，不必整仓 clone。
