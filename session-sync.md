# Session 跨设备同步：导入/导出设计

> 状态：Draft  
> 目标功能：通过 Dropbox / OneDrive / Google Drive / iCloud 等云盘目录，在多台设备之间同步 DeepSeek Harness Session。  
> 关联包：建议新建 `@deepseek-ai/dsh-session-sync`，不依赖、不扩展 `@deepseek-ai/dsh-session-log-export`。  
> 交付物：① `dsh-session-sync` 插件，只依赖显式的目录契约（§3.5），后端可选本地目录（`dir`）或云厂商 API 直连（`cloud`）；② 后者的授权与厂商适配实现（§3.4，可独立于 ① 存在），其中 WebDAV 类服务（坚果云 / Nextcloud / 自建 DAV）的适配见 §3.4.12。

## 1. 目标与非目标

### 目标

- 把指定 Session（根 Session + 子 Session 树 + 附件）导出到用户指定的云盘同步目录。
- 在另一台设备上导入该同步目录中的 Session。
- 保留：
  - Session header（`id`、`createdAt`、`cwd`、`parentSession`、`origin`、`isSeeded`、`delegationDepth` 等）
  - 完整事件日志、连续 `seq`、精确 `inheritedEventCount`
  - Session 树谱系
  - 被日志引用的图片和通用文件附件
  - 将导入的根 Session 重新绑定到本地 Workspace（在路径允许时）
- 云盘同步特性支持：
  - 文件可能延迟到达
  - 可能只同步到一半
  - 可能出现 Dropbox 风格的 `conflicted copy` 文件
  - session-sync 插件本体只依赖普通目录语义
- 实现云盘厂商授权（OAuth 2.0；对 WebDAV 类服务则是账号 + 应用专用密码，见 §3.4.12），并由一个 background 同步任务把远端 API 封装成目录同步，使 `<syncRoot>` 不必再依赖用户自备的云盘客户端。
- 把"插件依赖的目录行为"定义为显式契约（§3.5），使同步根可以是本地目录或云厂商 API 支撑的虚拟目录，插件代码不变。
- 幂等、可重试、fail-closed。

### 非目标

- 不做同一 Session 的实时多写合并。
- 不自动解决两端分叉的事件日志；默认隔离并上报冲突。
- 不同步工作区文件本身，只同步 Session 数据。
- 不同步运行时状态：jobs、PTY、终端状态、队列、approval 状态。
- 不同步派生数据：projection cache、SQLite FTS 索引、request-image 缓存。
- session-sync 的导出/导入逻辑不感知任何厂商 API，也不持有凭据；厂商访问只存在于 `SyncRootFs` 的 `cloud` 后端实现内（`dir` 后端完全没有）。（`cloud` 后端会让 Harness 进程持有 token，这是有意的取舍，见 §10.1）
- **不自建冲突检测**：冲突的检测责任归同步层 —— `dir` 靠云盘客户端（`conflicted copy`、延迟到达），`cloud` 靠厂商自身机制（`conflicted copy`、`MOVE` 到已存在目标失败、`ETag` / `rev` 不符、`409 DuplicateName` / `ConcurrentUpdate`）。`cloud` 后端**不维护 base 状态、不做"谁先谁后"的判定**，只把厂商给出的结论如实转述（§3.4.6）。
- 插件不解决后端层冲突，也不区分它是"客户端 conflicted copy"还是"厂商语义返回的冲突"；插件只做格式校验 + 前缀比较 + 隔离上报。后端由谁实现（外部客户端或厂商 API）对插件不可见。
- 不做内核挂载（FUSE / FSKit / File Provider / WinFsp）。目录语义在进程内实现即可，无需任何 OS 级文件系统组件（§3.6）。
- v1 不做端到端加密、不做增量压缩算法、不做自动垃圾回收。

---

## 2. 必须遵守的现状约束

从现有代码探索得到的硬约束：

1. **Session 日志是 append-only 的物理存储。**
   - 逻辑读取通过 `SessionPersistence.open(id, 'read'|'write')` 和 `SessionHandle`；
   - header 一旦创建不可变；
   - `cwd` 同时决定物理存储路径和 Workspace 归属校验。

2. **`cwd` 是 UI 可见性的关键字段。**
   - `ApiSessionList.list()` 会跳过 `cwd === undefined` 的 cold Session；
   - `SessionHistoryController.sourceFor()` 也会拒绝 `cwd === undefined` 的 Session；
   - 因此导出包必须保留有值的 `cwd`，导入也必须写回有值的 `cwd`。

3. **Workspace 归属是显式账本。**
   - `WorkspaceRegistry` 保存 `sessionIds`；
   - 成员资格要求 `realpath(header.cwd) === workspace.path`，且目录存在；
   - 首次初始化 Workspace 域时会按 cwd bootstrap，之后不会自动把新 Session 追加进已有 Workspace；
   - 导入如果需要分组，必须显式 `workspace.attachSession(sessionId)`。

4. **附件不在 Session 日志里。**
   - Session 事件只包含 `ImageAttachmentRef` / `FileAttachmentRef`；
   - 图片字节在 `<DSH_HOME>/attachments/v1/objects/...`；
   - 通用文件字节在 `<DSH_HOME>/attachments/v1/file-objects/...`，引用路径在 `<DSH_HOME>/attachments/v1/files/...`；
   - 同步包必须单独携带附件对象。

5. **子 Session 默认不出现在顶层列表。**
   - `origin: 'subagent'` 的行由 `ui-workspace` 隐藏；
   - 子 Session 通过父 Session 的 catalog 进入；
   - 同步时应当以根 Session 为单位导出整棵树，而不是只导一个子 Session。

6. **live Session 导出前必须 flush。**
   - 与 `dsh-session-log-export` 一样，需要通过 `ctx.sessions.get(id)` + `sessions.flush(session)` 把内存事件刷到持久化，再通过 read handle 读取。

7. **派生数据可以重建，不应同步。**
   - projection cache、SQLite 全文索引、request-image 缓存都可以在导入后按需重建。

---

## 3. 总体架构

### 3.1 分层与职责边界

整个功能分两层 + 一组可替换的后端实现，越往下越不感知上层语义：

| 层 | 职责 | 感知 Session 语义 | 接触云盘厂商 API |
|---|---|---|---|
| session-sync 插件 | 校验 / 导出 / 导入 Session 树与附件 | 是 | **否** |
| `SyncRootFs` 目录语义 | `read / write / rename / readdir / fsync` 等 8 个方法 | 否 | **否** |
| 后端实现 | 用本地目录或云厂商 API 兑现这些方法 | 否 | 仅 `cloud` 后端 |

**核心约束：session-sync 插件只按目录语义读写 `<syncRoot>`，永不持有云盘凭据、永不调用厂商 API。**
`<syncRoot>` 是一个**抽象的目录视图**：它可以是本地目录（`dir`），也可以是云厂商 API 直接支撑的虚拟目录（`cloud`）。插件不关心，也无法区分。

```text
┌──────────────────────────────────────────────────────┐
│ session-sync 插件（Host-only）                        │
│   export / import / scan                             │
└───────────────────────┬──────────────────────────────┘
                        │ 目录语义 = SyncRootContract (§3.5)
                        │ read / write / rename / readdir / fsync
┌───────────────────────▼──────────────────────────────┐
│ <syncRoot>/dsh-session-sync/   （抽象目录视图）        │
│   objects/  sessions/  trees/  tmp/                  │
└───────────────────────▲──────────────────────────────┘
                        │ 同一套目录语义（插件无感）
┌───────────────────────┴──────────────────────────────┐
│ 后端实现（二选一，测试另有 memory）                    │
│   dir   = node:fs/promises on 本地目录                │
│           └─ 由外部云盘客户端负责跨设备同步            │
│   cloud = 云厂商 API 直连（OAuth + index + journal）   │
│           └─ 无内核挂载、无本地镜像、跨平台纯 TS       │
└───────────────────────┬──────────────────────────────┘
                        │ HTTPS + OAuth 2.0 (PKCE)（仅 cloud）
        Dropbox / OneDrive / Google Drive / iCloud
```

这个分层是整个设计的关键：**厂商 API 被封在后端实现里，因此插件的正确性只依赖"目录语义"这一条假设**，不依赖任何厂商的锁、cursor 或一致性模型。后端是"真目录"还是"厂商 API 虚拟目录"，对插件完全透明。

> 注意层次含义的演进：插件依赖的从来不是"本地磁盘上的文件"，而是**一组目录行为**。把这组行为写成契约（§3.5）之后，`cloud` 后端才谈得上"等价于一个目录"——**契约先于实现**，否则用 API 实现目录只是把失败从"看得见"变成"静默"。

### 3.2 session-sync 插件

建议新增 Host-only 插件包：

```text
packages/session/session-sync/
  src/
    index.ts          # Cordis 插件入口、ctx.sessionSync 服务
    bundle.ts         # manifest 读写与校验
    export.ts         # 导出算法
    import.ts         # 导入算法
    attachments.ts    # 附件收集与还原
    conflicts.ts      # 前缀比较、冲突分类（插件侧判定；后端层冲突由同步层给出）
```

服务依赖：

```ts
export const inject = [
  'sessionPersistence',
  'sessions',
  'sessionQuery',
  'attachments',
  'workspaceRegistry',
]
```

可选依赖：

- `commands`：提供 `/sync export`、`/sync import`、`/sync status`
- `settings`：Web 设置页配置同步目录
- `connection` / `remote`：若需要 UI 触发导入导出

核心服务接口：

```ts
interface SessionSyncService {
  export(request: SessionSyncExportRequest): Promise<SessionSyncExportResult>
  import(request: SessionSyncImportRequest): Promise<SessionSyncImportResult>
  scan(signal?: AbortSignal): Promise<SessionSyncStatus>
}
```

**文件系统访问缝**：插件**不得直接 import `node:fs`**，所有目录访问走一个可注入的窄接口。这不是为了换掉本地磁盘，而是为了让 §3.5 的契约可以被替换实现（尤其是测试）并在运行时自检：

```ts
interface SyncRootFs {
  readonly kind: 'dir' | 'cloud' | 'memory'
  readonly declaredContract: readonly SyncRootClause[]   // 声明满足哪些条款，见 §3.5

  stat(path: string): Promise<Stats | undefined>
  readdir(path: string, opts: { recursive: boolean }): AsyncIterable<DirEntry>
  openRead(path: string): Promise<ReadStream>
  openWrite(path: string): Promise<WriteStream>          // 写 tmp 用
  rename(from: string, to: string): Promise<void>        // 提交点
  unlink(path: string): Promise<void>
  fsync(path: string): Promise<void>
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>
}

interface SyncRootFsFactory {
  create(config: { root: string; kind: 'dir' | 'cloud' | 'memory' }): Promise<SyncRootFs>
}
```

- `kind: 'dir'`：默认实现，`node:fs/promises`；
- `kind: 'cloud'`：云厂商 API 直连，见 §3.4；
- `kind: 'memory'`：测试实现，见 §3.6；
- 插件在 `scan()` 时把 `declaredContract` 与 §3.5 的必需条款取交集，缺一条就 fail-closed 并报 `SYNC_ROOT_CONTRACT_UNMET`。

配置示例：

```yaml
- name: '@deepseek-ai/dsh-session-sync'
  config:
    backend: dir                    # dir | cloud（memory 仅测试）
    root: ~/Dropbox/DSH Sync        # backend: dir 时的本地目录；建议显式配置
    selection:
      mode: session-tree            # session-tree | all-ordinary
      includeArchived: false
    cwdPolicy: preserve             # preserve | remap
    conflictPolicy: quarantine      # quarantine | keep-local
    importOnStartup: false
    exportOnIdle: false
```

配置校验必须拒绝：

- `root` 为空，且 `backend: dir`；
- `root` 与 `sessionPersistence.root` 重叠；
- `root` 位于任意 attachment root 内；
- `root` 位于 `$DSH_HOME/sessions` 内。

`backend: dir` 时 `root` 必须是**本机可访问的路径**。`backend: cloud` 时 `root` 不参与——远端路径与状态目录属于 `cloud` 后端的配置（§3.4.11），插件的配置里看不到厂商侧路径，也拒绝接受。`memory` 只允许出现在测试配置中。

### 3.3 后端 `dir`：本地目录（外部云盘客户端填充）

`SyncRootFs` 的最简实现：`kind: 'dir'`，直接落在 `node:fs/promises` 上，`<syncRoot>` 是一个普通本地目录。

- 谁把目录同步到别的设备：用户自备的 Dropbox / OneDrive / Google Drive / iCloud 桌面客户端；
- 本功能不参与、不检测、不配置；
- 优点：零凭据、零 API 成本、天然跨平台、离线可用、**用户可以直接用 Finder 查看和抢救数据**；
- 代价：客户端风格的文件名改写（`conflicted copy`）、延迟到达、半同步、客户端自身的 include/exclude 规则；

这是"现状"基线：**后端 `cloud` 完全没做时，session-sync 也必须可用**。

### 3.4 后端 `cloud`：云厂商 API 直连（OAuth + 内容寻址对象）

用云厂商 API 直接实现 `SyncRootFs` 的那 8 个方法，**不引入内核挂载、不维护本地完整镜像**。

#### 3.4.1 定位与三个关键决定

- **在 Harness 进程内**（v1）：一个后台任务 + 一个持久化索引，不是独立守护进程，也不是 kext；
- **没有本地镜像**：已存在的对象只存远端，本地只保存"索引 + 待上传字节"；
- **不依赖远端 rename 的原子性**：原子性由本地索引事务提供（见 §3.4.4），远端只是字节的最终归宿；
- **不做冲突检测**：冲突由厂商语义给出（`conflicted copy`、`MOVE` 到已存在目标失败、`ETag` / `rev` 不符），后端只转述、不判定（§3.4.6）。

需要意识到的取舍：

| 得到 | 失去 |
|---|---|
| 跨平台（纯 TS，无 kext / 无驱动 / 无平台分支） | 同步根**不再是人类可见的目录**：Finder / `ls` 看不到，用户无法手工抢救 |
| 不需要本地完整镜像，省磁盘 | Harness 进程持有 OAuth 凭据（§10.1） |
| 目录语义可控，契约 C1–C5 由自己实现而非"指望客户端" | 多了一个必须持久化且自身不能损坏的状态：索引 + 上传日志 |
| 少一个必须自己实现且必须正确的子系统（冲突检测） | 冲突只能"事后"在插件侧被发现，厂商不报就没人报（§3.4.6 已接受该代价） |
| 与后端 `dir` 共用同一套插件代码，零改动 | 无法被外部云盘客户端同时使用（会双写） |

#### 3.4.2 三个组成部分

1. **Provider 适配**（§3.4.7）：把 Dropbox / OneDrive / Google Drive 的对象读写，以及 WebDAV（§3.4.12）的目录读写，收敛成同一接口；
2. **本地索引 `index`**：内容寻址对象 → `{ state, sha256, bytes, remoteRev }`，状态只有 `staging` / `committed`。**`stat` 与 `readdir` 只暴露 `committed` 对象**。它是**可见性**的依据（§3.4.4），不是冲突判定的依据（§3.4.6）；
3. **上传日志 `journal`**：未完成上传的字节，append-only + 原子 rename，崩溃后可续传或安全重传。

职责划分：

- OAuth 2.0 授权：桌面端走 PKCE + 本地 loopback 回调；无浏览器环境走 device code flow；
- 凭据保管：写入 OS credential store（macOS Keychain / Windows Credential Manager / libsecret），**不进 `settings` 明文**；
- 远端 → 本地：按 cursor/delta 拉取对象与 manifest 清单，填充 `index`；
- 本地 → 远端：从 `journal` 上传，ack 后写 `index` commit；
- 分块上传：Dropbox `upload_session`、Google Drive resumable upload、OneDrive `createUploadSession`；
- 状态记录：远端 cursor / delta token、上次同步的 head revision、凭据失效时间；
- 可观测性：结构化日志（对象 hash、字节数、耗时），**不记录 Session 内容**。

#### 3.4.3 目录语义 → 实现映射

| `SyncRootFs` 方法 | `cloud` 后端的实现 | 关键点 |
|---|---|---|
| `stat(path)` | 查 `index`；miss 时查远端 metadata 并缓存 | 只对 `committed` 返回；`staging` 对插件不可见 |
| `readdir(path, {recursive})` | 远端 listing（cursor 增量）+ 本地 `index` 合并 | **必须包含其他设备发布的远端对象**（契约 C8） |
| `openRead(path)` | 远端流式下载；可带一层本地对象缓存 | 读到不完整或哈希不符 → 报错，**绝不返回脏数据** |
| `openWrite(path)` | 只写本地 `journal`，返回流 | 完全不碰远端 |
| `rename(from, to)` | ① 把 `journal` 中的 `from` 上传到远端最终名；② 远端 ack 后在一个索引事务里写 `to` 为 `committed` 并清掉 `from` | **提交点是索引事务，不是远端 rename** |
| `fsync(path)` | 把 `journal` 落盘（本地文件 fsync + WAL） | 只承诺本地持久，**不承诺远端可见**（契约 C6） |
| `unlink(path)` | 只作用于本地 `journal` / `index` | 默认不删远端（契约 C7） |
| `mkdir(path)` | 本地 `index` 记账；远端目录多为隐式 | 对象存储无真实目录语义 |

**关键收益**：§5.4 要求的"先写 tmp 再 rename"在插件侧一个字都不用改，只是 `rename` 的原子性从"依赖文件系统"变成"依赖我们自己的索引事务"——而索引事务是我们能完全掌控的。远端侧若某 provider 没有原子提交，适配层内部仍然做"远端 tmp 名 → move 到最终名"，但这个细节被 `rename` 封装掉了，插件看不到。

#### 3.4.4 状态机与原子性

```text
openWrite(tmp) ──写入──▶ journal: { state: staging, bytes… }
                            │
                      rename(tmp → 最终名)
                            │
                    ┌───────┴────────┐
                    │ 上传（可断点续传）│
                    └───────┬────────┘
                            │ 远端 ack（内容完整且最终名可用）
                            ▼
                   index 事务：commit(sha256, remoteRev)
                   state: committed  ◀── readdir / stat 从此可见
```

三个崩溃点，全部安全（指向同一结论：**先有完整字节，再有"存在"**）：

| 崩溃时机 | 残留 | 恢复动作 | 危险性 |
|---|---|---|---|
| staging 写入中断 | `journal` 有残片 | 重传或丢弃，对象从未可见 | 无 |
| 上传完成、index 未 commit | 远端已有完整对象 | 重启后按 `journal` 补 commit（幂等） | 无 |
| index commit 后另一设备尚未看到 | — | 属契约 C8 允许的延迟，非违约 | 无 |

跨设备发现走 `readdir` 拉远端 listing：**插件不能把"还没看到"当成"不存在"**，这正是 §6.1 把不完整 tree 判为 pending 而非 corrupt 的原因。

#### 3.4.5 必须保持的不变量

这些不变量一旦被破坏，§5.4 / §6.1 里"只读完整 bundle"的假设就失效：

1. **可见 ⇒ 完整**：`index` 只 commit 上传完成的对象；不允许"半截字节 + committed 状态"；
2. **不可变对象不覆盖**：远端目标名已存在且哈希一致则跳过，不做无意义重传；
3. **遵守提交顺序**：object 先于 revision manifest，revision manifest 先于 tree manifest；适配层不得提前暴露 manifest；
4. **不重写内容**：不重新压缩、不重新编码、不改文件名（冲突处理除外）；
5. **不静默丢弃**：厂商报冲突、报"目标已存在"或条件失败（`412`）时，必须保留双方并如实上报，禁止自行 last-writer-wins 覆盖掉一方。后端**不负责发现**冲突（§3.4.6），只负责**不掩盖**冲突。

对 `commitMode: 'remote-move'` 的 provider（WebDAV）：不变量 1 由"`PUT` 强制 `Content-Length` + 服务端整体写入"保证，不变量 2 由"`MOVE` 到已存在目标失败"保证。但这两条都是**服务端实现行为、不是 RFC 保证**（RFC 4918 的默认 `Overwrite: T` 反而是覆盖），因此必须按 §3.4.12 的探针逐次验证，违约即降级 `declaredContract` 并 fail-closed。

#### 3.4.6 与后端 `dir` 的冲突语义差异

**结论先行：`cloud` 后端不自建冲突检测。** 检测责任归"谁在同步"：

| | 后端 `dir`（客户端同步） | 后端 `cloud`（直连） |
|---|---|---|
| 冲突由谁产生 | 云盘客户端（Dropbox / OneDrive / iCloud） | 厂商服务端自身 |
| 冲突表现 | `*.conflicted copy` 文件名 | 厂商语义：`conflicted copy`、`MOVE` 到已存在目标失败、`ETag` / `rev` 不符、`409 DuplicateName` / `ConcurrentUpdate` |
| 后端职责 | 无（客户端的事，后端看不见） | **只如实转述，不做检测** |
| 插件侧假设 | 不信任文件名，一律按内容 JSON 校验（§7.3） | 完全相同（§7.3） |

因此 `cloud` 后端**不维护 base 状态、不做"谁先谁后"的判定**：

- 厂商 API 的 `modifiedTime` / `rev` / `etag` 只用来回答"远端变了没有"（省一次下载、避免无意义重传），**不用来回答"谁先谁后"**；
- 厂商报冲突或"目标已存在"时（`405 ResourceExisted` / `409 DuplicateName` / `ConcurrentUpdate` / `412`），后端**原样上报**为 `SYNC_REMOTE_CONFLICT`，双方字节都保留在远端，不自行覆盖；
- 厂商没报冲突时，后端**不做额外推断**。要不要把它判成冲突，是插件侧的事（§6.2 前缀比较 + §7 隔离）；
- **永不删除 revision**，GC 是插件侧或用户的显式操作（§15 开放问题）。

> 边界：§3.4.12.5 的 C4 探针**不是冲突检测** —— 它检查的是"服务端有没有守约"（写入有没有被静默覆盖），属契约自检。两者都读 `ETag`，但回答的问题不同：探针问"这个后端还能不能信"，冲突检测问"这次是谁覆盖了谁"。

**已决：接受"事后隔离"。** 既然后端不检测，"两台设备并发提交同一 Session 的 manifest"就只可能在**插件导入时**被发现（内容寻址路径多半不重叠，厂商也不会失败）。决定：**不引入** manifest 前驱校验、远端单写者标记或跨设备选举；冲突一律由导入计划（§6.2）的前缀比较识别，按 §7.2 `quarantine` 处置。代价明确且可接受 —— 冲突被延迟发现，但不会被静默覆盖；语义层冲突的唯一解决点因此收敛到**导入**（§7 开头）。单写者只在**单机**范围内由本地 lockfile 保证（§3.4.8）。

#### 3.4.7 provider 适配接口（示意）

```ts
interface SyncProvider {
  authorize(): Promise<Credential>
  refresh(c: Credential): Promise<Credential>
  revoke(c: Credential): Promise<void>
  changes(cursor?: string): Promise<{ entries: RemoteEntry[]; cursor: string }>
  putObject(path: string, source: ReadableStream, bytes: number): Promise<{ rev: string }>
  move(from: string, to: string): Promise<void>
  getObject(path: string): Promise<ReadableStream>
  statObject(path: string): Promise<RemoteMeta | undefined>
}
```

Dropbox 用 cursor，Google Drive 用 changes token，OneDrive 用 delta。适配层要把三者收敛成同一语义；无法收敛的能力（例如 iCloud Drive 没有面向第三方的文件级 OAuth API）直接判定为"该 provider 只能配后端 `dir`"。

注意 `putObject` 返回 `rev`：它是 §3.4.4 里 `index` commit 的依据，缺少 `rev` 的 provider 需要在适配层用内容哈希兜底。

#### 3.4.8 崩溃恢复与索引重建

- **`index` 是可重建的缓存**：从远端 `objects/**` 与 `trees/**` 全量重建（`/sync index rebuild`），重建期间不影响插件（插件只是看到目录变慢/变全）。它只记可见性（§3.4.4），不记冲突结论（§3.4.6），所以重建不会改变"谁和谁冲突"的判定；
- **`journal` 是不可重建的状态**：它是唯一"只存在于本地"的数据。丢失 = 未上传的对象丢失，必须显式警告用户，不能静默重来；
- `journal` 自身用 append-only + 原子 rename 维护，避免自己成为损坏源；
- 单写者：同一 `index` / `journal` 只允许一个运行实例，用 lockfile 防止两个 Harness 进程互相覆盖。

#### 3.4.9 进程模型

| 模型 | 说明 | 取舍 |
|---|---|---|
| **v1：Harness 进程内后台任务** | 异步上传队列 + 定期 reconcile；非阻塞启动 | 实现简单；但 Harness 进程持有云盘凭据 |
| 强化路径：独立 helper 进程 | provider 适配跑在独立进程，经本地 IPC 暴露同样的对象接口，Harness 只拿短期 capability | 凭据与主进程隔离；多一套 IPC 与生命周期管理 |

v1 选进程内，理由：**省掉 IPC 与单实例协调，且"非阻塞、可重入、崩溃可恢复"这三个性质由 §3.4.4 的状态机 + `journal` 保证，不靠进程隔离**。是否值得为凭据隔离引入独立进程，见 §15 开放问题。

#### 3.4.10 与 §8 跨设备路径问题的关系

OAuth 把**云盘路径**与**本地路径**解耦了，但**没有**解决 Session header 里 `cwd` 的跨设备问题 —— `cwd` 是 Harness 工作目录，与云盘路径无关。两者不可混淆：`remoteRoot` 可以是任意厂商侧路径，而 `cwdPolicy` 仍然是独立的策略。

#### 3.4.11 配置示例（独立于插件配置）

```yaml
syncCloud:
  enabled: false            # 显式启用才引导授权
  provider: dropbox         # dropbox | onedrive | gdrive | webdav
  remoteRoot: /DSH Sync     # 厂商侧路径，不是本地绝对路径
  stateDir: ~/Library/Application Support/dsh-sync/state   # index + journal
  intervalSeconds: 60
  credentialsRef: keychain:dsh-session-sync
```

`provider: webdav`（§3.4.12）用另一组字段，远端路径被拆成「sandbox + 路径」两段：

```yaml
syncCloud:
  enabled: false
  provider: webdav
  baseUrl: https://dav.example.com      # WebDAV 服务地址
  sandbox: DSH Sync                     # 网盘/同步盘名称；含特殊字符时需 URL 编码
  remoteRoot: /dsh-session-sync         # sandbox 内的路径，不允许为空或指向 sandbox 根
  username: user@example.com            # 非 secret
  stateDir: ~/Library/Application Support/dsh-sync/state
  intervalSeconds: 60
  credentialsRef: keychain:dsh-session-sync/webdav   # 存应用专用密码 ASP，绝不落配置文件
```

校验必须拒绝：

- 插件配置的 `root` 与后端 `cloud` 同时启用（插件会去读一个不存在的本地目录）；
- `stateDir` 位于 `$DSH_HOME` 内或与 `root` 重叠（状态与数据混放，重建时互相污染）；
- `stateDir` 同时被外部云盘客户端同步（`index` 会被跨设备同步，必然冲突）；
- `enabled: true` 但 `credentialsRef` 无有效凭据；
- `provider: webdav` 但 `baseUrl` / `sandbox` 为空；
- `provider: webdav` 但 `remoteRoot` 为空或指向 sandbox 根（后端只应写 `<sandbox>/<remoteRoot>/**`，避免与用户自己的文件混放）；
- `provider: webdav` 且 `sandbox` URL 编码后与服务端实际 sandbox 名不一致（首次连接必须 `PROPFIND /dav/` 校验其存在，见 §3.4.12 的沙箱陷阱）。

### 3.4.12 provider 适配：WebDAV（坚果云一类 DAV 服务）

接口依据：`DAV_API.md`（标准 DAV 接口，不含 `NsDav*` / `NSDav*` 扩展）。这一节回答一个具体问题：**当"云厂商 API"本身就是 WebDAV 时，§3.4 的哪些部分还需要、哪些部分不需要。**

#### 3.4.12.1 最重要的等价关系

`PUT`（写同目录临时名）+ `MOVE`（同目录改名到最终名）**就是 §5.4「先写 tmp 再 rename」的服务端版本**。由此：

- 插件的导出写入路径**一个字都不用改**；
- WebDAV 声明 `commitMode: 'remote-move'`，提交点从"本地索引事务"变成"远端 `MOVE` 返回成功"；
- §3.4.4 的状态机退化为 `PUT(tmp) → MOVE(final)`，`index` 从正确性边界降级为**纯缓存**；
- §3.4.1 的"不依赖远端 rename 的原子性"**对这一 provider 不成立**——它恰好依赖远端 `MOVE`，这正是它比对象型 provider 简单的原因。

**必须同父目录。** `DAV_API.md` §3.10：只有"同一 sandbox 且源和目标父目录相同"才走原子重命名路径，其他情况是"复制源对象 + 删除源对象"。所以：

- 临时对象**必须**写在目标对象的**同一目录**下，命名 `.dsh-tmp-<uuid>`（点开头）；
- **禁止**把 `<syncRoot>/dsh-session-sync/tmp/` 当作 WebDAV 的暂存位置 —— 跨目录 `MOVE` 不原子，直接破坏 C2；
- 对应地：`openWrite(from)` 的 `from` 只在**本地 journal** 中有效；远端暂存名由后端在目标目录内自行生成，插件传入的路径不参与远端布局。

#### 3.4.12.2 方法映射

| `SyncRootFs` | WebDAV 实现 | 关键点 |
|---|---|---|
| `stat` | `PROPFIND Depth: 0`（目录与文件都用它） | **集合 URI 带末尾 `/` 时 `HEAD` 返回 403**，不要用 `HEAD` 探目录；目录 `getetag` 通常为空 → 用 `getlastmodified`（RFC 1123）；目录 `getcontentlength` 固定为 `0`，**不能用长度区分空文件与目录**，必须看 `resourcetype` 是否 `<collection/>`；`404 ObjectNotFound` → `undefined` |
| `readdir` | **逐层** `PROPFIND Depth: 1`，并**必须跟随分页** | 本实现 `Depth: infinity` 对目录仍只按直接子项读取 ⇒ 递归要自己逐层做；截断时响应头给 `Link: <…?mk=<marker>>; rel="next"`，**漏跟 `mk` 分页 = 静默漏 import**，直接违反 C5 / C8 |
| `openRead` | `GET`；断点续传用 `Range: bytes=<start>-` | `bytes=-N` 在本实现下按"从起始位置开始"处理，**不是 RFC 的后 N 字节语义，禁止使用**；`416` → 丢弃续传状态重下整个对象 |
| `openWrite` | 只写本地 `journal` | `PUT` **强制要求 `Content-Length`、不接受 chunked body**，因此不可能边生成边直传远端，必须先落盘拿到长度 |
| `rename(from → to)` | `PUT <to 的父目录>/.dsh-tmp-<uuid>` → `PROPFIND` 取暂存 ETag → `MOVE` 到最终内容寻址名 | 同父目录 ⇒ 原子；目标已存在 ⇒ `MOVE` 报错 ⇒ C4 由服务端给出（须验证，见 3.4.12.5） |
| `mkdir` | `MKCOL`；`405 ResourceExisted` 视为成功（幂等） | 见 3.4.12.3 的沙箱陷阱 |
| `fsync` | 本地 `journal` 落盘 | 不承诺远端可见（C6） |
| `unlink` | **不调用 `DELETE`**，只清本地 `journal` / `index` | 远端 `DELETE` 是**递归**的，绝不能由插件侧触发（C7） |

**请求属性必须成组。** 本实现中 `getetag` 会随 `resourcetype` / `getcontenttype` **一并**输出，因此每次 `PROPFIND` 都要同时请求这三个，否则拿不到 ETag（这是实现耦合行为，不是 RFC 语义）。`displayname` / `getcontentlength` / `getlastmodified` 按需带上。请求体上限 32 KiB；若最终未生成任何属性，`propstat` 返回 `404`，解析要能容忍。

**href 解码与前缀校验。** 响应的 `href` 是路径转义后的绝对路径（`/dav/<sandbox>/<path>`）。后端必须正确解码（文件名可能含中文、空格、`#`），并在解码后**强制校验仍在 `<sandbox>` 前缀之内**；越界即 `SYNC_ROOT_INVALID`，不要把它当"服务端给的路径"直接使用。

#### 3.4.12.3 四个必须遵守的 DAV 陷阱

1. **`MKCOL` 会隐式创建 sandbox。** 当目标 URI 的第一段不是现有 sandbox 且没有后续路径时，服务端把该名称当作**新 sandbox 标题**创建。因此后端必须在首次连接时 `PROPFIND /dav/` 校验目标 sandbox 存在，且**任何 `MKCOL` 都必须在"已知存在的 sandbox 之下至少一层"执行**。拼错 sandbox 名不会报错，而是悄悄新建一个 —— 两台设备各建一个，永久对不上，且两边都"看起来正常"。
2. **`PROPPATCH` 假装成功。** 它对 `Win32*` 属性返回 `200`，但当前实现**不解析、不保存、不更新任何东西**。**禁止用 dead properties 存任何状态**（分支指针、manifest 索引、设备 id）。
3. **`LOCK` 不能用作互斥。** lock type / scope / timeout 是固定返回值，`UNLOCK` 不校验 `Lock-Token`，对不存在的文件加锁还会返回伪造的成功锁信息。**单写者只能靠本地 lockfile + `MOVE` 的"已存在即失败"语义** —— 这同时回答了 §15 的 Q11：WebDAV 上不靠远端锁，靠不可覆盖的提交。
4. **`Content-Length` 是硬约束。** `PUT` 受服务端 `webUploadMaxSize` 限制。§4.1 把附件按单个 sha256 对象存放，大附件可能超限 → 需要对象级分块（§15 开放问题）。超限时报 `SYNC_UPLOAD_TOO_LARGE`，**不允许静默截断**。

#### 3.4.12.4 无 cursor：`changesModel: 'full-scan'`

WebDAV 没有 Dropbox cursor、Drive changes token、OneDrive delta 的对应物，因此 `changes(cursor)` 只能实现为**逐层全量 `PROPFIND` + 与 `index` 中的 (path, etag, bytes) 比对**：

- `cursor` 退化为本地"扫描代次"标记，不是服务端 token；
- C8（远端可见性）由"每轮都真的走完整棵树"保证，延迟 = 扫描间隔，代价是固定的一轮全树遍历；
- 可以用目录 `getlastmodified` 做子树剪枝省请求，但**只能当优化、不能当保证**（依赖服务端目录时间语义，跨 provider 不可信）。

#### 3.4.12.5 C4 必须被运行时验证，不能假设

"`MOVE` 到已存在目标会失败而不是覆盖"是本实现的行为，**不是 RFC 保证**（RFC 4918 的默认 `Overwrite: T` 恰恰是覆盖）。因此每次 `rename` 落地后都做一次后置校验：

```text
PUT 同目录 .dsh-tmp-<uuid>
  ↓
PROPFIND tmp      → etagA            # 成组请求属性，否则拿不到 etag
  ↓
MOVE tmp → objects/<…>/<sha256>
  ├─ 报 405 / 409（目标已存在）
  │     PROPFIND final → etagB
  │        etagB == etagA  → 内容一致，安全跳过（幂等）
  │        etagB != etagA  → SYNC_REMOTE_CONFLICT（双方都保留）
  └─ MOVE 成功
        PROPFIND final → etagB'
           etagB' == etagA  → 正常提交
           etagB' != etagA  → 服务端静默覆盖了别人的内容
                              ⇒ 该后端 C4 违约：降级为只读、上报，
                                 摘掉 declaredContract 的 C4，
                                 下次 scan() 报 SYNC_ROOT_CONTRACT_UNMET
```

最后一条分支就是"契约先于实现"的落点：**不是假设服务端守约，而是检测它有没有守约。** 注意这属于契约自检，不是冲突检测（§3.4.6）：它判断的是"这个后端还能不能信"，不是"谁覆盖了谁"。

上面 405 分支报出的 `SYNC_REMOTE_CONFLICT` 同样是**透传厂商结论**（"目标已存在且内容不同"这一事实由厂商语义给出），后端没有、也不需要"谁先谁后"的 base 状态（§3.4.6）。

#### 3.4.12.6 状态码 → 错误码

| DAV | `exception` | 映射 |
|---|---|---|
| 400 | `TooBigEntity` / `IllegalArgument` | `SYNC_PROVIDER_ERROR` |
| 400 | `TooManyASPs` | `SYNC_PROVIDER_ERROR`（提示清理已失效的应用密码） |
| 401 | `AuthenticationFailed` / `NoSuchUser` / `UnAuthorized` | `SYNC_AUTH_EXPIRED`；**认证类错误没有 DAV XML 体，只能按状态码判** |
| 403 | `SandboxAccessDenied` / `OperationNotAllowed` | `SYNC_PROVIDER_ERROR`（sandbox 只读或离线 —— 读得到、写不了；`/sync cloud status` 应显式提示） |
| 403 | `StorageSpaceExhausted` | `SYNC_QUOTA_EXCEEDED` |
| 404 | `ObjectNotFound` | 不是错误：`stat` → `undefined` |
| 405 | `ResourceExisted` | `mkdir` 视为成功；`MOVE` 视为"C4 由服务端保证"，转入 **C4 探针**（§3.4.12.5）—— 这是契约自检，**不是冲突判定** |
| 409 | `AncestorsNotFound` | `SYNC_PROVIDER_ERROR`（父目录缺失，属本实现 bug） |
| 409 | `DuplicateName` / `ConcurrentUpdate` / `FileBeingLocked` | `DuplicateName`（`MOVE` 目标已存在）同 405，转 C4 探针；`ConcurrentUpdate` / `FileBeingLocked` 退避重试。冲突**只由探针判出内容不同时透传**为 `SYNC_REMOTE_CONFLICT` |
| 412 | `PreconditionFailed` / `FileUnlocked` | 条件写失败 → 重试；持续失败则**透传**为 `SYNC_REMOTE_CONFLICT`（厂商结论，非本端判定） |
| 416 | `RangeNotSatisfied` | 丢弃续传状态，重下整个对象 |
| 503 | `ServiceUnAvailable` / `BlockedTemporarily` | 限流 → 指数退避，最终报 `SYNC_PROVIDER_ERROR` |

#### 3.4.12.7 凭据：没有 OAuth

WebDAV 用 HTTP Basic（账号 + **应用专用密码 ASP**，不是登录密码）。因此：

- §3.4.2 的 OAuth 2.0 PKCE / loopback 回调 / device code **不适用于 WebDAV**；
- 凭据仍是 secret，仍进 OS credential store（`credentialsRef: keychain:dsh-session-sync/webdav`），配置里只放 `baseUrl` + `sandbox`（+ 可选 `username`）；
- 报错文案必须明确"此处需要用应用专用密码"，401 时给出可操作提示；
- `/sync cloud login` 对 WebDAV 退化为"填 baseUrl / sandbox / username / ASP + 连通性自检"，**不触发浏览器授权**；相应地 `SYNC_AUTH_DENIED`（用户在授权页拒绝）在该 provider 下不会出现。

#### 3.4.12.8 能力 profile 声明

`cloud` 后端按 provider 声明三个能力位；插件仍然只见目录，这些位用于如实记录"C2 / C4 / 增量发现交给了谁"，并让命令与状态页正确分支：

| profile | 取值 | 含义 |
|---|---|---|
| `commitMode` | `local-index` \| **`remote-move`** | 提交点：本地索引事务 / 远端原子改名 |
| `changesModel` | **`cursor`** \| `full-scan` | 增量发现：服务端游标 / 全树扫描 |
| `authModel` | `oauth-pkce` \| **`basic-asp`** | 授权方式 |

WebDAV = `remote-move` + `full-scan` + `basic-asp`；Dropbox = `local-index` + `cursor` + `oauth-pkce`。

> 顺带回答 §15 Q12：具备 WebDAV 能力的服务（坚果云、Nextcloud、自建 DAV）**不需要厂商专属适配**，走本节即可；只有"既无文件级 API 又无 WebDAV"的服务（如 iCloud Drive）才需要单独判定。

### 3.5 同步根文件系统契约（SyncRootContract）

无论 `<syncRoot>` 是本地目录、云厂商 API 支撑的虚拟目录，还是进程内 FS，插件都只依赖下面这份契约。**契约先于实现**：没有这份契约，"用厂商 API 实现目录语义"就只是把失败从"看得见"变成"静默"。

| # | 条款 | 插件为何依赖 | 不满足时的症状 |
|---|---|---|---|
| C1 | **read-your-writes**：写入后立刻 `stat`/`open` 可读到该内容 | §5.4 "已存在则校验哈希后跳过" | 重复上传、幂等失效 |
| C2 | **rename 原子可见**：`rename` 返回后，目标路径要么不存在，要么内容完整 | §5.4 的提交点 | 读到半截 object → `SYNC_HASH_MISMATCH` |
| C3 | **存在 ⇒ 完整**：最终路径上不出现内容不完整的文件 | §6.1 的校验前提 | 假失败、bundle 被判 corrupt |
| C4 | **不变对象不被覆盖**：`rename` 到已存在路径时失败或保持原内容 | 内容寻址去重 | 两设备互相覆盖 revision |
| C5 | **readdir 完整**：`readdir` 不返回不可读/不完整的条目 | §6.1 扫描 | 随机漏 import |
| C6 | **fsync 尽力而为**：崩溃后最坏是丢文件，不是内容错位 | 允许远端延迟可见 | 保守实现会让每次 flush 卡住 |
| C7 | **不主动删除**：不因远端缺失就 unlink 本地对象 | §7 冲突隔离 | 静默丢历史 |
| C8 | **远端可见性**：`readdir` 必须体现其他设备已提交的对象；**允许延迟，延迟不算违约** | 跨设备发现 | 永远看不到别的设备导出的 Session |

- **必需**：C1–C5、C7、C8。
- **弱保证即可**：C6。
- **延迟是允许的，不完整是不允许的**：C8 只要求最终可见，不要求即时；但 C3 一旦被违反（出现"存在但不完整"），插件将报错而非降级。

各后端的满足方式：

| 后端 | C1 / C2 | C3 | C5 | C8 |
|---|---|---|---|---|
| `dir` | 本地文件系统 | 本地文件系统 | 本地文件系统 | 依赖外部客户端，延迟可能很大 |
| `cloud`（对象型 provider，`local-index`） | **本地索引事务** | **`index` 只 commit 已 ack 的对象** | 远端 listing + `index` 合并 | 远端 listing（cursor/delta） |
| `cloud`（WebDAV，`remote-move`，§3.4.12） | **服务端同父目录 `MOVE` 原子** | **服务端 `PUT`（强制 `Content-Length`）整体写入** | 逐层 `PROPFIND` + **必须跟随 `mk` 分页** | 逐层全量 `PROPFIND`，延迟 = 扫描间隔 |
| `memory` | 由测试注入 | 由测试注入 | 由测试注入 | 由测试注入 |

两行 `cloud` 的差别本身就是结论：**C2 / C3 的保证者从"我们自己的索引事务"换成了"服务端"**。WebDAV 这一行更接近 `dir`，对象型 provider 那一行才是 §3.4.4 状态机真正要解决的问题域。C4 在 WebDAV 下同样由服务端给出，但按 §3.4.12.5 必须逐次验证后才允许写进 `declaredContract`。

实现方必须**显式声明**满足哪些条款（`SyncRootFs.declaredContract`），插件在 `scan()` 时自检，缺失必需条款即 `SYNC_ROOT_CONTRACT_UNMET`，fail-closed。契约条款有一套**一致性测试套件**（§12），任何后端跑同一套测试。

### 3.6 后端选型矩阵

| 后端 | 跨平台 | 持久 | 人类可见 / 可手工抢救 | 可被外部云盘客户端同步 | 需要凭据 | 定位 |
|---|---|---|---|---|---|---|
| **`dir`**（`node:fs/promises`） | 是 | 是 | **是** | 是 | 否 | **默认；生产基线** |
| **`cloud`**（厂商 API 直连） | 是（纯 TS） | 是（远端 + 本地 `index`/`journal`） | **否** | 否（会双写） | **是** | 免客户端场景 |
| `memory`（进程内内存 FS，jimfs / memfs 一类） | 只在语言内 | **否** | 否 | 否 | 否 | **仅测试** |

关于 jimfs 这类内存 FS 的结论：

- **不作为运行时后端**：进程内内存 FS 没有内核挂载点，其他进程（包括云盘客户端）看不到，`node` 侧也访问不到；不持久则直接推翻"内容寻址 + 幂等 + fail-closed"所依赖的前提；而为了跨平台引入一个把实现锁进单一语言运行时的抽象，方向是反的。
- **但作为测试后端非常合适**：契约需要一个**可注入故障**的实现来验证 —— 内存 FS 能精确模拟"rename 后立刻可见 / 延迟可见"、"readdir 漏项"、"读到半截内容"、"磁盘满"，这些用真实文件系统很难稳定复现。
- 因此 `SyncRootFs` 保留 `kind: 'memory'`，只在测试配置中出现，运行时配置里拒绝该值。

> 为什么不做内核挂载（FUSE / FSKit / File Provider）？挂载能把 C2 / C3 从"指望客户端碰巧做到"提升为"由 FS 实现保证"，看似更优雅，但代价是**每个平台一套实现**（macOS：macFUSE 需批准内核扩展，或 FSKit 需 15.4+，或 File Provider 扩展；Linux：FUSE；Windows：cldapi / WinFsp），并且第三方 mount（如 rclone 的 writeback 模式）本地原子而远端不原子，反而破坏 C3。
> 同样的收益，用 §3.4 的 `cloud` 后端 + 索引事务就能拿到，且**全程是纯 TS、跨平台、无需任何内核组件**。这是本设计选择"进程内实现目录语义"而不是"挂载"的根本原因。

---

## 4. 同步目录格式

云盘同步目录中建议采用**内容寻址 + 不可变对象 + manifest 最后落盘**的结构，而不是直接复制 `.jsonl.zstd`。

这个结构同时是给后端实现看的契约：**只要求"目录语义 + rename 原子可见 + 已存在文件不被覆盖"**（完整条款见 §3.5），因此无论目录由外部客户端同步（后端 `dir`）还是由厂商 API 直接支撑（后端 `cloud`），插件的行为完全一致。后端不需要理解下面任何一个目录的含义。

```text
<syncRoot>/
  dsh-session-sync/
    schema-version.json
    objects/
      events/
        <sha256>.jsonl
      attachments/
        <sha256>
    sessions/
      <sessionId>/
        revisions/
          <revisionHash>.json
    trees/
      <rootSessionId>/
        <treeRevisionHash>.json
    tmp/                         # 写入过程中使用，导入方忽略
```

### 4.1 内容寻址对象

- `objects/events/<sha256>.jsonl`
  - 内容是规范化的当前格式事件行；
  - 每行一个 SessionEvent；
  - 对象内容不可变，路径由内容 SHA-256 决定；
  - 同一个事件块在多个 revision 之间自动去重；
  - 两个设备写同样内容 → 同一路径 → 云盘不会产生有效冲突。

- `objects/attachments/<sha256>`
  - 图片和通用文件都按字节 SHA-256 存放；
  - 引用方在 manifest 中声明该对象的 kind、bytes、mediaType、name；
  - 导入时重新计算摘要并校验。

### 4.2 Session Revision Manifest

每个 Session 的每个导出快照写一个不可变 `revisions/<revisionHash>.json`：

```json
{
  "schema": 1,
  "sessionId": "session-...",
  "header": {
    "id": "session-...",
    "version": 3,
    "createdAt": 1730000000000,
    "cwd": "/Users/alice/project",
    "parentSession": null,
    "isSeeded": false,
    "delegationDepth": 0,
    "origin": null,
    "agentPreset": null
  },
  "headerSha256": "…",
  "inheritedEventCount": 0,
  "sourceFormatVersion": 3,
  "eventCount": 1234,
  "lastSeq": 1233,
  "previousRevision": "sha256:…",
  "segments": [
    {
      "startSeq": 0,
      "endSeq": 1234,
      "sha256": "…",
      "formatVersion": 3
    }
  ],
  "attachments": [
    {
      "kind": "image",
      "attachmentId": "sha256:…",
      "sha256": "…",
      "mediaType": "image/png"
    },
    {
      "kind": "file",
      "attachmentId": "sha256:…",
      "name": "report.csv",
      "bytes": 12345,
      "sha256": "…"
    }
  ],
  "source": {
    "deviceId": "…",
    "harnessVersion": "0.1.5",
    "exportedAt": "2026-09-24T00:00:00.000Z",
    "cwd": "/Users/alice/project"
  }
}
```

### 4.3 Tree Manifest

一次导出的 Session 树写一个不可变 `trees/<rootSessionId>/<treeRevisionHash>.json`：

```json
{
  "schema": 1,
  "rootSessionId": "session-root",
  "exportedAt": "…",
  "workspaceHint": {
    "sourcePath": "/Users/alice/project",
    "title": "project"
  },
  "sessions": [
    {
      "sessionId": "session-root",
      "revision": "sha256:…",
      "parentSession": null,
      "origin": null
    },
    {
      "sessionId": "session-child",
      "revision": "sha256:…",
      "parentSession": "session-root",
      "origin": "subagent"
    }
  ]
}
```

导入方只需要扫描 `trees/**/*.json`，包括被云盘改成 conflict-copy 文件名的 manifest。不要依赖文件名，应该校验内部 JSON。

### 4.4 为什么不用直接复制 Session 存储文件？

不能直接复制 `<DSH_HOME>/sessions`，因为：

- 默认 Web/base 使用 `compression: 'zstd'`；
- 物理 layout 是 `--project--/<encoded-id>/session.vN.jsonl.zstd`；
- 可能是旧 generation，需要迁移；
- 附件不在 sessions 目录；
- 不能表达 revision、冲突状态、附件清单；
- 云盘冲突文件名可能破坏目录名。
- 子 Session 的平铺关系需要从 header 重建，不适合作为同步格式。

---

## 5. 导出设计

### 5.1 导出范围

v1 支持两种模式：

```ts
type SessionSyncExportRequest =
  | { scope: 'session-tree'; rootSessionId: SessionId }
  | { scope: 'all-ordinary'; includeArchived?: boolean }
  | { scope: 'all-sessions'; includeArchived?: boolean }
```

- `session-tree`：默认，从根 Session 出发，包含全部后代。
- `all-ordinary`：导出所有 `origin !== 'subagent'` 的 Session，各自作为树根。
- `all-sessions`：包括 subagent 根，不推荐，除非做完整备份。

### 5.2 导出算法

```text
1. 确保同步根合法，且不与 session root / attachment root 重叠
2. 选择导出集合
3. 对每个 live root / descendant：
   - 如果是 live session：ctx.sessions.flush(session)
4. 对根 Session：
   - ctx.sessionQuery.traceSession(rootId)
   - 校验 trace.complete；不完整时默认失败，除非 allowPartial
5. 对每个 Session（先父后子）：
   - persistence.open(id, 'read')
   - events = handle.read(0, undefined).events
   - header = handle.header
   - inheritedEventCount = handle.inheritedEventCount
   - 生成 revision：
       - header 哈希
       - 事件分段（v1 可以只有一个 0..N 的 segment）
       - 事件 segment 写入 objects/events/<sha256>.jsonl
   - 从事件中收集附件 refs
6. 对每个附件 ref：
   - image: attachments.readImage(ref)
   - file: attachments.readFileStream(ref)
   - 写入 objects/attachments/<sha256>
   - 校验 ref.bytes / 摘要
7. 写所有 objects（内容寻址，天然幂等）
8. 写 revisions/<revisionHash>.json
9. 写 trees/<rootSessionId>/<treeRevisionHash>.json
```

### 5.3 序列化规则

- header：直接来自 `handle.header`，但以 JSON 对象形式写入 revision manifest。
- events：
  - 使用当前 writer 的规范编码；
  - 每行一个事件，保证 `seq` 从 0 连续；
  - 不包含物理 header 行；
  - `segments` 记录 `startSeq/endSeq/sha256/formatVersion`。
- `inheritedEventCount` 必须来自 `handle.inheritedEventCount`，不能从 header 猜。
- `sourceFormatVersion` 用于诊断；目标设备需要能读取或迁移该格式。
- 导出完成后再写 tree manifest；tree manifest 是整棵树“可导入”的提交点。

### 5.4 原子性与云盘友好

- 所有 object 先写 `<syncRoot>/dsh-session-sync/tmp/<uuid>.tmp`；
- `fsync` 后 rename 到最终内容寻址路径；
- 文件不存在才 rename；如果已存在则校验哈希后跳过；
- revision manifest、tree manifest 最后写；
- 导入方只读取 manifest 引用齐全且哈希通过的树；
- 导入方忽略 `tmp/`、`*.tmp`、以 `.` 开头且不含合法 manifest 的目录。

这套写入顺序能成立，前提是后端实现保证"最终路径一旦出现内容就完整、且已存在的不变对象不被覆盖"（§3.4.5 不变量 1–3）。若后端违反，插件会在校验阶段以 `SYNC_HASH_MISMATCH` / `SYNC_BUNDLE_INCOMPLETE` 失败，而不是写坏本地 Session —— 这是 fail-closed 的落点。对后端 `cloud` 而言，这条由"索引只 commit 已 ack 的对象"直接保证（§3.4.4），不需要远端文件系统提供原子性。

---

## 6. 导入设计

### 6.1 扫描与验证

```text
1. 递归扫描 trees/**/*.json
2. 对每个候选 tree manifest：
   - JSON/schema 解析
   - 找到根 Session 和每个子 Session 的 revision manifest
   - 校验所有 revision manifest 的 headerSha256
   - 校验所有 segment 的 hash、seq 范围、连续性和总 eventCount
   - 校验所有 attachment object 存在且 hash 匹配
3. 只把“完整且验证通过”的 tree 放入可导入集合
4. 不完整的 tree 保留为 pending，不做部分导入
```

### 6.2 导入计划

对每个可导入 tree，逐 Session 生成本地计划：

| 本地状态 | 远端关系 | 动作 |
|---|---|---|
| 不存在 | — | create |
| 存在，header 完全一致 | remote 是 local 的前缀 | no-op（本地领先） |
| 存在，header 完全一致 | local 是 remote 的前缀 | append 远端后缀 |
| 存在，header 完全一致 | local 与 remote 完全相等 | no-op |
| 存在，header 不完全一致 | — | conflict |
| 存在，事件日志分叉 | — | conflict |

“前缀”比较基于完整逻辑事件数组；可以在后续用 segment hash 优化。

这张表是**语义层冲突的唯一判定点**：判定需要本地 Session 状态，所以只能发生在导入时；导出侧与后端都不做这件事（§7、§3.4.6）。

### 6.3 写入 Session

#### 目标不存在

```ts
const handle = await ctx.sessionPersistence.create(header, {
  inheritedEventCount,
})
for (const batch of chunk(events, 500)) {
  await handle.append(batch)
}
await handle.flush()
await handle.close()
```

要点：

- `header` 必须来自 bundle，且 `cwd` 有值；
- `inheritedEventCount` 必须来自 bundle；
- 写入前再次校验每个 event 的 `seq === 当前长度`；
- `create` 会抛出 `SessionAlreadyExistsError`，应捕获并转入存在分支；
- 先校验完所有 attachment 再写 session，避免写了一半才发现附件缺失。

#### 目标已存在且远端是本地后缀

```ts
const handle = await ctx.sessionPersistence.open(id, 'write')
const local = await handle.read(0, undefined)
// 再次确认 local.events 是 bundle.events 的前缀
await handle.append(bundle.events.slice(local.events.length))
await handle.flush()
await handle.close()
```

要点：

- 如果本地 Session 是 live（`ctx.sessions.get(id)` 存在），写句柄可能已被占用；
  - v1 直接返回 `SESSION_BUSY`；
  - 或要求调用方先关闭/停稳该 Session。
- 如果 open write 失败，重试或报错，不做破坏性回退。

### 6.4 附件导入

导入 Session 事件之前，先确保所有被引用的附件对象在本地存在：

- 本地已有且摘要一致：跳过；
- 本地缺失：
  - 优先调用新的 attachments import seam：
    ```ts
    attachments.importImage({ ref, data })
    attachments.importFile({ ref, chunks })
    ```
    这些方法只做“字节与 ref 一致性校验”，不重新施加当前 admission 限制；
  - 如果没有该 seam，fallback：
    - 文件：`saveFile` / `saveFileStream`，要求返回 ref 与来源 ref 一致；
    - 图片：`saveImage`，要求返回 ref 与来源 ref 一致；
    - 不一致则视为导入失败，避免历史被重新编码。
- 同一 `attachmentId` 已存在但 bytes 摘要不一致：`SYNC_ATTACHMENT_CORRUPT`，拒绝导入。

> 建议把 attachment import seam 作为这个功能的正式依赖项，而不是把 `$DSH_HOME/attachments/v1` 当成公开文件格式。

### 6.5 Workspace 绑定

所有 Session 导入完成后：

```ts
for (const root of importedRoots) {
  if (root.cwd === undefined) continue
  const workspace = await ctx.workspaceRegistry.resolveByPath(root.cwd)
  if (workspace !== undefined) {
    await workspace.attachSession(root.id)
  }
  // 否则：session 会出现在 Ungrouped
}
```

- 只给普通根 Session 调 `attachSession`。
- 子 Session 不进入顶层 Workspace 分组，谱系由 header `parentSession` 表达。
- 如果 Workspace 不存在：
  - `cwdPolicy: preserve` 时，尝试 `workspaceRegistry.create(cwd)` 再 attach；
  - 如果 cwd 不存在或无法 canonicalize，保持 Ungrouped 并记录 warning。
- 如果 `workspaceRegistry` 的 domain 尚未初始化：
  - 第一次启动时 bootstrap 会自动按 cwd 创建 Workspace 并分配 Session；
  - 但已有 `DSH_HOME` 上通常不会自动追加，因此导入后显式 attach 仍然是必要的。

### 6.6 导入后的通知与派生数据

导入是通过 persistence 直接写入的，不会触发 `session/created`，因此：

- 运行中的 UI 不会收到 `api-session/added`；
- 需要提供刷新机制：
  - 简单方案：提示用户刷新页面；
  - 更好方案：新增 `sessionSync` → `SessionController` 的通知接口，例如：
    ```ts
    SessionController.announceStoredSessions(ids)
    ```
    由 Host 重新生成 cold summary 并 emit `api-session/added`。
- projection cache：
  - 不导入、不复制；
  - 打开 Session 或后续 checkpoint 会重建；
  - 列表在 cache 缺失时仍能显示 fallback title。
- SQLite 全文搜索：
  - 不导入；
  - 下一次 `searchSessions()` 时 `session-query-sqlite` 会在 reconciliation 中列出并索引新增 Session；
  - 因此内容搜索会短暂滞后，但不需要重启。

---

## 7. 冲突处理

**判定时机：只在导入时。** 本节处理的是**语义层冲突**（本地 Session 与远端 bundle 的关系），判定需要本地状态，因此只发生在导入计划阶段（§6.2）；导出侧不做冲突检测，只做幂等跳过（§5.2）。后端层的冲突（对象级、厂商语义）由同步层给出，见 §3.4.6。

### 7.1 冲突定义

以下任一情况视为冲突：

- 同一个 `sessionId`，但不可变 header 字段不一致：
  - `createdAt`、`parentSession`、`isSeeded`、`delegationDepth`、`origin`、`agentPreset`；
- 同一个 `sessionId`，事件日志既非前缀关系，也不是完全相等；
- 同一 tree 内父 Session 和子 Session 的 `parentSession` 关系不一致；
- 同一 `attachmentId` 对应不同字节摘要，或同一 path 对应不同 hash。

`cwd` 是否视为身份字段：

- v1 `cwdPolicy: preserve`：视为身份字段，不一致即冲突；
- 未来 `cwdPolicy: remap`：bundle 额外保存 `sourceCwd`，但该模式需要单独的跨设备身份协议。

### 7.2 默认策略

```text
quarantine（默认）：
  - 不写本地 Session
  - 记录 conflict 报告
  - 保留云端 revision 不动
  - UI/CLI 显示冲突，由用户决定

keep-local：
  - 忽略远端 revision
  - 后续本地导出会形成新的 head

keep-remote：
  - 仅在用户显式确认后可用
  - 先把本地日志归档/备份，再执行覆盖式重建
```

**不要自动拼接两个分叉的后缀。** 两个离线设备各自产生的 `turn/start`、`tool/call` 等事件在 seq 上连续，但语义顺序不唯一，自动拼接会产生非法或不可解释的对话历史。

**冲突只在导入时被发现，这是有意取舍。** 后端不检测冲突（§3.4.6），所以"两台设备并发写同一 Session"不会被提前拦住，只会在导入计划里表现为 `conflict`，并按上表 `quarantine`。**不引入**导出的乐观锁、manifest 前驱校验或跨设备单写者选举 —— 冲突延迟发现可以接受，静默覆盖不可以。

### 7.3 云盘 conflict copy

- 导入扫描不依赖文件名精确匹配；
- 对 `trees/**` 下所有 `*.json` 尝试解析；
- 相同内容哈希的对象可以安全去重；
- 多个 tree head 指向同一 Session 的不同 revision 时，先做前缀比较；无法判定则进入 conflict。

这条设计的适用范围是**后端 `dir`**（外部客户端产生 `conflicted copy`）。后端 `cloud` 的冲突由厂商语义给出（`MOVE` 到已存在目标失败、`ETag` / `rev` 不符、`409 DuplicateName`），后端不额外检测（§3.4.6）—— 两者在插件侧的处置完全一样：不信任文件名、按内部 JSON 校验、无法判定即隔离。因此插件既不需要知道自己在用哪个后端，也不需要知道冲突是客户端产生的还是厂商报出来的。

---

## 8. 跨设备路径问题

这是本功能最重要的设计约束。

### 8.1 问题

- Session header 的 `cwd` 是绝对路径；
- 物理存储路径也由 `cwd` 推导；
- Workspace 绑定要求 `realpath(cwd) === workspace.path`；
- Dropbox 路径通常包含用户名或盘符：
  - A 设备：`/Users/alice/project`
  - B 设备：`/home/alice/project`
  - Windows：`C:\Users\alice\project`

### 8.2 v1 建议：preserve

- bundle 原样保存 `cwd`；
- 导入时写回完全相同的 `cwd`；
- 如果目标设备上该路径存在且是目录：
  - 可以正常绑定 Workspace；
  - 可以继续作为工作目录运行 Agent；
- 如果目标设备上不存在：
  - Session 仍可被 `persistence.list()` 列出（因为 `cwd !== undefined`）；
  - 它不会进入 Workspace，会出现在 Ungrouped；
  - 历史可以查看，但继续对话/恢复 Agent 可能失败或缺少工作区语义。
- 可选 operator workaround：
  - 在目标设备上创建同名路径或 symlink；
  - 如果 symlink realpath 后指向本地 Workspace，`WorkspaceRegistry` 反而可以按其 canonical path 完成绑定。

### 8.3 未来：remap

若必须把 `/old/path` 映射到 `/new/path`：

- bundle 中保留 `source.cwd`；
- 导入端配置 `cwdMap`；
- 目标不存在该 Session 时，用映射后的 `cwd` 创建本地 header；
- 但要注意：
  - 本地 header 与其它设备不再不可变一致；
  - 双向同步时该 Session 会变成 header 冲突；
  - 如果 Session 事件中包含旧路径引用（工具结果、session-reference），它们不会被改写；
- 因此 `remap` 建议只作为一种显式的单向导入模式，而不是默认双向同步模式。
- 长期方案应是 WorkspaceRegistry 支持路径 alias / rebinding，让 header 保持不可变，UI 仍能按本地 Workspace 分组。

---

## 9. UI / UX 集成

### 9.1 Host 命令

建议先做 Host/CLI 路径，不急着改浏览器：

```text
/sync export              # 导出当前 Session 树
/sync export <sessionId>  # 导出指定根 Session
/sync import              # 扫描同步目录并导入可导入的 tree
/sync status              # 显示 pending / conflict / imported
```

配置项提供同步目录，避免斜杠命令接受任意 Host 路径。

后端 `cloud` 另有一组命令（属于后端实现，不属于插件的导出/导入逻辑；未启用时全部返回 `SYNC_BACKEND_UNAVAILABLE`）：

```text
/sync cloud login         # 引导 OAuth，凭据落 OS credential store
/sync cloud logout        # 吊销并清除凭据
/sync cloud status        # 凭据有效性、远端 head、待上传对象数、index/journal 状态
/sync cloud pause|resume  # 暂停/恢复上传与拉取
/sync cloud now           # 立即同步一次，不等待下一次 interval
/sync index rebuild       # 从远端全量重建本地索引（§3.4.8）
```

命令里不出现 token、不出现厂商远端路径的明文回显。

### 9.2 Web UI（第二阶段）

可选 UI：

- 设置页新增「Session 同步」：
  - 后端选择（`dir` / `cloud`）
  - `dir`：同步目录
  - `cloud`：厂商选择 + `连接` 按钮（触发 OAuth 浏览器流程）、授权状态 / 上次同步时间 / 待上传对象数、`断开连接`（revoke）
  - import on startup
  - export on session idle
  - conflict policy
- Session Header 更多操作中增加：
  - `同步此 Session`
- 同步状态/冲突对话框（`cloud` 后端下另需显示 index / journal 健康度与"未上传字节"）。
- 因为 Host 路径选择涉及权限，Web 端建议只编辑配置，不直接选 Host 目录；桌面端可以走原生目录选择器。
- OAuth 回调必须是本地 loopback 或 device code，**不要**把授权码交给 Web UI 处理。
- 需要明示的一个后果：`cloud` 后端下同步根**不是人类可浏览的目录**，设置页要如实说明"数据只能通过 Harness 访问"。

### 9.3 自动触发

可考虑但不要 v1 默认开启：

- 启动时扫描并导入；
- Session idle / flush 后 debounce 导出；
- 定期扫描。

自动导入必须遵守：

- 不自动解决 conflict；
- 不自动删除本地 Session；
- 不自动覆盖本地更长的日志；
- 任何写入都要有 stable error code 和日志。

---

## 10. 安全与隐私

Session 日志可能包含：

- 用户与模型对话；
- 工具参数和结果；
- 文件内容摘要；
- 路径、环境变量、凭据意外泄漏的内容。

因此：

- 导出到云盘必须是显式 opt-in；
- 默认不自动开启同步；
- 文档明确提示云盘提供方可能访问数据；
- 本地同步目录权限建议 `0700`，文件 `0600`；
- 不跟随 symlink 写入同步根之外；
- 校验所有 bundle 路径不包含 `..`、绝对路径、NUL；
- 摘要用于完整性，不用于真实性；
- 端到端加密作为未来可选项，不应假装 v1 已安全。

### 10.1 `cloud` 后端凭据

后端 `cloud` 让 Harness 第一次持有云盘凭据，因此必须显式约束：

- **存储**：OAuth refresh token 只进 OS credential store，绝不写 `settings`、`.env`、配置文件或日志；
- **最小 scope**：只申请"应用私有目录/单个文件夹"级别的权限（Dropbox `files.content.write` + app folder、Drive `drive.file`、OneDrive `Files.ReadWrite.AppFolder`），**不申请全盘读写**；
- **凭据与远端根绑定**：`remoteRoot` 变化时要求重新授权，防止误把旧 token 用在新的远端根；
- **可撤销**：`/sync cloud logout` 必须真的调用厂商 revoke 端点，并删除本地凭据；只删本地不算断开；
- **不进日志**：日志只记录 object hash / 字节数 / 状态码，token、授权码、远端完整 URL 一律不落盘；
- **失败闭环**：refresh 失败时停止上传与拉取并进入 `SYNC_AUTH_EXPIRED`，**不降级为匿名访问**，也不静默切到后端 `dir`（那会造成两个同步根被写，用户无从察觉）；
- **进程内持有**：v1 的 `cloud` 后端跑在 Harness 进程里，因此 token 会出现在 Harness 进程内存中。这是有意的取舍，强化路径是把 provider 适配拆到独立 helper 进程（§3.4.9），见 §15 开放问题。

这一节也说明了为什么厂商访问必须封在后端实现里：**凭据的生命周期只影响"目录是否被更新"，不影响插件的任何行为**。凭据失效时，插件只是看到目录不再变化。

---

## 11. 错误码建议

```ts
type SessionSyncErrorCode =
  | 'SYNC_ROOT_INVALID'
  | 'SYNC_ROOT_CONTRACT_UNMET'      // 后端声明不满足 §3.5 必需条款
  | 'SYNC_BACKEND_UNAVAILABLE'      // cloud 后端未启用/未配置
  | 'SYNC_AUTH_REQUIRED'            // 从未授权（cloud）
  | 'SYNC_AUTH_EXPIRED'             // refresh 失败（cloud）
  | 'SYNC_AUTH_DENIED'              // 用户在授权页拒绝（cloud）
  | 'SYNC_PROVIDER_ERROR'           // 厂商 API 5xx / 限流（cloud）
  | 'SYNC_PROVIDER_UNSUPPORTED'     // provider 无文件级 API，如 iCloud（cloud）
  | 'SYNC_QUOTA_EXCEEDED'           // 远端配额不足（cloud）
  | 'SYNC_INDEX_CORRUPT'            // 本地索引损坏，需 rebuild（cloud）
  | 'SYNC_JOURNAL_LOST'             // 未上传字节丢失，必须显式告知用户（cloud）
  | 'SYNC_REMOTE_CONFLICT'          // 厂商报冲突/目标已存在且内容不一致，已保留双方（cloud；透传厂商结论，非自建检测）
  | 'SYNC_BUNDLE_INCOMPLETE'
  | 'SYNC_BUNDLE_CORRUPT'
  | 'SYNC_HASH_MISMATCH'
  | 'SYNC_HEADER_CONFLICT'
  | 'SYNC_EVENT_DIVERGED'
  | 'SYNC_ATTACHMENT_MISSING'
  | 'SYNC_ATTACHMENT_CORRUPT'
  | 'SYNC_SESSION_BUSY'
  | 'SYNC_FORMAT_UNSUPPORTED'
  | 'SYNC_PATH_UNRESOLVED'
  | 'SYNC_CONFLICT_QUARANTINED'
  | 'SYNC_IMPORT_PARTIAL'
```

单一命名空间，但**按来源分层**：前 13 条由 `cloud` 后端产生、可恢复或需用户介入（其中 `SYNC_REMOTE_CONFLICT` 是**透传厂商结论**，不是后端自建检测的结果，见 §3.4.6）；其余属插件的 fail-closed 语义。插件不解释后端错误码，只原样透传并附加上下文。

日志只记录 Session id、tree id、event count、对象 hash，不记录消息内容。

---

## 12. 测试计划

### 单元测试

- manifest schema / hash 校验；
- 事件 segment 连续性；
- prefix 比较：local-ahead / fast-forward / diverged；
- 附件 ref 与 object 摘要校验；
- 云盘 conflict copy 文件名扫描；
- 不完整 bundle 不产生任何写入；
- 重复导入幂等。

### 集成测试

构建临时 `DSH_HOME` 和临时 sync root：

1. 源端创建 root + child + image + file；
2. 导出 sync bundle；
3. 目标端空状态导入；
4. 断言：
   - `sessionPersistence.list()` 包含所有 Session；
   - `handle.read` 与源端逻辑日志一致；
   - `sessionQuery.traceSession()` 谱系一致；
   - attachments 可读且摘要一致；
   - Workspace 在路径匹配时完成 attach；
   - 不完整对象存在时拒绝导入。

### 双向/冲突测试

- A 导出 → B 导入；
- B 继续追加事件 → B 导出 → A 导入 fast-forward；
- A、B 在共同基线上分别追加 → 双端导出 → 导入方报 `SYNC_EVENT_DIVERGED`；
- 两端修改 header metadata → `SYNC_HEADER_CONFLICT`；
- **事后隔离**：A、B 在共同基线上各自导出同一 Session 并各自提交 manifest（模拟并发）→ 断言后端**不阻写、不报冲突**、两份 manifest 都留在云端，冲突只由导入方的前缀比较发现并按 §7.2 `quarantine`；断言无自动拼接、本地 Session 未被覆盖。

### live Session 测试

- 导出正在运行的 Session；
- 断言导出包含 flush 后的最新事件；
- 导出期间 Session 继续追加事件，不产生部分事件或错误 seq。

### UI 可见性测试

- 导入后 `session.list` 能看到行；
- `cwd` 缺失时验证会被隐藏并报错；
- `cwd` 存在时验证 Workspace / Ungrouped 行为；
- 导入后无需重启 SQLite，下一次搜索能命中新 Session。

### 后端 `cloud` 测试（用 fake provider 跑，不依赖真实云盘）

- **提交前不可见**：模拟"上传到一半进程被杀"，断言 `index` 中该对象仍为 `staging`，`stat`/`readdir` 均看不到它；
- **补 commit**：上传完成后、index commit 前杀进程，重启后断言按 `journal` 补 commit，且不重复上传（幂等）；
- **不覆盖**：远端已存在同路径且哈希一致的对象 → 跳过而非重传；
- **顺序**：模拟 manifest 先于 object 到达，断言插件侧判定为 pending 而非报 corrupt；
- **延迟到达**：object 全部到位、manifest 缺失 → 不入可导入集合；manifest 到位、object 缺失 → `SYNC_BUNDLE_INCOMPLETE`；
- **对象级冲突（不自建检测）**：fake provider 让远端同路径已存在且内容哈希不同 → 断言后端**不覆盖**、按厂商语义上报 `SYNC_REMOTE_CONFLICT` 且双方都保留；并断言后端判定这一点时**没有**读取任何"上次同步 base"状态；
- **索引重建**：删掉 `index` 后 rebuild，断言从远端恢复出等价状态，未上传对象仍可从 `journal` 看到；
- **journal 丢失**：显式断言报 `SYNC_JOURNAL_LOST` 而不是静默重来；
- **凭据失效**：refresh 返回 401 → `SYNC_AUTH_EXPIRED`，断言停止上传、且**没有**静默切到 `dir` 后端；
- **revoke**：`logout` 后断言厂商端收到 revoke 调用且本地凭据已清除；
- **幂等**：连续两次全量同步，第二次零上传零下载。

### 后端 WebDAV 适配测试（用 fake DAV server 跑，不依赖真实网盘）

- **分页完整性**：fake 在 `PROPFIND Depth: 1` 时返回截断结果并附 `Link: <…?mk=…>; rel="next"`，断言 `readdir` 跟到最后一页且不漏项；**不跟分页必须让该用例失败**；
- **同父目录约束**：断言暂存对象与目标对象同目录；注入一次跨目录 `rename`，断言后端拒绝或改写为同目录暂存，而不是走"复制 + 删除"路径；
- **C4 探针两个分支**：fake 模拟 (a) `MOVE` 到已存在目标报 405 → 断言幂等跳过、不重传；(b) `MOVE` 静默覆盖 → 断言报 `SYNC_REMOTE_CONFLICT` / 摘除 C4 并在 `scan()` 报 `SYNC_ROOT_CONTRACT_UNMET`；
- **ETag 属性成组**：fake 仅在同时请求 `resourcetype` + `getcontenttype` 时输出 `getetag`，断言后端确实成组请求（否则会拿到空 ETag 而静默失去 C4 判据）；
- **MKCOL 沙箱陷阱**：fake 在"路径第一段不属于现有 sandbox"时新建 sandbox 并返回 201，断言后端在写入前已校验 sandbox 存在、永不走到该分支；
- **`Content-Length` 硬约束**：断言 `openWrite` 只写 journal 不发 `PUT`；`PUT` 缺 `Content-Length` 时 fake 返回 400，断言后端不会那样发；
- **超限**：fake 对超过 `webUploadMaxSize` 的 `PUT` 返回 400 `TooBigEntity`，断言报 `SYNC_UPLOAD_TOO_LARGE` 且远端不留半截对象；
- **401 无 XML 体**：断言仅凭状态码也能正确产出 `SYNC_AUTH_EXPIRED`，不依赖解析错误体；
- **`PROPPATCH` 不持久化**：fake 对任何 `PROPPATCH` 返回成功但丢弃内容，断言实现既不写也不读 dead properties；
- **全树扫描**：连续两次同步，第二次仍走全树 `PROPFIND`，但零 `GET`（ETag 未变即跳过）；
- **href 前缀校验**：fake 返回一个越出 sandbox 前缀的 `href`，断言 `SYNC_ROOT_INVALID` 而非按该路径读写。

### 后端一致性测试

同一份 sync bundle，分别经 `dir`（本地目录 cp，模拟客户端）、`cloud`（对象型 fake provider）与 `cloud`（WebDAV profile，fake DAV server）落到目标端，断言三条路径产生**完全相同的导入结果** —— 这是"目录语义抽象是否真的干净"的判据，也是验证 `commitMode: 'remote-move'` 与 `'local-index'` 真的对插件不可见的唯一办法。

### SyncRootContract 一致性测试套件（§3.5）

一套测试，**任何 `SyncRootFs` 后端都必须通过**；内存 FS 后端在这里承担关键角色，因为它能稳定注入真实文件系统难以复现的故障：

| 条款 | 测试方式 |
|---|---|
| C1 read-your-writes | 写入后立即 `stat` + 读回比对；内存后端可配置"延迟可见"来验证插件能检出违约 |
| C2 rename 原子可见 | 在 rename 中途杀进程（内存后端可精确在 rename 内注入中断），断言目标路径不可见或完整 |
| C3 存在 ⇒ 完整 | 内存后端故意让最终路径先返回部分字节，断言插件报 `SYNC_HASH_MISMATCH` 而非写出坏数据 |
| C4 不覆盖 | 对已存在路径 rename，断言返回失败或内容未变 |
| C5 readdir 完整 | 内存后端随机漏掉一条目录项，断言插件的完整性校验能发现而非静默漏 import |
| C7 不删除 | 远端 revision 消失时断言本地对象未被 unlink |
| C8 远端可见性 | 模拟另一设备提交后本端 `readdir` 延迟可见，断言插件判 pending 且稍后能成功导入 |
| 契约声明 | 声明缺少必需条款的后端 → `SYNC_ROOT_CONTRACT_UNMET`，且不产生任何写入 |

**历史教训回归测试**：内存后端模拟"writeback 语义"（写本地缓存即返回、远端异步落盘、rename 本地原子而远端不原子）——该后端的期望结果就是**必然触发 C2/C3 违约**。这条用例把"为什么不做第三方挂载"从文档里的一句话，固化成了可执行的判据。

---

## 13. 分阶段实施

### Phase 1 - Host 手动导入导出

- 新建 `dsh-session-sync` 包；
- 定义并实现 `SyncRootFs` 访问缝（`kind: 'dir'` + 内存测试后端），插件不直接 import `node:fs`；
- 落地 §3.5 契约声明与自检；
- 定义 schema-version 1 bundle；
- 实现 `session-tree` 导出；
- 实现完整校验的导入；
- 支持附件；
- `cwdPolicy: preserve`；
- `/sync export`、`/sync import`、`/sync status`。

### Phase 2 - 后端 `cloud`：授权 + provider 适配（建议先 WebDAV）

与 Phase 1 独立，可并行；目标是把"目录由谁填充"从用户自备客户端升级为内置能力：

- OAuth 2.0 PKCE 授权流程 + 本地 loopback 回调；
- 凭据落 OS credential store，`/sync cloud login|logout|status`；
- 单个 provider 适配（建议先 Dropbox，cursor 模型最简单）；
- `index`（状态机 + 事务提交）+ `journal`（append-only，崩溃可续）；
- `SyncRootFs` 的 `kind: 'cloud'` 实现：8 个方法全部落地，满足 §3.4.5 全部不变量；
- 进程内后台任务：异步上传队列 + 定期 reconcile，非阻塞启动；
- `/sync cloud pause|resume|now`、`/sync index rebuild`；
- 该 Phase 结束时，Phase 1 的功能在**不装任何云盘客户端、不装任何内核扩展**的机器上可端到端跑通。

### Phase 3 - Workspace 与 UI 刷新

- 导入后调用 `workspaceRegistry.create/resolveByPath` + `attachSession`；
- 增加 Host 通知接口，让运行中的 Client 刷新 session list；
- 状态/错误 UI；
- 设置页后端选择 + `cloud` 的连接面板（授权状态、上次同步、待上传字节、索引健康度）。

### Phase 4 - 双向与自动同步

- 本地 `lastImportedRevision` / `lastExportedRevision` 状态；
- 启动时导入、idle 导出；
- conflict quarantine 报告；
- 旧 revision 清理命令；
- 增量拉取（只按 cursor 拉 delta，不全量扫）。

### Phase 5 - 增量、多 provider 与路径重绑定

- events 从单 segment 拆分为固定区间内容寻址 segment；
- attachment 对象共享；
- `cwdPolicy: remap` 或 Workspace alias；
- 更多 provider 适配（OneDrive delta、Google Drive changes）；
- `cloud` 后端的对象缓存策略（省流量 vs 省磁盘的取舍）；
- 端到端加密可选项。

---

## 14. 与 `dsh-session-log-export` 的关系

不要直接依赖或复用 `@deepseek-ai/dsh-session-log-export`：

| 维度 | dsh-session-log-export | session-sync |
|---|---|---|
| 目标 | 浏览器下载 ZIP | 云盘目录长期同步 |
| 数据源 | Host 路由 + 浏览器触发 | Host 服务/命令 |
| 格式 | 一次性 ZIP | 版本化、内容寻址 bundle |
| 方向 | 只导出 | 导入 + 导出 |
| 冲突 | 不涉及 | 必须处理 |
| Workspace | 不涉及 | 必须处理绑定 |
| 派生数据 | 不涉及 | 明确不导出 |
| 传输 | HTTP `Response` | 目录语义（后端 `dir` / `cloud` 可插拔） |
| 凭据 | 无 | 插件不持有；`cloud` 后端经 OS credential store 持有 |

可以复用的只有底层概念：

- 通过 `sessionPersistence` 读句柄读取；
- 通过 `sessionQuery.traceSession` 拿谱系；
- 通过 `attachments.readImage` / `readFileStream` 拿附件；
- 通过 `sessions.flush` 保证 live Session 一致。

如果未来发现导出序列化代码重复，可以把这部分抽到一个更底层的公共库，而不是让 `session-sync` 依赖浏览器导出包。

---

## 15. 开放问题

1. **跨设备 cwd 重绑定**：v1 preserve，长期是否需要 Workspace alias/rebinding 协议？
2. **冲突后的用户体验**：冲突远端是丢弃、隔离、还是自动 fork 成新 Session？
3. **revision 保留策略**：云端 revision 是否需要有界保留？谁来 GC？
4. **大 Session 增量**：event segment 的分块策略和云盘成本需要实测。
5. **附件导入 seam**：是否正式给 `AttachmentStore` 增加 `import*`，还是 fallback 到 `saveImage` / `saveFile`？
6. **多设备身份**：是否需要设备 id、签名、加密，还是 v1 只依赖受信任的远端对象空间？
7. **自动导出触发点**：session idle、flush、dispose 还是定时？
8. **是否同步归档/删除状态**：v1 建议不删除，后续单独设计 tombstone。
9. **`cloud` 后端的进程边界**：v1 是 Harness 进程内的后台任务，因此 token 在 Harness 内存里。是否值得为凭据隔离引入独立 helper 进程 + 本地 IPC（§3.4.9）？还是保持进程内、只做"不进日志 / 最小 scope / 可 revoke"三重约束？
10. **方向性**：默认双向，但"只 pull 不 push"是否应作为首次连接的默认（先观察再写入，降低误覆盖风险）？
11. **多设备并发写**（已决，见 §3.4.6）：多台机器各自授权时，同一远端对象空间会被多个实例并发写。内容寻址的不可变对象天然幂等；manifest 的并发提交靠厂商语义（`MOVE` 到已存在目标失败）与**导入时**前缀比较兜底。**不引入跨设备单写者选举，接受事后隔离** —— 单写者只在单机范围内由本地 lockfile 保证（§3.4.8）。
12. **provider 覆盖范围**：iCloud Drive 没有面向第三方的文件级 OAuth API，是否直接在配置层标记为"只能配后端 `dir`"，还是走 CloudKit 私有容器另做设计？
13. **大文件断点续传的状态驻留**：分块上传的 session 状态放在内存还是持久化？进程重启后如何续传或安全放弃？
14. **`cloud` 后端的对象缓存策略**：`openRead` 是否要保留本地对象缓存？保留则省流量、多占磁盘，且缓存本身也成了需要治理的状态；不保留则每次导入都全量下载。
15. **契约违约的运行时探测**：C1/C2 这类条款能否在运行时用探针（写一个哨兵对象再读回）低成本自检，还是只能在 `scan()` 时做一次？对 `cloud` 后端来说这是自研实现，风险低于第三方后端，优先级可降。
16. **`index` / `journal` 的存储介质**：用 SQLite 还是 append-only 文件组？SQLite 事务最省事，但把"状态"引入了一个二进制依赖；文件组更透明但需要自己保证一致性。
17. **WebDAV 大对象分块**：`PUT` 同时受"必须带 `Content-Length`"与 `webUploadMaxSize` 约束，且没有 resumable upload。大附件是按 §4.1 单对象存放、还是在对象层加分块（`<sha256>.part<n>` + 清单）？一旦分块，C3 / C4 的作用域就从"一个文件"变成"一组文件"，需要明确"清单最后提交"的等价规则（§3.4.12.3 陷阱 4）。
18. **WebDAV 全树扫描成本**：`full-scan` 下每轮同步的请求数与延迟需要实测。用目录 `getlastmodified` 剪枝在坚果云以外的 DAV 服务上是否可信？是否需要在 §3.5 里为"可选的目录时间语义"单独列一条弱保证条款？
19. **C4 探针的频率**：每次 `rename` 都做后置校验（多一次 `PROPFIND`），还是首次连接校验一次 + 抽样？前者用请求数换确定性，后者省流量但可能长期带着一个违约后端运行。
20. **WebDAV 是否应升级为独立 backend kind**：目前把它作为 `cloud` 的 `remote-move` profile。如果 WebDAV 专属逻辑（分页、同目录 `MOVE`、ASP 凭据、全树扫描）继续增长，是否拆成 `kind: 'webdav'`，让 `cloud` 只保留 `local-index` 的对象型 provider？拆分的判据是：**它的 C2 / C4 由服务端提供，而 `cloud` 的整套状态机正是为"服务端不提供"而存在的。**
21. **厂商冲突语义的覆盖度**：各厂商报冲突的方式并不统一（Dropbox `conflicted copy`、DAV `405 ResourceExisted`、条件写 `412`、部分 provider 干脆 last-writer-wins）。是否需要一份"厂商冲突语义矩阵"，把每家在 C4 上的保证逐项标出来，不满足的直接降级为只读或只允许配 `dir`？

---

这份设计的核心原则可以概括为：

> 不复制物理 Session 日志，导出**逻辑 Session 树 + 附件**；  
> 不依赖云盘锁，依赖**内容寻址 + manifest 最后提交 + 哈希校验**；  
> 不自动合并分叉日志，冲突**隔离并上报**；  
> **不自建冲突检测** —— 检测归同步层（云盘客户端或云厂商），后端只转述、插件只校验；语义层冲突只在**导入时**识别并隔离，接受"事后发现"；  
> 导入后通过 persistence API 重建 Session，并显式修复 Workspace 绑定与 UI 刷新；  
> 厂商 API 与凭据**全部封在后端实现里**，插件只见目录 —— 目录由外部客户端填（`dir`）还是由厂商 API 直接支撑（`cloud`），对插件不可见；  
> 插件依赖的不是"本地磁盘"，而是**一组目录行为（§3.5 契约）** —— 契约先于实现；不做内核挂载，目录语义在进程内实现即可。
