---
description: "Content-addressed session-sync package format: tree manifests, event and attachment objects, portable cwd encoding"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-sync-format

English | [中文](README.zh.md)

## Summary

`dsh-session-sync-format` defines the vocabulary one cloud-replicated sync directory carries: one tree manifest per root-session revision, one event object per session, one attachment object per attachment, and the portable home-relative encoding of a session's working directory. Every artifact is named by the SHA-256 of its own bytes and every read verifies the name against the content, so a manifest's references resolve only when the medium actually holds the data. The package is a pure library: it mounts no service, registers no tool, and reads no storage.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Import the encoding and validation helpers when implementing a sync backend or reading a package outside the shipped pipelines.

### The medium layout

One configured root holds one package tree, `dsh-session-sync/`: `objects/events/<sha256>.jsonl` (one canonical logical event per line, seq contiguous from 0), `objects/attachments/<sha256>` (exact stored bytes), and `trees/<rootSessionId>/<treeRevisionHash>.json`. `treeRevisionHash` is the SHA-256 of the manifest's own canonical bytes. A later publish may replace an existing path even when its content differs; the format keeps no replaced bytes.

### Tree manifests

`SYNC_FORMAT_VERSION` names the current sync-package format. A manifest stamped with another version is refused without guessing at compatibility. The manifest carries the root session and every descendant in dependency order with their portable headers, inherited event counts, event object references, and attachment entries; structural validation covers field types, identity, lineage closure, parent-before-child order, and every reference's digest shape. The objects themselves are read and digest-checked by the caller.

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

### Portable working directories

`encodePortableCwd(cwd)` resolves the current user's actual home and the absolute `cwd` through `realpath`, computes the relative components, and returns `undefined` unless the result re-enters the component invariants: no empty component, no `.` or `..`, no separator, no control character, at most 255 UTF-8 bytes per component, and on Windows no reserved device name, forbidden character, or trailing dot or space. `resolvePortableCwd` joins validated components onto the resolved home. The portable encoding is the sync header's only `cwd` representation.

### Attachment references

Attachment entries carry the original reference verbatim beside the object digest, so a restored image resolves the exact recorded `ImageAttachmentRef` and a restored file carries its recorded `FileAttachmentRef`. The declared-field walk (`collectAttachments`) reads only first-party event content fields and completed assistant stream blocks; unknown event payloads stay opaque and authorize no read.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`digest.ts` hashes bytes and text and validates digest-shaped path references; `portable-cwd.ts` encodes, decodes, and prechecks portable cwds against injectable platform rules; `manifest.ts` canonicalizes, encodes, decodes, and structurally validates manifests; `events.ts` encodes and structurally decodes event objects; `attachments.ts` collects references from declared fields and builds manifest entries. Envelope validation adopts events in place; full replay validation against a session's history is the caller's job. No runtime invariant companion is published because the package owns no mutable state: every operation is a pure function of its inputs, and behavior tests own the round trips.

</details>

-----

## Further Exploration

- [Session synchronization subsystem](../../docs/session-sync.md) — the service contract that consumes this format.
- [Session persistence subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md) — the durability seam whose logical events the objects carry.

-----

## Model Experience

None, as the package registers no model-facing surface: it encodes and validates sync-package artifacts for host-side consumers only.

#### KV Cache effect

None; the package contributes nothing to any model request.

## Known Limitations and Deferred Work

- **One format version, refused loudly** — a manifest from a different sync-package version or session logical format is refused, not migrated; a successor format needs a new version and a documented migration.
- **Replaced bytes stay replaced** — the overwrite rule means a later publish at one digest path can leave an older manifest pointing at different bytes; the format cannot recover them.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
