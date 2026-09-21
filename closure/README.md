# 依赖闭包体检工具组（`closure/`）

> **本目录是 [`dsh-diagnostic-tools`](../README.md) 仓的 `closure/` 子目录**——也可以单独取用：
> 目录内自带 `LICENSE` / `CHANGELOG.md` / `docs/RELEASING.md`，**版本号与退出码与同仓的
> `attachments/` 各自独立**（两类工具变更节奏不同，不互相牵动）。
>
> **一句话**：一套**只读**诊断工具，治「宿主（主包）一升级，插件就静默崩或判定悄悄失准」这类最难查的问题。
>
> **零 npm 依赖**（只用 Node 标准库）· **默认只读**（唯一的写操作要显式加 `--apply`）· **零个人数据**（不读会话内容、不读凭据、不联网）。

---

## 1. 它解决什么问题

用插件扩展宿主的项目，迟早会遇到同一类事故：

| 症状 | 真因 |
|---|---|
| 宿主升级后，某些插件**启动就崩** | 插件在代码里 `import` 了宿主的**运行时符号**，宿主把那个符号删了/改名/拆包了 |
| 升级后没人发现，直到用户报错 | 副本/适配层**静默过期** —— 代码里跑的还是旧行为 |
| 换机、多版本共存、测试实例跑过之后，生产**重启就崩** | 多个安装**共用同一份依赖闭包**，其中一个安装启动时按自己的主包位置改写了共享链接 |
| 「明明昨天还好」 | 判定用的**词表/事件名**被宿主改了，插件按旧名字监听 → 不报错，只是不工作 |

本工具组把这两类问题的**判据固化成可复跑的检查**：

- `check-decoupling` —— **代码面**体检（R1–R5），回答「我的插件有没有和宿主硬绑定」
- `closure-check` —— **依赖闭包面**体检，回答「我的依赖链接有没有被别的安装改写」
- `repair-closure-links` —— 前者的**修法**（默认 dry-run，逐条可证、可回滚）

---

## 2. 仓库结构

```
dsh-diagnostic-tools/closure/
├─ check-decoupling.mjs          解耦体检（R1–R5），只读、幂等
├─ closure-check.mjs             依赖闭包链接指向体检，只读
├─ repair-closure-links.mjs      闭包链接修复（默认 dry-run；--apply 才写盘，带回滚清单）
├─ lib/
│  ├─ closure-links.mjs          闭包扫描/分类/归因/修法探测（判据唯一源）
│  └─ runtime-config.mjs         路径与污染特征解析层（CLI > 环境变量 > 自动探测 > 默认）
├─ scripts/
│  ├─ verify-source.mjs          静态验证：语法 + 配置行为 + 脱敏扫描（发布前必跑）
│  └─ test-fixtures.mjs          干净夹具验证：4 种判定 + dry-run 不回退 + 特征可注入
├─ examples/
│  ├─ closure-tools.config.example.json   环境变量/参数对照示例
│  └─ vocab.example.json                  宿主词表示例（R4 用）
├─ docs/RELEASING.md             版本策略 / 变更记录规范 / 发布前检查单
├─ README.md · CHANGELOG.md · LICENSE
```

节点要求：**Node ≥ 18**（无第三方依赖，无构建步骤）。

---

## 3. 规则表

### 3.1 代码面：R1–R5（`check-decoupling.mjs`）

| # | 判什么 | 级别 | 计入退出码 | 怎么修 |
|---|---|---|---|---|
| **R1** | 插件 `import` 了宿主包的**运行时符号** | 🔴 **hard**：静态 `import` / 裸副作用 `import`（编译期硬绑定，宿主删符号即崩）｜🟡 **soft**：动态 `import()` / `require()` / 空绑定（可在 `try/catch` 内降级兜底） | hard **计入**（soft 不计） | 改成 `import type`（编译期擦除），或把唯一那处接触面收进**单一适配模块** |
| **R2** | 插件的依赖面没归零 | 🟡 提示 | 不计入 | `dependencies` 应为空；`dsh.client.inject` 尽量为空（宿主提供的东西不要写进依赖） |
| **R3** | 用到的宿主 ctx 服务 / 事件名**没有登记** | ℹ️ 只提醒 | 不计入 | 维护一份登记表（每包一节：服务名 / 事件名 / 失效症状 / 复验方式），升级时逐条核对 |
| **R4** | 功能代码里出现**裸宿主事实字面量**（事件名 / ctx 服务名） | 🟡 默认只提醒 | 仅 `--strict-r4` 计入 | 换成适配层的**语义接口**（`是否某类回合` / `有没有某服务`），别在功能代码里写名字；豁免：适配层自身、测试夹具、注释 |
| **R5** | 适配层**副本**的内容 ≠ 唯一源 | 🔴 | **配置了校验器才计入**（没适配层机制的项目 R5 显示 ⚪ 跳过） | 用你们的同步器重新生成副本；本工具只比对、不生成 |

R1 的「hard / soft」分级为什么要分开：soft 那类（动态 import）只要调用点真有 `try/catch` 兜底，宿主删符号时插件**能降级而不崩**；hard 那类是编译期绑定，宿主一删就必崩。

### 3.2 闭包面：链接指向（`closure-check.mjs`）

判据一句话：**链接层里每个链接都应指向「期望闭包根」**。

| 判定 | 含义 | 退出码 |
|---|---|---|
| 🟢 `ok` | 全部链接指向期望闭包 | 0 |
| 🔴 `danger` | 有链接**命中污染特征**（默认特征 = 指向另一个 DSH 安装的依赖目录） | 1 |
| 🟡 `warn` | 没有污染，但有**断链**（目标不存在） | 2 |
| ⚪ 不可用 | 链接层不存在 / 期望闭包根解析不出来 | 3 |

> 「污染特征」是**可配置**的，不是写死某个环境的策略：`--pollution-pattern <正则>`（可重复）或环境变量
> `CLOSURE_POLLUTION_PATTERNS`（逗号分隔）。默认两条特征面向「一台机器上装了多个 DSH 实例」的场景。

---

## 4. 配置：路径与特征全部可注入

解析优先级（高 → 低）：**CLI 参数 > 环境变量 > 自动探测 > 内置默认**。
任何时候都可以用 `--print-config` 看「这次到底用的是哪一份、从哪来」。

### 4.1 参数与环境变量对照

| 含义 | CLI | 环境变量 | 默认（自动探测） |
|---|---|---|---|
| 链接层（要体检的目录） | `closure-check --link-root <dir>`<br>`repair… --link-root <dir>` | `CLOSURE_LINK_ROOT` | `<DSH home>/profiles/node_modules`；`<DSH home>` = `BUTLER_DSH_HOME` > `DSH_HOME` > `~/.dsh` |
| 某 profile 的依赖目录 | `check-decoupling --profile-root <dir>` | `DECOUPLING_PROFILE_ROOT` | `<DSH home>/profiles/<profile>/node_modules`（`--profile`，默认 `web`） |
| 期望闭包根 | `--source-root <dir>` | `CLOSURE_SOURCE_ROOT` | 自动探测：全局包管理器的 `<nm>/@deepseek-ai/dsh/node_modules`（Windows `%APPDATA%\npm\node_modules`、`~/.npm-global/lib/node_modules`、`/usr/local/lib/node_modules` …）；探测不到 → **判「环境不可用」，绝不猜** |
| 全局 npm 顶层（修法的次级候选） | `--npm-root <dir>` | `CLOSURE_NPM_ROOT` | 同上自动探测 |
| 污染特征 | `--pollution-pattern <正则>`（可重复） | `CLOSURE_POLLUTION_PATTERNS` | 两条内置特征（见 §3.2）；注入即**整体替换** |
| 备份/回滚清单落点 | `--archive-root <dir>` | `CLOSURE_ARCHIVE_ROOT` | `<包根>/.backups/closure-link-repair-<时间戳>/` |
| 扫描根（解耦体检） | `--root <dir>` | `DECOUPLING_SCAN_ROOT` / `DSH_TOOLS_DIR` | `cwd/tools`（存在时），否则 `cwd` |
| profile 侧自研包名 | `--profile-pkgs a,b` | `DECOUPLING_PROFILE_PKGS` | **空**（不是所有人都需要这一层） |
| R4 词表 | `--vocab <file>` | `DECOUPLING_VOCAB` | 内置词表 + 宿主适配层唯一源里扫出来的事件名 |
| 适配层唯一源 | `--adapter-source <file>` | `DECOUPLING_ADAPTER_SOURCE` | `<扫描根>/lib/host-adapter.mjs`（不存在不算错） |
| 适配层副本校验器 | `--adapter-verifier <file>` | `DECOUPLING_ADAPTER_VERIFIER` | 自动探测 `<扫描根>/sync-host-adapter.mjs`（模块需导出 `verifySummary()`） |

`.example` 文件里有一份可直接抄的对照（`examples/`）。

### 4.2 换一个宿主包名

工具默认假设受检宿主是 `@deepseek-ai/dsh`。如果你的宿主叫别的名字：

```bash
CLOSURE_PACKAGE_NAME=@your-scope/your-host node closure-check.mjs --print-config
```

---

## 5. 用法

### 5.1 代码面体检（只读，默认不写文件）

```bash
node check-decoupling.mjs                    # 人读报告
node check-decoupling.mjs --quiet            # 一行摘要（适合塞进日报/CI 日志）
node check-decoupling.mjs --json out.json    # 额外写 JSON 报告（默认不写任何文件）
node check-decoupling.mjs --print-config     # 排障：这次的路径/词表/校验器从哪来
```

退出码：`0` 无硬违规且 R5 一致（或跳过）｜`1` 有硬违规 / R5 不一致 / （`--strict-r4` 时）R4 命中｜`2` 用法错误或扫描根不存在。

### 5.2 闭包面体检（只读）

```bash
node closure-check.mjs                       # 人读报告
node closure-check.mjs --quiet               # 判定行
node closure-check.mjs --json                # 机器读（含全量清单 + 路径解析 + 归因 + 修法探测）
```

判定出 🔴 时，报告会带**归因**（哪些链接命中了哪条污染特征）和**处置建议**（探测到的修法脚本命令）。

### 5.3 修法：dry-run → apply → 复核

```bash
# ① 先看计划（默认就是 dry-run，不写任何文件）
node repair-closure-links.mjs

# ② 确认无误再执行：自动写回滚清单 → 逐条重建/删除 → 复扫
node repair-closure-links.mjs --apply

# ③ 按回滚清单还原（relink 项改回原目标；remove 项重建 —— 原目标不在就报告，不造物）
node repair-closure-links.mjs --rollback "<备份目录>/rollback-<时间戳>.json"

# ④ 复核
node closure-check.mjs --quiet     # 期望退出码 0
```

### 5.4 放进日常巡检

三个脚本都是**幂等只读**（除 `--apply`），可以直接塞进启动脚本或定时任务：

```bash
node closure-check.mjs --quiet   || echo "依赖闭包指向异常，退出码 $?"
node check-decoupling.mjs --quiet || echo "解耦体检有违规，退出码 $?"
```

---

## 6. 兼容性

| 项 | 情况 |
|---|---|
| Node.js | **≥ 18**（实测 20 / 24）。零第三方依赖，无构建步骤 |
| 操作系统 | Windows 与 POSIX 均可跑。链接创建/删除优先用 `fs` API；Windows 上另有非递归 `rd` 兜底 |
| 链接类型 | 目录 junction / 目录 symlink 均可；**只处理链接本身**，从不递归删目录 |
| 宿主版本 | 工具**不 import 宿主任何东西**，只读文件与链接 ⇒ 自身不受宿主升级影响；R1/R4/R5 的判据是「你们自己的适配层与词表」 |
| 需要宿主在跑吗 | **不需要**。三个脚本都不连端口、不读会话、不要求宿主进程存在 |

---

## 7. 安全边界

- **默认只读**：`closure-check` / `check-decoupling` 全程只读；`repair-closure-links` 不加 `--apply` 时**不写任何文件**（有测试夹具断言，见 §8）。
- **不造物**：期望闭包里没有同名包时，修法是**只删链接**，绝不「按包名凭空重建」。
- **不递归删**：删链接只作用于链接本体（`unlink` → `rmdir` → Windows 非递归 `rd`），每条都断言「链接已消失 **且** 原目标仍在」，目标被连带删会立刻报错。
- **判不了就不动手**：期望闭包根解析不出来时，`--apply` 直接拒绝执行（fail-closed）。
- **回滚清单**：每次 `--apply` 先写清单（含每条链接的原目标），可一键还原；清单**不含**主机名等环境标识。
- **不联网**：三个脚本与两个验证脚本都不发任何网络请求。
- **不含个人数据**：不读会话记录、不读凭据、不读用户目录内容；只读链接与包目录的存在性。

---

## 8. 验证（任何人可复跑）

```bash
# 静态验证：语法 + 配置层行为 + 脱敏扫描
node scripts/verify-source.mjs .
#   期望末行：ALL CHECKS PASSED
#   要在你自己的机器上覆盖「机器名/用户名/本机目录名/同步产品名/内部专有名/私人称呼」，先注入再跑：
#   BUILD_MACHINE_NAMES=... BUILD_USER_NAMES=... BUILD_LAYOUT_ROOTS=... BUILD_SYNC_PRODUCTS=... \
#   BUILD_INTERNAL_TERMS=... BUILD_PERSONAL_TERMS=... \
#     node scripts/verify-source.mjs .
#   （多个值用逗号分隔，分号与竖线也认；不注入时只跑通用形态规则，脚本会打印注入条数=0 的提示，
#     属预期而非失败。后两项 —— 内部专有名与私人称呼 —— 形态上无法枚举，**不注入就等于没有这条
#     规则**，所以发布前务必带全；脚本另会用这些注入规则给**它自己**做一遍自检，
#     防止「扫描器夹带同一批标识」这种自欺。）

# 干净夹具验证：全部输入都是脚本现造的假闭包树，不碰任何真实安装
node scripts/test-fixtures.mjs
#   期望末行：断言 全过｜SKIP 0 项
#   覆盖：干净🟢 / 有污染🔴 / 只有断链🟡 / 链接层不可用 / dry-run 不回退 / 污染特征可注入 / 自动探测
node scripts/test-fixtures.mjs --clean   # 重建夹具（会重新创建链接）
```

夹具放在系统临时目录（固定路径 + 幂等复用，避免反复重建触发安全软件弹窗）。若你的安全软件拦截「创建链接」，脚本会把这些断言标成 `SKIP` 并打印原因 —— 允许后重跑即可。

---

## 9. 已知限制

1. **只判「指向对不对」，不判「包能不能用」**：闭包体检回答的是链接目标问题，不验证包能否被 `require`/`import` 成功。
2. **污染特征的默认值只覆盖常见形态**：默认两条特征面向「同机多个安装」这种场景；其它形态（CI 缓存目录、容器挂载点）需要你自己注入特征。
3. **R3 只是提醒**：工具无法知道「你的登记表长什么样」，因此不判定，只提示。
4. **R5 需要你自己提供校验器**：本工具不生成适配层副本，只比对；没有适配层机制时 R5 显示 ⚪ 跳过。
5. **R4 默认只提醒**：白的收敛期噪音因项目而异，用 `--strict-r4` 才计入退出码。
6. **修法只处理「命中污染特征的链接」**：断链只统计、不动（断链的成因与修法通常完全不同）。
7. **`--apply` 会改文件系统**（只在链接层内）：请先备份、先 dry-run、读完计划再执行；工具已内置回滚清单，但不替代你自己的备份策略。
8. **平台细节**：Windows 上删除目录 junction 偶尔需要非递归 `rd` 兜底；POSIX 上不提供该兜底（`unlink` 对符号链接已足够）。

---

## 10. 与内部版的差异（开源化改造说明）

本仓库是从一套内部工具**通用化**而来。为可复跑与可移植，做了四类改造：路径/特征外置可注入、默认值改为自动探测、
去掉所有个人与内部标识、补齐合规件与自测脚本。逐文件清单见仓库提交信息与 `CHANGELOG.md`。

已知的行为差异（都是**默认值**层面，全部可显式恢复）：

| 差异 | 内部版 | 本仓库 | 恢复方式 |
|---|---|---|---|
| JSON 报告 | 默认写 `_tmp/…json` | **默认不写文件** | `--json <path>` |
| profile 侧扫描 | 默认扫一个固定包名 | **默认空** | `--profile-pkgs <a,b>` |
| R5 | 绑定内部同步器 | 需 `--adapter-verifier` 或自动探测到校验器才跑 | 提供校验器模块 |
| 修法备份目录 | 内部归档目录 | 包内 `.backups/`（已 gitignore） | `--archive-root` / `CLOSURE_ARCHIVE_ROOT` |
| 默认污染特征 | 写死某个具体测试安装名 | 形态判据（名字形如 `*-test` 的目录段 / `canary`） | `--pollution-pattern` / `CLOSURE_POLLUTION_PATTERNS` |

---

## 11. 许可与发布状态

- **许可：待定（pending）**。仓库暂附 **MIT** 全文（工具类便于他人内嵌），最终许可以维护者拍板为准；
  正式发布前请以 `LICENSE` 文件与本节口径为准，若变更会写入 `CHANGELOG.md` 的 `Changed` 段。
- **发布状态**：本副本**尚未发布**（未建远端仓、未打 tag、未发 npm）。发布流程见 `docs/RELEASING.md`。
