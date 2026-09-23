# clouds/ — session-sync 各 `cloud` 后端的设计文档索引

> 状态：**设计稿，未实现**；现阶段仅覆盖 WebDAV。本页只做目录索引与文档分工，不收录实现细节。
> 主文档（`session-sync.md`）只引用本页与 [WebDAV.md](./WebDAV.md)，不复制这里的内容。

## 1. 目录结构（现状 + 实现落位建议）

```text
clouds/
  index.md               # 本页：目录索引与文档分工
  WebDAV.md              # WebDAV（remote-move profile）适配设计稿：SyncProvider 逐方法映射、
                         #   SyncRootFs 组合、提交协议（提交前探针）、错误映射、陷阱、
                         #   凭据配置、测试计划、契约声明与实现前缺口
  src/                   # 代码落位（随阶段 2 创建，本目录当前不含代码）
    syncroot.ts          # SyncRootFs / SyncRootClause / REQUIRED_CLAUSES（附录 B.1/B.3）
    errors.ts            # 后端层子集的 SYNC_* 错误码（附录 H.3）
    index.ts             # 工厂 + 阶段门控 + 契约自检
    dir/index.ts         # 后端 dir（附录 B.2）
    webdav/
      index.ts           # WebDavSyncRoot（WebDAV.md 的实现对象）
      client.ts          # 标准 DAV 请求层（DAV_API.md 第 1–2 节逐条对应）
  test/                  # 契约测试落位（附录 I；替身行为规格见 WebDAV.md §10）
    fake-dav-server.ts
    contract.test.ts
```

## 2. 文档分工

| 文档 | 职责 | 依据 |
|---|---|---|
| `session-sync.md` 附录 B / F / G / I | 目录契约、后端选型、profile 语义、测试清单 | 主文档 |
| 本页 | 目录索引、后端一览、与主文档的引用关系 | — |
| [WebDAV.md](./WebDAV.md) | WebDAV 适配的完整设计稿：`SyncProvider`（附录 F.7）↔ `DAV_API.md` 逐方法映射 + 上层组合 | 附录 G |
| [`DAV_API.md`](../DAV_API.md) | 厂商 HTTP API 文档（单一服务，坚果云标准 DAV 面） | 被 WebDAV.md 引用 |

## 3. 后端一览

| 后端 | 设计文档 | profile（附录 G.8） | 阶段 |
|---|---|---|---|
| `dir` | `session-sync.md` 附录 B.2 / B.3（本地文件系统语义直读，无需单独文档） | `local-index` + `full-scan` + 无凭据 | 1（唯一生产后端） |
| `cloud`（webdav） | [WebDAV.md](./WebDAV.md) | `remote-move` + `full-scan` + `basic-asp` | 2；实现落地并通过契约测试前由配置校验拒绝 |

## 4. 引用关系

- `session-sync.md` 附录 B（伞句与 B.1.1 索引）→ 本目录；
- `session-sync.md` 附录 G → [WebDAV.md](./WebDAV.md)（不再直接引用 `DAV_API.md`）；
- `DAV_API.md` 顶部注记声明其消费方为 [WebDAV.md](./WebDAV.md)。

## 5. 本目录相对主文档的增量约定

设计稿对主文档附录 G.5 草案有一处强化，详见 [WebDAV.md §5](./WebDAV.md)：

- **提交前探针**：`rename` 在发起 `MOVE` 之前先 `GET` 最终名——目标已存在且内容一致则幂等跳过，
  内容不同则 `SYNC_REMOTE_CONFLICT`（双方保留）。即使服务端对 `MOVE` 静默覆盖（RFC 4918 默认
  `Overwrite: T`），覆盖行为也触不到已提交对象；
- 超限错误统一为 `SYNC_UPLOAD_TOO_LARGE`（主文 T6 的落地选择，`WebDAV.md` §6）。

实现前必须补齐的缺口（journal 持久化、大附件分块、全树扫描成本、真实服务验证）见 [WebDAV.md §12](./WebDAV.md)。
