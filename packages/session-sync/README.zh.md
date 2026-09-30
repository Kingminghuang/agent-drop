---
description: "跨设备会话同步服务（ctx.sessionSync）：通过已注册的同步后端进行导出、导入、扫描与操作状态管理"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-sync

[English](README.md) | 中文

## 概述

`dsh-session-sync` 拥有 `ctx.sessionSync`：跨设备同步服务。一次操作选择一棵根会话、追溯其完整谱系、flush live 历史、固定快照上界，并通过权威 seam 读取 header、事件与附件，发布内容寻址同步包。导入核验每份清单与每个对象、解析 portable 工作目录、准备目录与 Workspace、恢复附件，并在写入之前把每个 Session 与本地历史比较：创建、追加后缀、跳过，或报告冲突并保留双方。操作在一把互斥锁上串行，并保持其受理时的 root。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本服务与会话持久化、session query 和会话存储一同挂载，再挂载一个后端提供方（随产品交付的组合挂载 [`dsh-session-sync-dir`](../session-sync-dir/README.zh.md)）。独立页面是随产品交付的入口；Host 代码也可以直接驱动本服务。

```yaml
- id: session-sync
  name: '@deepseek-ai/dsh-session-sync'

- id: session-sync-dir
  name: '@deepseek-ai/dsh-session-sync-dir'
```

### 一次操作做什么

`exportTree(rootSessionId)` 拒绝不完整谱系，在每个 live 会话 flush 之后固定其快照上界，通过持久化句柄读取每个 header 与事件，通过附件存储读取每个被引用附件，发布内容寻址对象，最后发布树清单。无法 portable 表示的工作目录会在发布任何内容之前跳过整棵树。

`importAll()` 扫描介质，读取每个可见清单，在任何本地写入之前核验每个被引用对象，并按 Session 报告结果：对象尚未到齐的会话为 `pending`；已到达但摘要不符的对象使整棵树失败。流水线按目标平台预检每个 portable cwd，把每个 cwd 解析到导入用户 home 之下的目录，安全创建缺失目录，登记或复用 Workspace 记录，恢复每个被引用附件，然后逐会话比较并写入：本地不存在则携带已解析 header 与继承计数创建；本地是前缀则只追加远端后缀；本地领先或一致则跳过；header 身份字段不一致或事件分叉则报告 `conflict` 并保留双方。每次写入都通过写句柄本身重新确认本地历史，因此重试从中断的会话处继续且不重复事件；live 会话只比较、绝不取其写句柄。

`scan()` 读取每个可见清单并核验每个被引用对象，报告就绪状态且不写入任何内容。

### 操作状态

每次提交返回一个引用：操作 id 与一个以逐树逐 Session 结果或失败结算的 Promise。记录只存在于进程内——Host 重启后不重放任何操作，页面重新扫描介质。操作已受理或运行中时再提交会被拒绝，并返回可读的"正在运行"结果。

<a id="configuration"></a>
## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `root` | 未设置 | 外部云盘客户端复制的完整限定本机同步目录。未设置时拒绝一切提交。声明为 volatile，因此随产品交付的 Web UI 经 dsh Settings 编辑它，且数值实时生效。 |

已配置 root 在提交被受理之前校验：必须是完整限定的目录路径，且不得与 harness home、其会话存储或其附件存储重叠。符号链接绝不会把一次写带出已解析 root。

<a id="understand-the-implementation"></a>
## 理解实现

<a id="dev-note"></a>
<details>
<summary>实现内部——点击展开</summary>

`backend.ts` 声明存储 seam 与"对象缺失"拒绝；`paths.ts` 规范化已配置 root 并拒绝受保护的重叠；`observe.ts` flush live 会话、固定上界、并结构比较事件；`export.ts` 快照并发布一棵树；`import.ts` 校验、准备、比较并写入；`scan.ts` 报告就绪状态；`operations.ts` 保存记录并串行化提交。流水线绝不打开 live 会话的写句柄：`ctx.sessions.get(id)` 在任何 open 之前判定忙，后续 open 抛出的 `SessionAlreadyOwnedError` 被包含在该会话的结果里。没有发布运行时不变量伴随，因为操作记录经状态 API 暴露并由行为测试覆盖；不存在伴随可以比较的独立可观察关系。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [会话同步子系统](../../docs/session-sync.md) — 介质布局与流水线语义。
- [本机目录后端](../session-sync-dir/README.zh.md) — 随产品交付的存储提供方。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本服务不注册任何工具、提示词小节或会话事件：同步完全运行在人类指令与 Host 服务平面。

#### KV Cache 效应

无；没有任何模型请求承载同步状态。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办工作

- **没有自动同步** — 本服务不会自行搬运任何内容；监听文件的 Host 或云盘客户端不属于本阶段范围。
- **冲突从不合并** — 分叉的会话保留两个版本并报告冲突；刻意缺席自动和解。
- **live 会话无法接收导入** — agent 正在运行的会话报告失败而不是取其写句柄；agent 停止后重试即可完成。

## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
