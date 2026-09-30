---
description: "会话菜单里的“导出会话”action 与同名键盘命令，经同源 session-sync Web API 提交导出"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-sync-client

[English](README.md) | 中文

## 概述

把会话同步的导出动作放进浏览器：每个 Session 行的 "..." 菜单在 shipped Archive 行（order 400）之后以 `separatorBefore` 开一组，提供**导出会话**（order 500）；键盘命令 `sessionSync.exportSession` 作用于主会话，默认键位 desktop 为 `Mod+Alt+E`、web 为 `Mod+Shift+E`（可在快捷键速查中改键，菜单行显示当前有效绑定）。点击或按键后，本包经同源认证 API `POST /api/session-sync/export` 提交并轮询操作至结算，一枚 `shell.overlay` toast 报告导出的会话数或失败原因。目标 id 可以是树中任意会话：Host 侧解析谱系根并总是发布整棵树。

本包不直接触碰同步介质，也不持有同步状态：介质、互斥锁与结果全部归 [`dsh-session-sync`](../session-sync/README.zh.md) 服务所有，独立页面与命令行通道与本包共用同一把互斥锁（忙碌时提交得到 409，渲染为可读失败）。

## 装入

1. Host 侧照常挂载 `dsh-session-sync`、`dsh-session-sync-dir` 与 `dsh-session-sync-web`（见仓库根 README）。
2. 让 client-modules 能解析本包：在 web 组合的 `cordis.patch.yml`（或你的 profile）加一行：

```yaml
- id: session-sync-client
  name: '@deepseek-ai/dsh-session-sync-client'
```

3. 构建浏览器 bundle：本包必须在 harness 工作区内可寻址（`packages/*/*/package.json` 的清单扫描），再在包目录运行 `tsdown`。本仓库的既定做法是在 harness checkout 建立真实目录并以符号链接接入各文件（`package.json`、`src`、`tsdown.config.ts`、`lib`），产物经 `lib` 链接落回本仓库。

## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器入口注册三件事：菜单行与 toast 都经 `slots.inject()` 等待各自的目标 slot 声明（分别由 ui-workspace 的浏览器注册与 ui-layout 声明）；键盘命令经 `ctx.effect()` 注册进 `ctx.shortcuts`，`resolve` 按 shipped rename/fork/archive 的同一规则取主会话（`retainedBy.mainView > 0`，空白会话 blocked）。提交与轮询在 `src/client/api.ts`，纯 `fetch`、无 harness 导入，node 侧 vitest 直接覆盖。

导出路由常量在 `src/client/api.ts` 内联复制（`/api/session-sync/export`、`/api/session-sync/operation/`）：跨包导入 session-sync-web 的常量会把 node 侧声明拖进每个 client bundle，六个字符串不值得。

</details>

## 模型体验

无；本包是浏览器端 UI 插件，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包不组装也不发送提供方请求。
