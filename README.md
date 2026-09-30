# agent-drop

DeepSeek Harness 的**会话同步插件**：通过一个由外部云盘客户端复制的本机目录，在设备之间手动迁移逻辑 Session 树（含附件）。阶段 1 的入口是独立 Web 页面，与同步服务共享同一把互斥锁。

设计文档：[阶段 1](docs/design/session-sync-phase-1.md) · [阶段 1.5](docs/design/session-sync-phase-1.5.md) · [阶段 2](docs/design/session-sync-phase-2.md) · [总览](docs/design/session-sync.md)
实现说明：[docs/session-sync.md](docs/session-sync.md)

## 交付内容

| 目录 | 内容 |
|---|---|
| [`packages/session-sync-format`](packages/session-sync-format) | 同步包格式库：树清单、事件对象、附件条目、portable `cwd` |
| [`packages/session-sync`](packages/session-sync) | `ctx.sessionSync` 服务：导出、导入、扫描、操作状态、backend seam |
| [`packages/session-sync-dir`](packages/session-sync-dir) | 阶段 1 唯一的 `dir` 后端：暂存发布、读回校验、路径包含校验 |
| [`packages/session-sync-web`](packages/session-sync-web) | `/session-sync` 独立页面与同源 API |
| [`packages/session-sync-client`](packages/session-sync-client) | 会话菜单"导出会话" action、键盘命令与结果 toast（浏览器端插件） |
| [`docs/session-sync.md`](docs/session-sync.md) | 实现说明：介质格式、流水线顺序、状态表、验收对照 |

## 依据的 Harness 版本

实现与测试核验所依据的 `deepseek-harness` commit：`21638c56315ae6a2b552d6091945d3144c9af32e`（2026-09-27，`master`）。该 checkout 中的类型、装配方式与生命周期是本实现的权威依据。

## 依赖的 Harness checkout

这些插件按包名导入 Harness 的 `@deepseek-ai/dsh-*` 服务、类型与工具。`tsconfig.base.json`（由 `scripts/gen-tsconfig-paths.mjs` 生成）把每个包名指向同级 checkout 的**已构建声明**，`vitest.config.ts` 把同一个包名指向其运行时入口。默认路径为 `../deepseek-harness`，可用环境变量覆盖：

```bash
DSH_HARNESS_ROOT=/path/to/deepseek-harness pnpm run typecheck
```

Harness checkout 需要已构建（`pnpm run build`，或至少 `tsc -b tsconfig.host.json`），否则 `lib/types` 与 `lib/index.js` 不存在。

## 对 Harness 源码零修改

本仓库不修改 `deepseek-harness` 源码、不附带补丁、不依赖未来 Harness 新增能力。图片恢复走 `packages/session-sync/src/restore-image.ts`：仅当挂载的 store 是 `attachment-local`（公开导出 `commitPreparedImageFile`，`root` 为公共只读字段）时，按原引用发布精确字节；store 不具备本地恢复能力时**静默放弃附件同步**——会话事件照常导入，附件对象不落地，重新导入即可补齐。

## 开发

```bash
./node_modules/.bin/vitest run        # 全部测试（84 个）
node_modules/.bin/tsc --noEmit -p tsconfig.json                      # 类型检查
node_modules/.bin/tsc -b packages/session-sync-web/tsconfig.build.json \
  packages/session-sync-dir/tsconfig.build.json \
  packages/session-sync-client/tsconfig.build.json                   # 构建全部包（按引用顺序）
```

| 测试文件 | 覆盖 |
|---|---|
| `packages/session-sync-format/tests/format.spec.ts` | 清单与事件对象的往返、格式版本与谱系拒绝、portable `cwd` 编解码与平台组件规则、摘要校验 |
| `packages/session-sync/tests/engine.spec.ts` | 端到端：A 导出（含 fork 子会话与附件）→ B 导入 → 重复导入 → A 续写 → 本地领先不回退 |
| `packages/session-sync/tests/import-cases.spec.ts` | `pending` 到齐后成功、摘要错误整树拒绝、portable `cwd` 越界整树 `skipped`、格式版本拒绝、分叉 `conflict`、live 会话 `failed`、提交方取消使操作失败并释放互斥锁、扫描就绪/未就绪 |
| `packages/session-sync-dir/tests/dir-backend.spec.ts` | 根规范化与受保护重叠拒绝、解析即准备完整布局（含 `tmp`）、暂存发布与读回、同路径替换、摘要不符拒绝、缺失对象类型化错误、越界与符号链接桶拒绝 |
| `packages/session-sync-web/tests/web.spec.ts` | 页面 GET/HEAD/405、配置读写与失败不冒充生效、CSRF 媒体类型、JSON 校验、会话列表、导出/导入/扫描 202、忙碌 409、操作查询 404、页面不内嵌 Host 数据、页面与路由方法一致 |
| `packages/session-sync-client/tests/api.spec.ts` | 导出提交/轮询客户端：202→running→exported、忙碌 409、failed 操作、树级 skipped/failed、传输失败 |
| `packages/session-sync/tests/engine.spec.ts`（第二个用例） | 以子会话 id 请求导出：解析谱系根、发布整棵树、B 端完整导入 |

工具链（`typescript`、`vitest`）通过 `node_modules` 软链复用 Harness checkout 已安装的版本，因此无需在本仓库再安装依赖；需要独立安装时执行 `pnpm install` 即可。

## 装入 dsh

1. 让 Harness 能解析这些包名：在使用的 profile 里以 `file:` 方式加入本仓库的包，或把它们加入 `packages/bundle/base/package.json` 的依赖后 `pnpm install`。
2. 在 profile 的 `cordis.patch.yml` 中挂载插件：

```yaml
- id: session-sync
  name: '@deepseek-ai/dsh-session-sync'

- id: session-sync-dir
  name: '@deepseek-ai/dsh-session-sync-dir'

# Web 页面需要 host 的 webserver 与 connection 服务
- id: session-sync-web
  name: '@deepseek-ai/dsh-session-sync-web'

# 浏览器端：会话菜单"导出会话"与键盘命令（需先按包 README 建立工作区链接并 tsdown 打包）
- id: session-sync-client
  name: '@deepseek-ai/dsh-session-sync-client'
```

3. 配置 `root`：指向两台设备上都由同一个云盘客户端同步的本机目录。在页面 `http://127.0.0.1:<port>/session-sync` 上经 dsh Settings 保存（`root` 是 volatile 字段，保存后立即生效）。
4. 设备 A 在页面上选择根会话导出（或在任意会话的 "..." 菜单用"导出会话"，子会话 id 会被解析到谱系根），等云盘同步完成后在设备 B 的页面上导入。

阶段 1 不会自动导入导出，也不提供直连授权入口；同步包只包含逻辑事件与附件，不含项目文件，导入不会恢复运行现场。
