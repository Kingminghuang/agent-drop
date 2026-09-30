---
description: "内容寻址的会话同步包格式：树清单、事件与附件对象、portable cwd 编码"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-sync-format

[English](README.md) | 中文

## 概述

`dsh-session-sync-format` 定义一个由云盘复制的同步目录所承载的词汇：每个根会话修订一份树清单、每个会话一个事件对象、每个附件一个附件对象，以及会话工作目录的 portable home-relative 编码。每个产物都以自身字节的 SHA-256 命名，每次读取都把名称与内容核对，因此清单的引用只有在介质确实持有数据时才可解析。本包是纯库：不挂载服务、不注册工具、不读取存储。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在实现同步后端或在交付流水线之外读取同步包时，导入编码与校验助手。

### 介质布局

一个已配置 root 承载一棵包目录树 `dsh-session-sync/`：`objects/events/<sha256>.jsonl`（每行一个规范逻辑事件，seq 从 0 连续）、`objects/attachments/<sha256>`（精确存储字节）与 `trees/<rootSessionId>/<treeRevisionHash>.json`。`treeRevisionHash` 是清单自身规范字节的 SHA-256。后一次发布允许替换同一路径上已有的不同内容；本格式不保留被替换的字节。

### 树清单

`SYNC_FORMAT_VERSION` 标记当前同步包格式。盖有其他版本的清单会被明确拒绝，不猜测兼容方式。清单按依赖顺序携带根会话及全部后代、其 portable header、继承事件计数、事件对象引用与附件条目；结构校验覆盖字段类型、标识、谱系闭包、父先于子的顺序，以及每个引用的摘要形状。对象本身由调用方读取并核对摘要。

```ts type-equiv
/** One tree manifest: the complete lineage of one root session and the objects that carry its history. */
interface SyncTreeManifest {
  /** Fixed manifest tag. */
  readonly type: 'dsh-session-tree'
  /** Current sync-package format version. */
  readonly formatVersion: typeof SYNC_FORMAT_VERSION
  /** The root session whose lineage this manifest publishes. */
  readonly rootSessionId: string
  /** Root first, then every descendant in dependency order; ids are unique. */
  readonly sessions: readonly SyncSessionEntry[]
}
```

### Portable 工作目录

`encodePortableCwd(cwd)` 通过 `realpath` 解析当前用户实际 home 与绝对 `cwd`，计算相对组件，且只有当结果重新满足组件不变量时才返回编码：组件不得为空、不得为 `.` 或 `..`、不得包含路径分隔符或控制字符、每组件至多 255 个 UTF-8 字节，并且在 Windows 上不得是保留设备名、不得含禁止字符、不得以点或空格结尾。`resolvePortableCwd` 把已校验组件拼接 onto 已解析 home。portable 编码是同步 header 中唯一的 `cwd` 表示。

### 附件引用

附件条目在对象摘要旁原样携带原始引用，因此恢复的图片解析出精确记录的 `ImageAttachmentRef`，恢复的文件携带记录的 `FileAttachmentRef`。声明字段遍历（`collectAttachments`）只读取第一方事件内容字段与已完成的 assistant stream 块；未知事件载荷保持不透明，不授权任何读取。

<a id="understand-the-implementation"></a>
## 理解实现

<a id="dev-note"></a>
<details>
<summary>实现内部——点击展开</summary>

`digest.ts` 对字节与文本做摘要并校验摘要形状的路径引用；`portable-cwd.ts` 在可注入的平台规则下编码、解码并预检 portable cwd；`manifest.ts` 规范化、编码、解码并结构校验清单；`events.ts` 编码并结构解码事件对象；`attachments.ts` 从声明字段收集引用并构建清单条目。信封校验就地采纳事件；针对会话历史的完整回放校验由调用方负责。没有发布运行时不变量伴随，因为本包不拥有可变状态：每个操作都是输入的纯函数，行为测试拥有往返验证。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [会话同步子系统](../../docs/session-sync.md) — 消费本格式的服务约定。
- [会话持久化子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.zh.md) — 对象承载其逻辑事件的持久化 seam。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包不注册任何面向模型的面：它只为 Host 侧消费方编码并校验同步包产物。

#### KV Cache 效应

无；本包不参与任何模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办工作

- **单一格式版本，拒绝即失败** — 来自不同同步包版本或会话逻辑格式的清单会被拒绝而非迁移；后继格式需要新版本并记录迁移。
- **被替换的字节保持被替换** — 覆盖规则意味着后一次发布到同一摘要路径会让旧清单指向不同字节；本格式无法恢复它们。

## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
