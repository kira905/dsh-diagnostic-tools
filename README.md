# dsh-diagnostic-tools —— 诊断取证工具组

> **一句话**：一个仓、两个子目录，回答长期跑编码 agent 的人迟早会问的两个问题 ——
> **我的环境有没有坏**（依赖闭包 / 解耦）· **我的数据缺不缺**（会话图片实体）。
>
> **零 npm 依赖**（只用 Node 标准库）· **默认只读**（写操作要显式加 `--apply`，且留回滚清单）·
> **不联网** · **判据可复跑**（每个子目录自带验证脚本，不需要相信维护者的自述）。

---

## 设计依据

本工具组是「[ops-handoff-design](https://github.com/kira905/ops-handoff-design)」所述运维体系的一个实现，
设计依据（对应文档仓约定的固定四问）：

- **它为什么存在、边界在哪** → 见《只读监控面板的设计纪律》**§2 显示纪律（不可探测 + 原因）**、**§5 数据来源三分类（「通用化」的天花板在哪）**
- **它与宿主版本的兼容区间** → 见《多机交接与云中继》**§4.5「兼容性要求」**（另见本 README 第 6 节「现状与限度」）
- **本组件特有的坑与实测** → 见本 README 各子目录的「限度如实说」与「宿主版本适用性」两节；两个子目录都把宿主相关的名字**集中在一个文件**里，正是为了让升级时的回归面收敛
- **文档仓地址** → Gitee（镜像）<https://gitee.com/kira905/ops-handoff-design>
  ｜ GitHub（主）<https://github.com/kira905/ops-handoff-design>
  （文档仓的组件索引表回指本仓；两仓互链、版本各自独立）

> 设计稿里不写具体仓库地址（写死即死链），实现清单统一收在文档仓的组件索引表里——本仓只负责回链章节。

---

## 1. 你需要哪个？

| 你遇到的现象 | 用哪个子目录 | 入口 |
|---|---|---|
| 宿主（主包）升级后，插件**启动就崩** / 判定悄悄失准 / 换机后重启即崩 | **`closure/`** —— 依赖闭包体检 4 件 | `node closure/closure-check.mjs` |
| **含图的历史会话**一续聊就报传输错误（换过机器、或用过两台机器） | **`attachments/`** —— 附件对账二件 | `node attachments/attachments-audit.mjs` |

两者的共同点：**症状看着像别的问题**（一个像"插件质量差"，一个像"网络故障"），
按表面方向排障永远修不好 —— 所以各配一个**只读**工具，先把事实变成看得见的。

三个最反直觉的结论（先看这三条，再决定要不要往下读）：

1. **"插件在宿主升级后崩了"多半不是插件烂**，而是它 `import` 了宿主的**运行时符号**，而宿主把那个符号删了 / 改名 / 拆包了。
2. **多个安装共存时，一个安装启动会改写共享的依赖闭包链接** —— 于是"测试实例跑过之后，生产重启就崩"。
3. **"含图会话续聊报传输错误"不是网络故障**：图片实体只存在本机磁盘，同步方案默认不搬这些大二进制 ⇒ 换机后引用悬空。

---

## 2. 结构与安装

```
dsh-diagnostic-tools/
├─ README.md            仓级说明（本文件）
├─ LICENSE              仓级许可（MIT）
├─ CHANGELOG.md         仓级：只记结构级变更
├─ docs/RELEASING.md    仓级发布流程
├─ closure/             依赖闭包体检 4 件（解耦检查 / 闭包指向体检 / 修法 / 共享判据库）
│  ├─ README.md · CHANGELOG.md · LICENSE · docs/RELEASING.md
│  ├─ check-decoupling.mjs · closure-check.mjs · repair-closure-links.mjs
│  ├─ lib/ · scripts/ · examples/
└─ attachments/         会话图片附件对账二件（只读对账 + 按需取回）
   ├─ README.md · CHANGELOG.md · LICENSE · docs/RELEASING.md
   ├─ attachments-audit.mjs · attachments-fetch.mjs
   └─ lib/ · scripts/
```

**安装**（零依赖、无构建步骤）：

```bash
git clone https://github.com/kira905/dsh-diagnostic-tools
cd dsh-diagnostic-tools
node closure/closure-check.mjs --help        # 或 node attachments/attachments-audit.mjs --help
```

每个子目录的 README 里有完整的**用法表 / 参数 / 退出码含义 / 已知限制**。
`--help` 与 `--dry-run` 是安全的：**所有写操作都必须显式加 `--apply`**，且会先打印将要做的事与回滚清单。

---

## 3. 为什么合仓（而不是一件一仓）

**理由**

1. 同属「装一次就能自查两类问题」的心智：**我的环境有没有坏**（闭包 / 解耦）+ **我的数据缺不缺**（附件实体）；
2. 共享仓级 `README` / `LICENSE` / 发布流程 / 自检脚本形态，维护成本更低；
3. 两类工具的受众高度重叠（都在多机、多安装、长期跑 agent 的场景里出现）。

**代价与对策**

- 两个子目录的**版本号与退出码各自独立**（判据不同、变更节奏不同）⇒ 保留子目录级 `CHANGELOG.md`，
  仓级 `CHANGELOG.md` 只记**结构级**变更（新增子目录、仓名变更、许可变更）；
- 使用者 clone 一次会多拿一个用不上的工具 ⇒ §1 那张表负责分流，子目录 README 各自给「三行安装 + 用法表」。

---

## 4. 许可

**MIT**（见 `LICENSE`）。两个子目录各自也带一份同文本的 `LICENSE`，便于单独取用；
**合仓后以仓根 `LICENSE` 为准**，改许可必须三处一起改（见 `docs/RELEASING.md` §2）。

---

## 5. 版本与发布

- **子目录**各自 SemVer（当前均为 **0.1.0**，首个公开版本）；
- **仓级**用 tag 记录结构状态（当前 `v0.1.2` = closure 0.1.0 / attachments 0.1.0，仓级 tag 只随仓根文档更新推进）；
- 发布流程与检查单见 [`docs/RELEASING.md`](./docs/RELEASING.md)；**只发 Release，不发 npm**。

## 6. 现状与限度

- `closure/` —— 依赖闭包体检 4 件，已完成通用化改造；自带静态验证（语法 + 配置行为 + 脱敏扫描）
  与干净夹具验证（4 种判定 + dry-run 不回退）。
- `attachments/` —— 附件对账二件，同上，另外在**隔离的真实实例**上做过只读对账核对（不动生产数据）。
- **限度如实说**：两个子目录的判据都基于**当前宿主版本**的事件名 / 服务名 / 目录形态。
  宿主升级后这些**字符串契约**可能变化 —— 这正是 `closure/` 要体检的对象，也是为什么
  每个子目录都把宿主相关名字**集中在一个文件**（`lib/host-protocol.*` / `lib/closure-links.mjs`）里，
  而不是散落在功能代码中。

---

## 7. 相关组件

同属 DSH 生态的伴生组件，各自独立仓、独立版本、许可各自独立；它们都回链到同一份文档仓
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
（Gitee 镜像 <https://gitee.com/kira905/ops-handoff-design>）：

| 组件仓 | 做什么 | 与本工具组的关系 |
|---|---|---|
| `dsh-diagnostic-tools` | 依赖闭包体检 + 会话图片附件对账 | **本仓** |
| [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) | 只读生态总览面板（持续、三色、不落盘） | 分工互补：它回答**「今天怎么样」**（持续观察、只渲染不复算），本仓回答**「具体坏在哪、怎么修」**（离线、可复跑、带修法与回滚清单）——两者都只诊断，谁也没写谁 |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | 会话归档管理（列表 / 预览 / 恢复 / 删除 + 可选自动归档） | 本仓 `closure/` 的体检对象**包括它**：靠 `cordis.patch.yml` 的 insert 注册的组件，最容易在宿主编排变更后「实体缺失、启动不报」 |
| [`dsh-session-title-live`](https://github.com/kira905/dsh-session-title-live) | 会话标题跟着对话实时更新 | 同上：它把宿主契约集中在 `lib/host-protocol.js`，那份常量清单与本仓 `closure/` **要体检的是同一类风险**（宿主升级后字符串契约失效） |
| [`dsh-task-board-local`](https://github.com/kira905/dsh-task-board-local) | 自维护任务看板（卡片 = 一次真实会话 + 人工验收闸） | 它是"自研 + insert 注册"的代表件，也正是本仓 `closure/` 与宿主契约体检的**重点对象**；它的执行记录缺失（跨机并回）曾把本仓的判据坑出来一次——见《任务卡「假完成」与「被打断会话」的识别》 |
| [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) | 零依赖急救台：起不来 / 假死 / 要撤销改动 / 数据被删四类现场压成一个入口 | 分工：本仓是**离线专项体检**（升级前后主动跑），它是**现场分诊**（已经出事时先跑）——都不动手，都只出证据 |

> 组件之间**没有代码依赖**，也不共享运行时 —— 之所以互指，是因为它们回答的是同一类人的同一批问题
> （长期在自有机器上跑 agent：装得下、找得到、看得见、查得清）。谁装谁不装，互不影响。
