# 阶段 1：通过同步目录手动迁移 Session

> 状态：设计稿，尚未实现。本文定义阶段 1 的同步包、`dir` 后端、导入导出、dsh `/sync` 指令和独立 Web UI。产品边界见[总览](./session-sync.md)；在 Web UI 保存配置时触发的一次导入或导出见[阶段 1.5](./session-sync-phase-1.5.md)，直连和后台自动同步见[阶段 2](./session-sync-phase-2.md)。实施前须对照当前代码核验 Harness API、Host 路由和配置写入能力。

## 用户流程与交付

1. 用户在两台设备配置指向同一云端数据的本地同步目录；外部云盘客户端负责上传与下载。
2. 在设备 A 输入 `/sync export`，或从独立 Web UI 选择根会话并导出。Host 收集完整会话树及附件，在本机目录发布同步包。
3. 云盘客户端把文件传到设备 B。设备 A 的导出成功只表示本机发布完成。
4. 在设备 B 输入 `/sync import`，或在独立 Web UI 扫描并导入。系统校验收到的数据、比较本地历史并逐项报告结果。
5. Host 报告本机工作区绑定结果；项目文件和运行环境须由目标设备本身提供，导入历史不恢复运行现场。

阶段 1 同时提供 dsh 斜杠指令和独立 Web UI。两者共用同步服务和本机操作协调规则。生产环境只支持 `dir` 后端。Web UI 可选择根会话、导出、扫描并导入同步包、查看操作状态，以及查看和编辑配置；它不依赖 Harness Web UI 的页面或聊天上下文。阶段 1 不会自动导入或导出，也不提供直连授权入口。

## DSH 实现参考

本设计描述跨设备同步行为，不定义 DSH 的插件装配、Session 持久化、命令注册、设置写入或 Host 路由 API。开始实现时，须同时提供本仓库和 [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 源码；仅凭本文无法推断这些接口。实现前先阅读 DSH 的[根级 Agent 指引](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md)和[架构图](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)。[`docs/AGENTS.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md)规定 DSH 文档的编写方式，只在修改 DSH 文档时阅读，不能替代下表中的运行时参考。

| 阶段 1 涉及的能力 | DSH 权威入口 |
|---|---|
| Session 逻辑类型、事件与持久化语义 | [Session 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.zh.md)、[`dsh-session` 包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.zh.md)、[Session 持久化包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/README.zh.md) |
| 附件读取、保存及引用 | [附件子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.zh.md)、[附件接口包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment/README.zh.md)、[本地附件实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/attachment-local/README.zh.md) |
| `/sync` 命令的注册、分发、结果和取消 | [命令子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/commands.zh.md)、[命令注册包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/commands/README.zh.md) |
| 配置读写、Host 服务与本机 API | [设置子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/settings.zh.md)、[设置包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/settings/settings/README.zh.md)、[Host 包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/README.zh.md)、[Web Server 包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.zh.md)、[Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.zh.md)、[Settings Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/settings-controller/README.zh.md) |

这些入口用于查找相关契约。实现前还要沿文档链接核对当前源代码、同类插件和对应测试。阶段 1 标注为“须核验”或“须补充”的能力，不能当作 DSH 已提供的 API。实现任务和 PR 应记录所依据的 `deepseek-harness` commit，并以该 checkout 中的类型、装配方式和生命周期为准。

## 数据归属与同步包

本地会话日志和附件仍由 Harness 管理。同步目录 `root` 只存放根据逻辑会话生成的对象和清单，不存项目源码，也不直接复制物理 Session 文件。`root` 不能为空，也不能与会话或附件存储根重叠。Host 先规范化并解析路径，再检查这些条件；如果路径借助符号链接指向同步根之外，Host 必须拒绝写入。

```text
<root>/dsh-session-sync/
  objects/events/<sha256>.jsonl
  objects/attachments/<sha256>
  trees/<rootSessionId>/<treeRevisionHash>.json
```

一个同步包包含一份树清单、每个 Session 对应的事件对象，以及事件引用的附件对象；它不是 ZIP 文件。事件对象采用当前逻辑事件的规范编码，每行一个事件，并保留原序号。事件和附件对象分别以各自原始字节的 SHA-256 命名；`treeRevisionHash` 则是树清单规范编码字节的 SHA-256。树清单记录格式版本、根 Session 及其所有后代的 id、完整 header、`inheritedEventCount`、事件数量和对象摘要，以及附件类型、原引用标识、摘要和恢复所需的元数据。Session 记录可带可选的 `cwdHint`，例如 `{ "kind": "home-relative", "components": ["a"] }`，表示原始 `cwd` 相对于导出设备用户 home 目录的路径组件；原始 `cwd` 为 home 目录时 `components` 为空数组。只有原始 `cwd` 和 home 目录均可规范解析，且 `cwd` 的真实路径位于 home 目录内时才生成此提示；无法安全判定、路径位于 home 之外或经过符号链接解析后逃出 home 时省略。提示不能包含绝对路径、`.`、`..`、路径分隔符或 NUL。它只用于在导入设备上自动推导本机路径，不属于 Session header 或会话身份。导入后须在同步服务的本机元数据中保留该提示，以便后续导出继续携带；本机工作区绑定路径不写入同步包。解析清单时，应检查字段类型、标识、序号连续性、父子关系、引用路径，并核对清单自身和所有对象的摘要。遇到不支持的格式版本时应明确拒绝，不能猜测兼容方式。

对象和树清单按内容摘要命名，内容变化通常会产生新路径。允许后一次成功发布替换同一路径上的不同内容；同步目录不保留被替换的旧值。读入时仍须核对路径摘要、清单摘要和对象摘要，校验失败的数据不得导入。真实摘要碰撞或错误命名可能使旧清单引用到被替换的内容，因此同一路径的旧字节不保证可恢复。临时文件尚未提交，不能作为导入入口。具体 JSON 字段和编码须在实现时根据持久化类型与附件接口定稿，并补上格式样例和读写往返测试。本文中的示意字段不代表已发布的持久格式。

## 本机发布与跨设备接收

`dir` 后端只操作本机文件系统。导出时先把事件和附件写入临时文件，校验内容和摘要后再发布对象，最后发布树清单。目标路径已存在时允许替换，即使已有内容不同；应使用目标平台支持的替换写入方式，并读回校验最终字节。发布中断或替换后摘要不匹配时不能报告成功，也不能把临时文件当作已提交数据。同步包路径按摘要命名，正常内容变化会生成新路径；此覆盖规则处理同一路径发生不同内容写入的情况。

外部云盘客户端可能乱序传输、延迟列出文件、改写冲突副本的文件名，或让两台设备看到不同的文件状态。因此，`dir` 在本机发布成功，不代表跨设备发布是原子的。导入方不能根据文件出现顺序或文件名判断数据是否有效。扫描到树清单后，应解析其中的标识和对象引用，逐个确认对象可读且摘要正确。清单已到、对象未到时，报告 `pending`，之后可以重试；对象已到但摘要错误时，报告 `failed`，不得导入这棵树。同一会话存在多个版本时，按内容比较是否可导入，不能根据“最新文件名”决定采用哪个版本。

## 导出与导入语义

导出时默认选择一个根 Session 及其全部后代。对于 live Session，先让 Harness 持久化内存中的事件，再固定本次快照的事件上界；导出期间新追加的事件留到下次导出。谱系不完整时，默认拒绝导出整棵树。遍历时通过逻辑持久化 API 读取 header、事件和继承事件计数，再通过附件服务读取原始附件；不直接把压缩日志或附件存储目录用作传输格式。

导入在写任何本地 Session 前先验证整棵树的清单、事件和附件。随后对每个 Session 按下表比较；比较和写入之间须重新确认本地历史没有变化，live Session 忙碌时不强行取得写句柄。

header 比较包含 `id`、`createdAt`、原始 `cwd`、`parentSession`、`isSeeded`、`delegationDepth`、`origin`、`agentPreset` 及继承事件计数。`cwdHint` 和本机工作区绑定不参与 header 比较；导入或绑定都不能改写 Session 中的原始 `cwd`。格式版本变化需要先按 Harness 的正式迁移规则处理，不能仅因物理编码不同就判定逻辑历史分叉。

| 本地与远端关系 | 动作 |
|---|---|
| 本地不存在 | 创建同 id、同 header、同继承计数的 Session，再写入事件 |
| header 与事件完全一致 | 跳过 |
| 本地事件是远端事件的前缀 | 只追加远端后缀 |
| 远端事件是本地事件的前缀 | 跳过，不回退本地 |
| header 身份字段不一致，或事件分叉 | 不写冲突 Session，保留本地与同步目录中的版本并报告冲突 |

必须先恢复附件，再写入引用它的事件。只有引用和字节摘要都一致时，才能复用已有附件。当前 `AttachmentStore` 有读写接口，但不支持按原引用导入已规范化的图片。实施时须补上这项恢复能力，并确认写入后的引用完全一致。不能用重编码后“差不多相同”的引用代替，也不能把附件存储的内部目录当作公开导入接口。

导入不保证整棵树可以事务回滚。每个 Session 分别报告 `created`、`appended`、`skipped`、`pending`、`conflict` 或 `failed`，并说明中断前已完成哪些部分。重新执行时，按当前本地事件重新比较前缀并从中断处继续，不能重复追加事件，也不能覆盖本地领先的历史。单个 Session 写入中断后能否读取、如何恢复，须先通过持久化 API 验证，再定稿并用故障注入测试覆盖。

Session header 中的原始 `cwd` 始终保持不变。导入时不得仅凭这个跨平台路径字符串推断目标目录。阶段 1 只为根 Session 建立 Workspace 绑定；如果根 Session 有有效的 `cwdHint`，Host 使用目标设备当前用户的 home 目录和提示中的路径组件，通过本机路径 API 推导本机路径；例如 macOS 上的 `$HOME/a` 可映射为 Windows 上 `%USERPROFILE%\\a` 对应的实际本机路径。清单不保存目标设备的 home 路径或环境变量字符串。若推导出的路径存在、实际可用且通过 Workspace 校验，Host 自动将根 Session 绑定到该路径，不要求用户确认。该绑定保存在本机状态中，不改写 Session header，也不进入同步包。没有安全的 `cwdHint`、路径不存在或 Workspace 校验失败时，仍可导入并查看历史，但不绑定工作区，并在结果中说明继续运行受限及原因。后代 Session 的原始 `cwd` 各自保持不变，阶段 1 不对其单独建立本机绑定。系统不声称项目文件已同步。导入完成后，Harness 现有会话列表应在重新查询时显示这段历史；实时推送刷新留到阶段 2。实现前须确认 Harness 支持在保留 header `cwd` 的同时单独设置本机 Workspace 绑定；若不支持，阶段 1 只导入历史并报告无法绑定，不能通过改写 header 绕过限制。

## 两个入口和本机访问

斜杠指令提供 `/sync export [rootSessionId]`、`/sync import` 和 `/sync status`。导出时若未提供 id，就从当前会话解析根会话。独立 Web UI 没有当前会话上下文，因此需要提供根会话列表。导入时 Host 自动尝试 `cwdHint` 映射和 Workspace 校验；命令不要求用户确认，也不接受任意文件路径参数。指令不向模型发送消息。命令注册、生命周期日志和取消信号的接口须对照当前 dsh 命令 API 核验。命令触发导出时，快照上界不能等待该命令自身的 `command/done` 事件。

独立 Web UI 由 Host 本机服务提供页面和同源 API。最小 API 支持列出根会话、提交导入或导出、扫描同步目录、查询操作状态和结果，以及读取和更新配置。耗时操作先返回操作 id；请求已受理不代表操作成功，页面须轮询最终结果。斜杠指令则等待同步服务返回结果后直接展示。两个入口共用本机互斥锁，操作进行时再次提交会收到“正在执行”。Host 重启后，页面重新扫描同步目录中的实际数据，不自动重放操作。具体路由、认证、命令注册和任务 API 须根据 Host 的承载能力定稿。

Web UI 只编辑同步目录 `root`。根会话列表应包含已归档会话并标注状态；每次导出都要明确选择一棵树。导入时 Host 自动尝试 `cwdHint` 映射和 Workspace 校验，页面在操作结果中显示是否绑定及未绑定原因，不增加确认步骤。阶段 1 固定使用 `dir` 后端，保留原 `cwd`，并拒绝自动合并冲突。页面不显示直连授权或自动触发开关。配置优先复用 dsh Settings 和现有持久化机制；当前表单只接受插件声明为 volatile 的字段，实施前须确认 `root` 是否适用。Host 校验配置并返回实际生效值。保存失败时不能报告为已生效；如果无法安全地在线修改，页面须说明配置将在下次启动时生效。已受理的操作继续使用受理时的目录。

本机服务默认只监听 loopback，复用 Host 身份机制，并校验请求来源。写请求须防 CSRF，不能开放任意来源的 CORS。Host 负责校验会话 id、操作 id、请求体和配置路径；浏览器不能指定任意 Host 文件作为导入源或导出目标。同步目录下的对象引用和清单中的相对路径不能包含路径遍历、绝对路径或 NUL；`header.cwd` 是保留的原始 Session 元数据，不得直接用作文件访问目标。日志只记录标识、摘要、计数和状态，不记录会话正文、凭据或不必要的完整路径。

## 阶段 1 验收

1. A 导出的根会话、子会话和附件，经外部客户端传到 B 后可完整导入；逻辑事件、谱系和附件字节一致，既有列表重新查询可见。
2. 重复导入、B 续写后导回 A 的连续历史均不重复事件；本地领先不回退，双端分叉不自动合并。
3. macOS 与 Windows 间导入 home 子目录中的会话时，清单提示能生成目标设备的本机路径；路径存在且通过 Workspace 校验后自动绑定，不要求用户确认。没有安全提示、路径不可用或校验失败时，历史仍可导入且不绑定，并报告原因。导入再导出后原始 `cwd` 和 `cwdHint` 保持一致，本机绑定路径不进入同步包。
4. 清单先到、对象延迟到达时先报告 `pending`、到齐后成功；摘要错误、非法路径和格式不支持时拒绝写入。
5. 在对象发布、附件恢复、Session 创建和事件追加期间注入中断；报告部分结果，重试后达到完整状态且不重复追加。
6. 独立页面不打开 Harness Web UI 即可选择会话、导出、导入、查询状态和编辑配置；斜杠指令与页面在相同源快照下遵循相同业务规则。
7. Host 不可达、会话忙碌、路径不匹配、非法配置、未授权请求和两个入口并发提交都得到可理解的结果；未完成操作不得显示为成功。
