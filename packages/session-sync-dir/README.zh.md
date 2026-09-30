---
description: "DeepSeek Harness 的本机目录同步后端：在一个由云盘复制的文件夹上进行内容寻址发布与核验读取"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-sync-dir

[English](README.md) | 中文

## 概述

`dsh-session-sync-dir` 是 [`ctx.sessionSync`](../session-sync/README.zh.md) 随产品交付的 `dir` 存储后端。它操作本机上一个由外部云盘客户端跨设备复制的目录：发布把字节暂存在私有 temp 目录中、fsync、提交到摘要派生路径、即使内容不同也替换已存在的目标，并把每次提交读回核对摘要。读取把被寻址字节与调用方摘要核对，并以类型化的"缺失"错误拒绝缺失对象。


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

把本后端与同步服务一同挂载；随产品交付的 base bundle 已组合两者。

```yaml
- id: session-sync
  name: '@deepseek-ai/dsh-session-sync'

- id: session-sync-dir
  name: '@deepseek-ai/dsh-session-sync-dir'
```

本后端没有自己的配置：已配置的同步 root 属于服务，后端把它规范化为已解析 root 之下的包目录树 `dsh-session-sync/`。其规范拼写与 harness home、其会话存储或其附件存储重叠的 root 会拒绝后端的准备。

### 一次发布保证什么

发布把精确字节暂存在 `dsh-session-sync/tmp` 下一个独占、仅属主可见的临时名中，fsync 文件，提交到 `objects/<family>/<sha256>` 或 `trees/<rootSessionId>/<revisionHash>.json`，并持久化已提交条目的目录。已存在的目标即使内容不同也会被替换——这是摘要命名路径的成文覆盖规则——且提交后的字节会在发布结算前读回并核对摘要。被中断的发布绝不会以成功结算，也绝不会留下一个读回失败的已提交文件。

### 一次读取核验什么

`readObject` 用 `SyncObjectMissingError` 拒绝缺失对象——导入把它转为逐 Session 的 `pending`——并在返回字节前对照摘要核验。`readTree` 额外拒绝目录解析到已准备 root 之外的清单，因此清单路径绝不能把一次读取带出介质。

<a id="understand-the-implementation"></a>
## 理解实现

<a id="dev-note"></a>
<details>
<summary>实现内部——点击展开</summary>

`publish.ts` 拥有暂存、持久发布、摘要核验与树列举；`index.ts` 把 seam 的五个动词适配到其上，并在已配置 root 之下准备包布局。目录 fsync 在平台暴露目录句柄处运行；Windows 依赖 NTFS 元数据日志。没有发布运行时不变量伴随，因为后端不拥有缓存状态：每次读取都直接核验介质，发布／读取往返由行为测试覆盖。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [会话同步子系统](../../docs/session-sync.md) — seam 约定与介质布局。
- [同步服务](../session-sync/README.zh.md) — 本后端承载的流水线。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本后端不注册任何工具、提示词小节或会话事件：它为同步服务在 Host 文件系统上搬运字节。

#### KV Cache 效应

无；没有任何模型请求承载后端状态。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办工作

- **一个本机目录，一个设备视图** — 后端只看到云盘客户端目前已同步的内容；对象仍在途的清单是 pending 而非失败。
- **没有跨进程写者锁** — 两个发布到同一 root 的 Harness 实例在介质本身上串行；覆盖规则保留最后提交的字节，而非合并结果。

## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
