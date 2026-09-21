# 会话图片附件工具（`attachments/`）

> **本目录是 [`dsh-diagnostic-tools`](../README.md) 仓的 `attachments/` 子目录**——也可以单独取用：
> 目录内自带 `LICENSE` / `CHANGELOG.md` / `docs/RELEASING.md`，**版本号与退出码与同仓的
> `closure/` 各自独立**（两类工具变更节奏不同，不互相牵动）。
>
> **一句话**：把「含图会话一续聊就报传输错误」从**网络故障**还原成**附件实体不在本机**，并按 sha256 把缺的对象补回来。
>
> **零 npm 依赖**（只用 Node 标准库）· **不联网** · **不上传任何数据** · **默认只读**（只有取回/导出会写盘，且每个写操作都留回滚清单）。

---

## 1. 它解决什么问题

用编码 agent / 桌面 agent 的人，凡是**换过机器**或**用过两台机器**，迟早会遇到同一类怪事：

| 症状 | 真因 |
|---|---|
| 某个**含图的历史会话**一续聊就挂，报上游接口 `stream … failed` / `code=TRANSPORT` | 看着像网络抖动，其实是**历史图片的实体文件不在本机**：每轮请求在准备图片时会扫**全部历史消息**里的图，读不到实体就抛一个普通错误（不是传输层错误），被上层兜底逻辑归成了传输错误 |
| 重试、换网络、重启都无效 | 因为病因根本不是网络 —— 按网络排障永远修不好 |
| 只有「带图的历史会话」出问题，新会话正常 | 同上：新会话的图是本机刚存进去的，实体在位 |

根因链一句话：**图片实体只存在本机磁盘上**，而多数备份/同步方案默认**不搬**这些体积大的二进制（只搬配置与会话记录）⇒ 换到另一台机器后，会话记录里的图片引用成了**悬空引用**。

本工具包做两件事，一件事一个脚本：

- **`attachments-audit.mjs`** —— 只读对账：把「缺哪些对象 / 哪些会话受影响」变成**看得见的事实**（并区分「读不到环境」与「真的没缺」）；
- **`attachments-fetch.mjs`** —— 按 sha256 **按需取回**缺失对象：可从中转目录、对端目录、或本机自己的派生数据里补；另有导出（反向打包）与回滚。

---

## 2. 仓库结构

```
attachments-tools/
├─ attachments-audit.mjs       只读对账（会话引用的 sha256 vs 本机对象实体）
├─ attachments-fetch.mjs       按需取回 / 导出 / 回滚
├─ lib/
│  ├─ attach-refs.mjs          共享口径库：会话帧解析、引用收集、对象路径（**只读**）
│  ├─ attach-config.mjs        路径解析层：CLI > 环境变量 > 自动探测 > 默认
│  └─ dsh-home.mjs             home / workspace 解析
├─ scripts/
│  ├─ verify-source.mjs        静态验证：语法 + 配置行为 + 脱敏扫描（**发布前必跑**）
│  └─ test-fixtures.mjs        干净夹具验证：65 条断言，不碰任何真实数据
├─ docs/RELEASING.md           版本策略 / 变更规范 / 发布前检查单
├─ README.md · CHANGELOG.md · LICENSE · package.json · .gitignore
```

---

## 3. 安装（三步）

```bash
# 1) 需要 Node ≥ 18（用它自带的 zstd 支持；实测 20 / 24）。零第三方依赖、无构建步骤。
node --version

# 2) 把本目录放到任意位置即可 —— **不需要** npm install / pnpm install
cd <你放它的位置>

# 3) 自检（任何人可复跑，全部输入都是脚本现造的假数据）
node scripts/verify-source.mjs .    # 期望末行：ALL CHECKS PASSED
node scripts/test-fixtures.mjs      # 期望末行：断言 全过
```

没有全局安装步骤：直接 `node attachments-audit.mjs …` 就能用。想省事就加个 shell 别名：

```bash
alias attach-audit='node /path/to/attachments-tools/attachments-audit.mjs'
```

---

## 4. 用法

### 4.1 先对账（只读，最常用）

```bash
node attachments-audit.mjs                       # 全量对账（默认带缓存）
node attachments-audit.mjs --json                # 机器可读（给 CI / 报告用）
node attachments-audit.mjs --session <会话id>    # 只看一个会话
node attachments-audit.mjs --quiet               # 只出退出码（给开机脚本 / 交接挂点）
node attachments-audit.mjs --print-config        # 只看路径解析结果（排障）
```

首次全量耗时与你的会话总量成正比；命中缓存后通常一秒内返回。缓存是**单机状态**，可随时删除。

### 4.2 取回缺失对象

```bash
# 缺什么补什么：先看有哪些可用的取回源（只读）
node attachments-fetch.mjs --probe

# 从中转目录（先用对端 --export 导出到移动盘，再插到本机）
node attachments-fetch.mjs --all-missing --relay <中转目录>

# 直接指向对端的 attachments 路径（对端磁盘挂载着时）
node attachments-fetch.mjs --all-missing --from <对端 attachments 目录>

# 只补一个会话 / 只补指定对象
node attachments-fetch.mjs --session <会话id>
node attachments-fetch.mjs --hash <sha256> [--hash <sha256> …]

# 先干跑一遍看计划（不写盘）
node attachments-fetch.mjs --all-missing --from <目录> --dry-run
```

**取回源优先级**：`--from`（显式路径，可多个）→ `--relay`（中转目录）→ 本机派生源（按**内容 sha256** 命中即可自愈，不需要任何介质）。

### 4.3 反向：把本机附件导出成中转包

```bash
node attachments-fetch.mjs --export <目标目录>
# 产出 <目标目录>/objects/<前2位>/<sha256> + manifest.json；插到对端即可当 --relay 用
```

### 4.4 回滚（只删它自己写的那批）

```bash
node attachments-fetch.mjs --rollback <报告.json>
```

取回时会写一份报告（默认落在 `<workspace>/_tmp/attachments-fetch/<时间戳>-report.json`，可用 `--report` 指定），
报告里 `fetched[].target` 就是本次**新写**的文件；回滚**只删这些**，逐个文件删，**绝不递归删目录**。

### 4.5 放进日常巡检

```bash
node attachments-audit.mjs --quiet || echo "有缺失或环境不可读，退出码 $?"
```

---

## 5. 退出码表

**`attachments-audit.mjs`**

| 码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 无缺失（被引用的对象全部在位） | 无 |
| `3` | **有缺失** | `attachments-fetch.mjs --probe` → 取回 → 再对账 |
| `2` | 用法错（未知参数 / 参数缺值 / `--session` 不是合法 id） | 看 stderr |
| `4` | **环境不可用**（读不到会话根） | 检查 `DSH_HOME` / `--sessions-root`；⚠️ **这是 fail-closed：读不到 ≠ 没缺失**，别当成 0 用 |

**`attachments-fetch.mjs`**

| 码 | 含义 |
|---|---|
| `0` | 全部就位（含「本来就没有缺失」） |
| `3` | 有缺失**没找到源**（需要你带上介质或对端路径） |
| `4` | 有失败（写盘 / 校验失败）或环境不可用 |
| `2` | 用法错 |

> 「目标已有别的内容」这种**冲突**不计失败、也不改退出码，且**默认不覆盖**（要覆盖得显式 `--force`）。

---

## 6. 配置表

优先级（高 → 低）：**CLI 参数 > 环境变量 > 自动探测 > 内置默认**。
任何时候都能用 `--print-config` 看清「这次实际用的是哪一份、从哪来」。

| 含义 | CLI | 环境变量 | 默认 |
|---|---|---|---|
| DSH home | `--home <dir>` | `DSH_HOME` | `~/.dsh`（用户主目录下的 `.dsh`） |
| 工作区根 | `--workspace <dir>` | `DSH_WORKSPACE` | 由被重定向的 home 推导 → 否则当前工作目录 |
| 对象根（放实体文件的目录） | `--objects-root <dir>` | `ATTACH_OBJECTS_ROOT` | `<home>/attachments/v1/objects` |
| 会话根（可多个） | `--sessions-root <dir>`（可重复） | `ATTACH_SESSION_ROOTS`（多值） | `<home>/sessions` + `<home>/_archived-sessions`（存在才纳入） |
| 扫描缓存 | `--cache <file>` | `ATTACH_SCAN_CACHE` | `<home>/attach-scan-cache.json` |
| 中转目录（可多个） | `--relay <dir>`（可重复） | `ATTACH_RELAY_DIRS`（多值） | `<workspace>/_tmp/attachments-relay`（存在才算） |
| 显式取回源（可多个） | `--from <dir>`（可重复） | —— | 无 |
| 本机派生源（追加） | `--local-source <dir>`（可重复） | `ATTACH_LOCAL_SOURCES`（多值） | `<home>/dsh-imagegen/images`、`<home>/dsh-imagegen/gallery/images`、`<workspace>/generated` |
| 取回报告目录 | `--report <file>` | `ATTACH_REPORT_DIR` | `<workspace>/_tmp/attachments-fetch/` |

多值环境变量用 **逗号 / 分号 / 竖线** 分隔都可以（三种写法语义相同）。
`--no-cache` 强制全量重扫；`--no-local-sources` 关掉本机派生源。

**对象实体路径**（与 DSH 自身布局一致）：

```
<objects-root>/<sha256 前 2 位>/<sha256 全量小写十六进制>
```

---

## 7. 安全边界与落盘铁律

- **默认只读**：`attachments-audit.mjs` 全程只读（除自身缓存）；`attachments-fetch.mjs` 的 `--probe` / `--dry-run` 也不写任何文件。
- **不联网**：两个脚本都不发任何网络请求 —— 跨机补齐靠你带的介质或对端路径，没有任何云侧依赖。
- **不上传**：没有遥测、没有回传、没有第三方 SDK。
- **原子落盘**：写同目录临时文件 → 校验 sha256 → `rename` 原子落位 → 重读二次校验；任何一步不过就报失败，不留半截文件。
- **幂等**：目标已存在且内容一致 ⇒ skip；内容**不一致** ⇒ 报 conflict 且**不覆盖**（除非 `--force`）。
- **回滚只删自己写的**：只按报告里的清单逐个 `rm` 文件，**从不递归删目录**（所以回滚后可能留下空的 `<前2位>/` 目录，这是有意的保守行为）。
- **不做删除型清理**：工具从不主动删除任何对象（只增量补齐）。
- **缓存是本机状态**：缓存键 = 相对路径 + 文件大小 + mtime；它只影响速度，不影响结论，`--no-cache` 可绕开。

---

## 8. 兼容性

| 项 | 情况 |
|---|---|
| Node.js | **≥ 18**（用到 `zstd` 解压；实测 20 / 24）。零第三方依赖、无构建步骤 |
| 操作系统 | Windows / macOS / Linux 均可（路径处理走 `node:path`，无平台专属调用） |
| 会话文件格式 | 现行布局：`<会话目录>/session.jsonl.zstd`，**多帧 zstd 拼接**（逐帧解压）。布局若变，需改 `lib/attach-refs.mjs` |
| 对象布局 | 与 DSH 自身一致（sha256 前 2 位分片）。**先在一个假目录上试**再指向真实 home 是最稳的用法 |
| 需要 DSH 在跑吗 | **不需要**。脚本只读磁盘文件，不连端口、不调 API |
| 权限 | 只读对账任何权限都行；取回需要对 `<objects-root>` 有写权限 |

---

## 9. 已知限制

1. **只能治「实体缺失」，不能治别的传输错误**：本工具回答的是「对象在不在」，不判断上游服务是否可用。
2. **不自动跨机**：没有任何云通道 —— 必须你带介质（`--export` → 移动盘 → `--relay`）或对端磁盘在场（`--from`）。
3. **缓存键用 size + mtime**：把整个目录「复制过来」可能让 mtime 变而 size 不变，理论上存在误判为未变的风险 —— 结论可疑时加 `--no-cache`。
4. **`--verify-objects` 会读遍所有在位对象**：大库上明显变慢，默认关闭。
5. **报告含主机名**：`--json` 输出与取回报告里带一个 `host` 字段（来自你自己的机器），方便多机场景辨认来源；**外发前请自行处理**。
6. **不校验图片内容有效性**：只校验 sha256 与文件名一致，不解析图片本身是否损坏。
7. **本机派生源是启发式**：按内容 sha 命中才能自愈（图片被你重新编码/压缩过就命中不上），命中率取决于你的使用习惯。
8. **不做并发控制**：同一时间跑两个取回进程可能互相看到对方的中间态（原子 rename 保证不会写出半个文件，但没有跨进程锁）。
9. **`--session` 只做「路径包含 id」的匹配**：给的是前缀也能匹配，多个会话共享前缀时会一起算进来。

---

## 10. 验证（任何人可复跑）

```bash
# 静态验证：语法 + 配置层行为 + 脱敏扫描
node scripts/verify-source.mjs .
#   期望末行：ALL CHECKS PASSED
#   要在你自己的机器上覆盖「机器名 / 用户名 / 本机目录名 / 同步产品名 / 内部专有名 / 私人称呼」，
#   先把它们注入再跑（多个值用逗号或分号或竖线分隔，大小写不敏感）：
#     BUILD_MACHINE_NAMES=… BUILD_USER_NAMES=… BUILD_LAYOUT_ROOTS=… BUILD_SYNC_PRODUCTS=… \
#     BUILD_INTERNAL_TERMS=… BUILD_PERSONAL_TERMS=… node scripts/verify-source.mjs .
#   后两项（内部专有名 / 私人称呼）形态上无法枚举，**不注入就等于没有这条规则**；
#   脚本还会用这些注入规则给**它自己**做一遍自检，防止「扫描器夹带同一批标识」这种自欺。

# 干净夹具验证：全部输入都是脚本现造的假 home / 假会话 / 假对象树，落在系统临时目录
node scripts/test-fixtures.mjs
#   期望末行：结果：断言 全过（65 项）
#   覆盖：缺对象能报出 / 多帧与归档树 / 补齐归零 / 退出码 0·2·3·4 / --rollback 指纹对照 /
#         --dry-run 不写盘 / 冲突不覆盖 / 注入通道 / --export → --relay 往返 / --probe 只读
node scripts/test-fixtures.mjs --clean   # 先删掉夹具再重建
```

---

## 11. 与内部版的差异（开源化改造说明）

本工具是从一套内部运维脚本**通用化**而来。为了能在陌生环境直接跑，做了四类改造：
路径全部可注入、默认值改为自动探测、去掉所有个人与内部标识、补齐合规件与自测脚本。
逐文件对照见交付报告与 `CHANGELOG.md`。

已知的差异（都是**默认值 / 文案**层面，可用参数恢复）：

| 差异 | 内部版 | 本版 | 恢复方式 |
|---|---|---|---|
| home 环境变量 | 多认一个内部组件专用的变量名 | 只认 `DSH_HOME` | 设 `DSH_HOME` 即可（语义相同） |
| 工作区默认值 | 写死一个内部盘符路径 | 由 home 推导 → 否则当前工作目录 | `--workspace` / `DSH_WORKSPACE` |
| 中转目录候选 | 内置两个内部盘符路径 | 只有 `<workspace>/_tmp/attachments-relay` | `--relay` / `ATTACH_RELAY_DIRS` |
| 扫描缓存文件名 | 带内部组件名前缀 | `attach-scan-cache.json` | `--cache` / `ATTACH_SCAN_CACHE` |
| 报告 `kind` 字段 | 无（报告无类型标记） | 加了 `kind` 标记（`attachments-fetch` / `dsh-attachments-relay`）便于机器消费 | —— |
| 内部流程挂点 | 接在某内部交接流程里 | **不含**（本包是独立 CLI，挂点属使用者自己的事） | 自己包一层 |
| 退出码 / 判定口径 | —— | **完全一致**（同一套判据、同一批断言） | —— |

---

## 12. 许可与发布状态

- **许可：MIT**（见 `LICENSE`）。工具类项目，便于他人内嵌进自己的脚本或 CI。
- **发布状态**：本副本**尚未发布**（未建远端仓、未打 tag、未发 npm）。发布流程见 `docs/RELEASING.md`。
- **数据声明**：本工具不采集、不传输、不上传任何数据；报告里的主机名来自你自己运行的机器，仅用于多机场景辨认来源。
