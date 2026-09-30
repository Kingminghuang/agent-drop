---
description: "Local-directory sync backend for the DeepSeek Harness: content-addressed publish and verified read over one cloud-replicated folder"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-sync-dir

English | [中文](README.zh.md)

## Summary

`dsh-session-sync-dir` is the shipped `dir` storage backend for [`ctx.sessionSync`](../session-sync/README.md). It operates one directory on this machine that an external cloud client replicates across devices: publishes stage bytes in a private temp directory, fsync, commit at the digest-derived path, replace an existing target even when its content differs, and read every commit back to verify its digest. Reads verify the addressed bytes against the caller's digest and refuse an absent object with a typed missing error.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Mount the backend beside the sync service; the shipped base bundle composes both.

```yaml
- id: session-sync
  name: '@deepseek-ai/dsh-session-sync'

- id: session-sync-dir
  name: '@deepseek-ai/dsh-session-sync-dir'
```

The backend has no configuration of its own: the configured sync root belongs to the service, and the backend normalizes it into the package tree `dsh-session-sync/` beneath the resolved root. A root whose canonical spelling overlaps the harness home, its session store, or its attachment store refuses the backend's preparation.

### What one publish guarantees

Publishing stages the exact bytes in `dsh-session-sync/tmp` under an exclusive, owner-only temp name, fsyncs the file, commits at `objects/<family>/<sha256>` or `trees/<rootSessionId>/<revisionHash>.json`, and persists the committed entry's directory. An existing target is replaced even when its content differs — the documented overwrite rule for digest-named paths — and the committed bytes are read back and digest-verified before the publish resolves. An interrupted publish never resolves as success and never leaves a committed file that fails its readback.

### What one read verifies

`readObject` refuses an absent object with `SyncObjectMissingError` — the signal an import turns into a per-session `pending` — and verifies the bytes against the digest before returning them. `readTree` additionally refuses a manifest whose directory resolves outside the prepared root, so a manifest path can never carry a read beyond the medium.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`publish.ts` owns staging, durable publication, digest verification, and tree listing; `index.ts` adapts the seam's five verbs onto it and prepares the package layout beneath the configured root. Directory fsync runs where the platform exposes directory handles; Windows relies on NTFS metadata journaling. No runtime invariant companion is published because the backend owns no cached state: every read verifies the medium directly, and publish/read round trips are covered by behavior tests.

</details>

-----

## Further Exploration

- [Session synchronization subsystem](../../docs/session-sync.md) — the seam contract and medium layout.
- [Sync service](../session-sync/README.md) — the pipelines this backend carries.

-----

## Model Experience

None, as the backend registers no tool, prompt section, or session event: it moves bytes on the host filesystem for the sync service.

#### KV Cache effect

None; no model request carries backend state.

## Known Limitations and Deferred Work

- **One local directory, one device view** — the backend sees only what the cloud client has synced so far; a manifest whose objects are still in flight is pending, not failed.
- **No cross-process writer lock** — two Harness instances publishing into one root serialize on the medium itself; the overwrite rule keeps the last committed bytes, not a merge.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
