# 会话同步（阶段 1）实现说明

本文说明 `agent-drop` 中阶段 1 的实现：它由哪些包组成、同步目录里究竟有什么、导出与导入各自按什么顺序工作、每个 Session 会得到哪些状态，以及验收条目分别由哪些测试覆盖。行为规格见 [design/session-sync-phase-1.md](design/session-sync-phase-1.md)（阶段 1 设计稿），产品边界见[总览](design/session-sync.md)。

## 包结构

| 包 | 职责 | 关键导出 |
|---|---|---|
| `packages/session-sync-format` | 同步包的纯格式库：清单、事件对象、附件条目、portable `cwd`、摘要工具 | `SYNC_FORMAT_VERSION`、`encodeTreeManifest`、`decodeTreeManifest`、`encodeEventObject`、`decodeEventObject`、`encodePortableCwd`、`resolvePortableCwd`、`isAddressablePortableCwd`、`sha256Hex` |
| `packages/session-sync` | 同步服务 `ctx.sessionSync`：导出、导入、扫描流水线，比较规则与操作状态 | `SessionSyncService`、`SessionSyncBackend`、`runExport`、`runImportTree`、`scanTree`、`portableCwdSkipReason` |
| `packages/session-sync-dir` | 唯一的阶段 1 后端：本机目录上的暂存发布与核验读取 | `DirSessionSyncBackend` |
| `packages/session-sync-web` | 独立页面与同源 API | `sessionSyncPageHtml`、路由常量 |
| `packages/session-sync-client` | 会话菜单"导出会话" action、键盘命令 `sessionSync.exportSession` 与结果 toast | 浏览器半区 `apply`、导出提交/轮询客户端 |

服务与后端之间是 seam：服务拥有格式、比较与操作语义，后端拥有介质的写入顺序、替换规则、摘要核验与路径布局。阶段 1 只交付 `dir` 实现。

## 介质布局

```text
<root>/dsh-session-sync/
  objects/events/<sha256>.jsonl
  objects/attachments/<sha256>
  trees/<rootSessionId>/<treeRevisionHash>.json
  tmp/
```

- 事件对象是当前逻辑事件的规范编码，每行一个事件，保留原序号。
- 每个对象与每份清单都以自身字节的 SHA-256 命名；`treeRevisionHash` 是清单规范字节的摘要。
- 清单携带格式版本、根 Session 与按依赖排序的全部后代、每个 Session 的 portable header、`inheritedEventCount`、事件数量与对象摘要，以及附件条目（原引用标识 + 对象摘要）。
- 允许后一次发布替换同一路径上的不同内容；介质不保留旧字节。`tmp/` 下的暂存文件不是导入入口。
- 不支持的格式版本会被明确拒绝，不猜测兼容方式。

`cwd` 在同步包中只有一种表示：`{ "kind": "home-relative", "components": [...] }`。导出端解析真实 home 与 `cwd`，计算相对组件；`cwd` 等于 home 时 `components` 为空数组。任一组件为 `..`、`cwd` 不在 home 内、或无法解析时，整棵树在发布任何对象之前 `skipped`。

## 导出

1. 选择一棵根 Session，追溯完整谱系；谱系不完整时拒绝导出。
2. 对 live Session 先经持久化屏障 flush，再固定本次快照的事件上界；导出期间追加的事件留给下次导出。
3. 通过逻辑持久化句柄读取每个 header、事件与继承计数，通过附件存储读取每个被引用附件的原始字节。
4. 先发布全部对象，**最后**发布树清单；每次发布都读回校验最终字节。

结果按树报告：`exported`、`skipped`（portable `cwd` 无法表示）或 `failed`（读取、校验或发布失败），并携带逐 Session 的事件计数。

## 导入

1. 读取介质上每个可见清单，核验清单自身摘要与格式版本。
2. **整树预检**：每个 Session 的 portable `cwd` 必须能在本机寻址。任一组件为 `..` 或目标平台不接受时，整棵树 `skipped`：不创建目录、Workspace、Session 或附件。
3. 核验每个引用对象：对象缺失 → 该 Session `pending`（可重试）；对象已到但摘要错误、结构非法 → 整棵树 `failed`，不写入任何内容，也不导入其余 Session。
4. 解析 portable `cwd` 为本机绝对路径，必要时安全创建目录（`0o700`），`realpath` 后校验仍在 home 内，并登记或复用 Workspace 记录；结果报告自动创建的目录及其是否为空。
5. **先恢复附件，再写入引用它的事件**：图片按原引用与精确字节恢复（经 `commitPreparedImageFile` 发布到内容寻址路径），摘要不符即拒绝；文件按原引用写回。挂载的 provider 不具备本地恢复能力（非 `attachment-local` 或未挂载）时，**静默放弃附件同步**：不读对象、不落附件，会话事件照常导入。
6. 逐 Session 比较本地历史并写入：

| 本地与远端关系 | 动作 | 状态 |
|---|---|---|
| 本地不存在 | 创建同 id、同逻辑 header、同继承计数的 Session，再写入事件 | `created` |
| header 与事件完全一致 | 跳过 | `skipped` |
| 本地事件是远端前缀 | 只追加远端后缀 | `appended` |
| 远端事件是本地前缀 | 跳过，不回退本地 | `skipped` |
| header 身份字段不一致，或事件分叉 | 不写冲突 Session，保留双方 | `conflict` |
| Session 正在运行 | 不强行取得写句柄 | `failed`（含原因） |
| 对象未到齐 | 不写入 | `pending` |

比较与写入之间会通过写句柄本身重新确认本地历史，因此重试从中断处继续且不重复追加；`SessionAlreadyExistsError` 之类的创建竞争会退回 `open('write')` 路径。

树的最终状态由逐 Session 结果聚合：任一 `failed` → 树 `failed`；否则任一 `conflict` → 树 `conflict`；否则任一 `pending` → 树 `pending`；全部 `skipped` → 树 `skipped`；否则 `imported`。

### 一次导入里的多个修订

同一桶下可能同时存在同一棵树的多个修订（介质不删除旧清单）。导入按“事件总数少者先、多者后”的稳定顺序处理，因此：

- 每个修订都独立按内容比较，不按文件名判断新旧；
- 最完整的历史最后应用，最终状态与报告不依赖文件系统枚举顺序；
- 先应用旧修订、后应用新修订时，旧修订只会得到 `skipped`，不会回退本地历史。

## 入口

- 独立页面 `/session-sync`：列出根会话（含已归档标注）、提交导出/扫描/导入、轮询操作状态、经 dsh Settings 编辑 `root`。所有数据路由经 connection 服务的信任围栏（Host/Origin + 浏览器认证），写请求要求 `application/json`，忙碌时返回 409。
- 浏览器端插件 `session-sync-client`：会话行 "..." 菜单的"导出会话"（order 500）与键盘命令作用于主会话；提交同一导出 API 并轮询至结算，`shell.overlay` toast 报告结果。请求的 id 可以是树中任意会话——导出管线先解析谱系根，再总是发布整棵树。

页面提交共用服务的一把互斥锁：操作进行时再提交会得到可读的“正在执行”结果（HTTP 409）。Host 重启后不重放任何操作，页面重新扫描介质。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `root` | 未设置 | 外部云盘客户端复制的本机同步目录。声明为 volatile，随产品交付的页面经 dsh Settings 编辑，数值实时生效；未设置时拒绝一切提交。 |

受理时同步校验 `root`：必须是完整限定的目录路径，且不得与 harness home、会话存储根或附件存储根重叠。解析与写入都使用规范化后的真实路径；符号链接不会把一次写带出已解析 root。

## 对 Harness 源码零修改

导入已规范化图片需要按原引用写回附件存储。本仓库**不修改 Harness 源码、不附带补丁、不依赖未来 Harness 新增能力**，恢复逻辑全部落在插件侧的 `packages/session-sync/src/restore-image.ts`：

1. `localRestoreRoot` 探测挂载的 store 是否暴露内容寻址根（只有 `attachment-local` 具备：公开导出 `commitPreparedImageFile`，其 `root` 为公共只读字段）；
2. 具备 → 以记录引用与精确字节调用 `commitPreparedImageFile`：它先核验 SHA-256 摘要与字节数，再把字节不可变发布到内容寻址路径（暂存、fsync、硬链接、EEXIST 去重、只读化），绝不重编码；
3. **不具备 → 静默放弃整份附件同步**：不读取附件对象、不写任何附件，会话事件照常导入，不报错、不标记 `failed`。将来某台设备的会话附件因此缺失时，重新导入一次即可补齐。

与早期补丁版本的差异：补丁在恢复时额外用 `probeImage` 复核宽高与媒体类型；现在由摘要绑定保证字节与引用一一对应（导出端读回时已核验过元数据），恢复端不再重复探测。摘要不符仍会拒绝——那是同步包损坏的信号，不应静默吞掉。

## 验收对照

| 设计稿验收 | 覆盖测试 |
|---|---|
| 1. A 导出的根会话、子会话与附件在 B 完整导入，逻辑事件、谱系、附件字节一致 | `packages/session-sync/tests/engine.spec.ts` |
| 2. 重复导入不重复事件；B 续写后导回 A 连续；本地领先不回退；双端分叉不自动合并 | `engine.spec.ts`、`import-cases.spec.ts`（conflict） |
| 3. 目标目录已存在则复用、不存在则创建并确保 Workspace 与归属；portable `cwd` 往返一致；同步包不含设备绝对路径 | `engine.spec.ts`（`createdDirectories`、manifest 文本不含 home） |
| 4. 清单先到、对象延迟 → `pending`，到齐后成功；摘要错误、非法路径、格式不支持时拒绝写入 | `import-cases.spec.ts` |
| 5. 发布、附件恢复、Session 创建与追加中断后重试达到完整状态且不重复追加 | `import-cases.spec.ts`（pending→重试）、`engine.spec.ts`（重复导入） |
| 6. 独立页面可选择会话、导出、导入、查询状态、编辑配置 | `packages/session-sync-web/tests/web.spec.ts` |
| 7. 忙碌、路径不匹配、非法配置、未授权请求与并发提交都给出可理解结果；未完成不显示为成功 | `web.spec.ts`（409/401/CSRF）、`import-cases.spec.ts`（live Session） |
