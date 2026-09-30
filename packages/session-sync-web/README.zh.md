---
description: "Host 提供的独立会话同步 Web UI：根会话列表、导出、扫描、导入、操作状态与 root 配置"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-sync-web

[English](README.md) | 中文

## 概述

`dsh-session-sync-web` 在 `/session-sync` 提供独立的会话同步页面，并在已认证的 connection 通道上挂载其同源 API。页面列出候选根会话（含已归档并标注状态）、提交导出、扫描同步目录、导入已到达的树、轮询操作状态，并经 dsh Settings 编辑同步 root。它不依赖 Harness Web UI 的页面、聊天上下文或任何客户端 bundle：页面是一份自包含的 HTML 文档，其脚本轮询同源 API。


## 目录

- [使用本包](#use-this-package)
- [路由与访问](#routes-and-access)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包与 web server、connection、同步服务和 settings 一同挂载；随产品交付的 web bundle 已组合它们。

```yaml
- id: session-sync-web
  name: '@deepseek-ai/dsh-session-sync-web'
```

在服务 Host 的 loopback URL 上打开 `/session-sync`。

<a id="routes-and-access"></a>
## 路由与访问

| 路由 | 方法 | 行为 |
|---|---|---|
| `/session-sync` | GET、HEAD | 自包含页面；Host 不在其上渲染任何数据 |
| `/api/session-sync/config` | GET | 已配置 root、其有效性、以及已组合的后端 |
| `/api/session-sync/config` | POST | 经 dsh Settings 校验并保存 root；返回实际生效值，绝不把失败的保存报告为已生效 |
| `/api/session-sync/sessions` | GET | 候选根会话，最新优先，携带 live、persisted 与 archived 状态 |
| `/api/session-sync/export` | POST | 按 `sessionId` 提交一次导出；以操作 id 应答 202 |
| `/api/session-sync/import` | POST | 提交一次导入；以操作 id 应答 202 |
| `/api/session-sync/scan` | POST | 提交一次扫描；以操作 id 应答 202 |
| `/api/session-sync/operations` | GET | 受理顺序中的每条操作记录 |
| `/api/session-sync/operation/<id>` | GET | 一条操作记录，或 404 |

每个 API 路由都经 connection 服务的信任围栏——Host／Origin 检查加浏览器认证——因此在任何路由主体运行之前，未认证请求已被拒绝。媒体类型不是 `application/json` 的写入会被拒绝：跨站表单提交不经 CORS 预检无法携带该内容类型，而本服务不提供任何 CORS。浏览器只指定会话 id 与已配置 root；它不能把 Host 指向任意文件。

-----

没有发布运行时不变量伴随，因为页面不保留任何 Host 状态：每个路由都是同步服务的投影，API 由行为测试覆盖。

<a id="further-exploration"></a>
## 延伸阅读

- [会话同步子系统](../../docs/session-sync.md) — 页面驱动的服务。
- [HTTP 服务器子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.zh.md) — 承载页面的载体。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包不注册任何工具、提示词小节或会话事件：页面与其 API 只服务操作者的浏览器。

#### KV Cache 效应

无；没有任何模型请求承载页面状态。



<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办工作

- **没有实时刷新** — 页面靠轮询；上一次轮询之后变化的会话列表在下一次刷新前是陈旧的。
- **操作不是持久的** — 记录只存在于进程内；Host 重启后页面重新扫描介质，不显示任何被重放的操作。
- **未认证的调用方只看到拒绝** — 页面本身无需认证即可加载；在操作者通过 Host 自己的流程登录之前，每个 API 调用以 401 应答。

## 开发备注

<a id="dev-note"></a>
<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
