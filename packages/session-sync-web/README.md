---
description: "Standalone session-sync Web UI served by the host: root-session list, export, scan, import, operation status, and root configuration"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-sync-web

English | [中文](README.zh.md)

## Summary

`dsh-session-sync-web` serves the standalone session-sync page at `/session-sync` and mounts its same-origin API on the authenticated connection channel. The page lists candidate root sessions (including archived ones, labeled), submits exports, scans the sync directory, imports arrived trees, polls operation status, and edits the sync root through dsh Settings. It needs no Harness Web UI page, no chat context, and no client bundle: the page is one self-contained HTML document whose scripts poll the same-origin API.

## Table of Contents

- [Use this package](#use-this-package)
- [Routes and access](#routes-and-access)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Mount the package beside the web server, connection, sync service, and settings; the shipped web bundle composes them.

```yaml
- id: session-sync-web
  name: '@deepseek-ai/dsh-session-sync-web'
```

Open `/session-sync` on the serving host's loopback URL.

## Routes and access

| Route | Method | Behavior |
|---|---|---|
| `/session-sync` | GET, HEAD | The self-contained page; no data renders on the host |
| `/api/session-sync/config` | GET | Configured root, its validity, and the composed backend |
| `/api/session-sync/config` | POST | Validates and saves the root through dsh Settings; returns the effective value, never claiming a failed save |
| `/api/session-sync/sessions` | GET | Candidate root sessions, newest first, with live, persisted, and archived state |
| `/api/session-sync/export` | POST | Submits one export by `sessionId`; answers 202 with the operation id |
| `/api/session-sync/import` | POST | Submits one import; answers 202 with the operation id |
| `/api/session-sync/scan` | POST | Submits one scan; answers 202 with the operation id |
| `/api/session-sync/operations` | GET | Every operation record in acceptance order |
| `/api/session-sync/operation/<id>` | GET | One operation record, or 404 |

Every API route rides the connection service's trust fence — Host/Origin checks plus browser authentication — so an unauthenticated request is refused before any route body runs. A write whose media type is not `application/json` is refused: a cross-site form post cannot carry that content type without a CORS preflight, and no CORS is offered. The browser names only a session id and the configured root; it cannot point the host at an arbitrary file.

-----

No runtime invariant companion is published because the page keeps no host state: every route projects the sync service, and the API is covered by behavior tests.

## Further Exploration

- [Session synchronization subsystem](../../docs/session-sync.md) — the service the page drives.
- [HTTP server subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md) — the carrier that serves the page.

-----

## Model Experience

None, as the package registers no tool, prompt section, or session event: the page and its API serve the operator's browser only.

#### KV Cache effect

None; no model request carries page state.



## Known Limitations and Deferred Work

- **No live refresh** — the page polls; a session list that changed after the last poll is stale until the next refresh.
- **Operations are not durable** — records stay process-local; after a host restart the page re-scans the medium and shows no replayed operations.
- **Unauthenticated callers see only refusals** — the page itself loads without authentication; every API call answers 401 until the operator signs in through the host's own flow.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
