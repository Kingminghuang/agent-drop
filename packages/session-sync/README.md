---
description: "Cross-device session synchronization service (ctx.sessionSync): export, import, scan, and operation state over a registered sync backend"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-sync

English | [中文](README.zh.md)

## Summary

`dsh-session-sync` owns `ctx.sessionSync`: the cross-device synchronization service. One operation selects one root session, traces its complete lineage, flushes live history, pins snapshot upper bounds, reads headers, events, and attachments through the authoritative seams, and publishes a content-addressed sync package. Import verifies every manifest and object, resolves portable working directories, prepares directories and workspaces, restores attachments, and compares each session against local history before writing: create, append a suffix, skip, or report a conflict with both versions kept. Operations serialize on one mutex and keep their accepted root.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Mount the service beside session persistence, session query, and the session store, then mount one backend provider (the shipped composition mounts [`dsh-session-sync-dir`](../session-sync-dir/README.md)). The standalone page is the shipped entry point; host code can drive the service directly.

```yaml
- id: session-sync
  name: '@deepseek-ai/dsh-session-sync'

- id: session-sync-dir
  name: '@deepseek-ai/dsh-session-sync-dir'
```

### What one operation does

`exportTree(rootSessionId)` refuses an incomplete lineage, flushes each live session before pinning its snapshot upper bound, reads every header and event through the persistence handles, reads every referenced attachment through the attachment store, publishes the content-addressed objects, and publishes the tree manifest last. An unportable working directory skips the whole tree before anything is published.

`importAll()` scans the medium, reads every visible manifest, verifies every referenced object before any local write, and reports per-session outcomes: a session whose objects have not all arrived is `pending`; a present object failing its digest fails the whole tree. The pipeline prechecks every portable cwd against the target platform, resolves each one to a directory below the importing user's home, creates missing directories safely, registers or reuses the workspace record, restores every referenced attachment, then compares and writes each session: absent sessions are created with the resolved header and inherited cut; a local prefix is extended with the remote suffix; a local history that leads or matches is skipped; a header identity mismatch or an event divergence is a `conflict` with both versions kept. Every write reconfirms the local history through the write handle itself, so a retry continues an interrupted session without repeating events, and a live session is compared without taking its write handle.

`scan()` reads every visible manifest and verifies every referenced object, reporting readiness without writing anything.

### Operation state

Every submission returns a reference: the operation id and a promise settling with the per-tree per-session results, or the failure. Records stay process-local — after a host restart nothing is replayed and the page re-scans the medium. A submission arriving while an operation is accepted or running is refused with a readable "already running" result.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `root` | unset | Fully qualified local sync directory the external cloud client replicates. Unset refuses every submission. Declared volatile, so the shipped Web UI edits it through dsh Settings and the value applies live. |

The configured root is validated before a submission is accepted: it must be a fully qualified directory path and must not overlap the harness home, its session store, or its attachment store. Symbolic links never carry a write outside the resolved root.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`backend.ts` declares the storage seam and the missing-object refusal; `paths.ts` normalizes configured roots and refuses protected overlaps; `observe.ts` flushes live sessions, pins bounds, and compares events structurally; `export.ts` snapshots and publishes one tree; `import.ts` validates, prepares, compares, and writes; `scan.ts` reports readiness; `operations.ts` keeps records and serializes submissions. The pipeline never opens a live session's write handle: `ctx.sessions.get(id)` decides busy before any open, and `SessionAlreadyOwnedError` from a later open is contained in that session's result. No runtime invariant companion is published because operation records are exposed through the status API and covered by behavior tests; there is no independently observable relationship a companion could compare.

</details>

-----

## Further Exploration

- [Session synchronization subsystem](../../docs/session-sync.md) — the medium layout and pipeline semantics.
- [Local-directory backend](../session-sync-dir/README.md) — the shipped storage provider.

-----

## Model Experience

None, as the service registers no tool, prompt section, or session event: synchronization runs entirely on the human-command and host-service plane.

#### KV Cache effect

None; no model request carries synchronization state.

## Known Limitations and Deferred Work

- **No automatic synchronization** — the service moves nothing on its own; a host or cloud client watching files is out of scope for this phase.
- **Conflicts are never merged** — a diverged session keeps both versions and reports the conflict; automatic reconciliation is deliberately absent.
- **Live sessions cannot receive imports** — a session whose agent is running reports a failure instead of taking its write handle; a retry after the agent stops completes the work.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
