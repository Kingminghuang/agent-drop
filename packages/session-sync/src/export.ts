/** Export pipeline: publish one root session's lineage as a sync package. @module @deepseek-ai/dsh-session-sync/export */

import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  collectAttachments,
  encodeEventObject,
  encodePortableCwd,
  encodeTreeManifest,
  sha256Hex,
  type PortableCwd,
  type SyncAttachmentEntry,
  type SyncSessionEntry,
} from '@deepseek-ai/dsh-session-sync-format'
import type { SessionSyncBackend, SessionSyncRoot } from './backend.ts'
import { readStoredSnapshot, snapshotUpperBound, signalOptions } from './observe.ts'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SyncSessionResult, SyncTreeResult } from './types.ts'

/** The host members the export pipeline reads. */
export interface ExportDeps {
  /** Live-session store; flushes live history before its snapshot is read. */
  readonly sessions: SessionStore | undefined
  /** Mounted persistence backend. */
  readonly sessionPersistence: SessionPersistence
  /** Composed session-query engine; traces the lineage. */
  readonly sessionQuery: SessionQueryEngine
  /** Mounted attachment store. */
  readonly attachments: AttachmentStore | undefined
  /** Prepared storage backend. */
  readonly backend: SessionSyncBackend
  /** Prepared sync root. */
  readonly root: SessionSyncRoot
}

/** One session's fixed export snapshot with its portable cwd. */
export interface ExportSnapshot {
  /** Session identity. */
  readonly id: SessionId
  /** Stored header. */
  readonly header: SessionHeader
  /** Exact inherited cut. */
  readonly inheritedEventCount: number
  /** Validated events in seq order. */
  readonly events: readonly SessionEvent[]
  /** Portable cwd; absent when the session recorded none. */
  readonly cwd: PortableCwd | undefined
  /** Encoded event object's bytes. */
  readonly eventBytes: Uint8Array
  /** Digest of {@link eventBytes}, the manifest's event object reference. */
  readonly eventObject: string
  /** Manifest attachment entries in first-reference order. */
  readonly attachments: readonly SyncAttachmentEntry[]
}

/**
 * Flatten one lineage trace into export order: the traced target first, then
 * every descendant depth-first. Repeated ids collapse.
 * @param trace - the traced lineage.
 * @returns session ids in export order.
 */
export function flattenLineage(
  trace: { readonly target: { readonly header: SessionHeader }; readonly descendants: readonly SessionLineageNodeLike[] },
): readonly SessionId[] {
  const ids: SessionId[] = []
  const seen = new Set<string>()
  ids.push(trace.target.header.id)
  seen.add(String(trace.target.header.id))
  const walk = (nodes: readonly SessionLineageNodeLike[]): void => {
    for (const node of nodes) {
      const id = node.session.header.id
      if (seen.has(String(id))) continue
      seen.add(String(id))
      ids.push(id)
      walk(node.descendants)
    }
  }
  walk(trace.descendants)
  return ids
}

/** One recursive descendant node. */
interface SessionLineageNodeLike {
  readonly session: { readonly header: SessionHeader }
  readonly descendants: readonly SessionLineageNodeLike[]
}

/**
 * Snapshot every session of one tree: flush each live session, pin its upper
 * bound, read the stored snapshot, encode the portable cwd, and encode the
 * event object. The first `cwd` that cannot be encoded portably stops the tree.
 * @param deps - export dependencies.
 * @param ids - sessions in export order.
 * @param signal - optional cancellation.
 * @returns one snapshot per session.
 * @throws {Error} when a stored log refuses validation or a cwd is not home-relative.
 */
export async function snapshotTree(
  deps: ExportDeps,
  ids: readonly SessionId[],
  signal?: AbortSignal,
): Promise<readonly ExportSnapshot[]> {
  const snapshots: ExportSnapshot[] = []
  for (const id of ids) {
    signal?.throwIfAborted()
    const bound = await snapshotUpperBound(deps.sessions, deps.sessionPersistence, id, signal)
    const stored = await readStoredSnapshot(deps.sessionPersistence, id, bound, signal)
    const cwd = stored.header.cwd === undefined
      ? undefined
      : await encodePortableCwd(stored.header.cwd)
    if (stored.header.cwd !== undefined && cwd === undefined) {
      throw new Error(`session '${String(id)}' has a working directory that cannot be encoded portably`)
    }
    const encoded = encodeEventObject(stored.events)
    snapshots.push({
      id,
      header: stored.header,
      inheritedEventCount: stored.inheritedEventCount,
      events: stored.events,
      cwd,
      eventBytes: encoded.bytes,
      eventObject: encoded.object,
      attachments: deps.attachments === undefined
        ? (assertNoReferencedAttachments(id, stored.events), [])
        : await attachmentEntriesFor(deps.attachments, stored.events, signal),
    })
  }
  return snapshots
}

/**
 * Refuse one session that references attachments while no attachment store is
 * composed.
 * @param id - the session identity, for the diagnostic.
 * @param events - the session's validated events.
 * @returns nothing after the session proves attachment-free.
 * @throws {Error} when attachments are referenced without a composed store.
 */
function assertNoReferencedAttachments(
  id: SessionId,
  events: readonly SessionEvent[],
): void {
  const refs = collectAttachments(events)
  if (refs.images.length > 0 || refs.files.length > 0) {
    throw new Error(`session '${String(id)}' references attachments but no attachment store is composed`)
  }
}

/**
 * Read one session's referenced attachments through the attachment store and
 * build their manifest entries. Each image and file is read once; a missing or
 * corrupt object fails the pass.
 * @param attachments - the mounted attachment store.
 * @param events - the session's validated events.
 * @param signal - optional cancellation.
 * @returns the manifest entries in first-reference order.
 */
export async function attachmentEntriesFor(
  attachments: AttachmentStore,
  events: readonly SessionEvent[],
  signal?: AbortSignal,
): Promise<readonly SyncAttachmentEntry[]> {
  const refs = collectAttachments(events)
  const entries: SyncAttachmentEntry[] = []
  for (const ref of refs.images) {
    entries.push({ kind: 'image', ref, object: await digestAttachment(attachments, ref, signal) })
  }
  for (const ref of refs.files) {
    entries.push({ kind: 'file', ref, object: await digestAttachment(attachments, ref, signal) })
  }
  return entries
}

/** Read one attachment's stored bytes and return their SHA-256 hex digest. */
async function digestAttachment(
  attachments: AttachmentStore,
  ref: ImageAttachmentRef | FileAttachmentRef,
  signal?: AbortSignal,
): Promise<string> {
  return sha256Hex(await readAttachmentBytes(attachments, ref, signal))
}

/**
 * Read one attachment's stored bytes: images are read whole, files stream in
 * bounded chunks and join.
 * @param attachments - the mounted attachment store.
 * @param ref - the reference to read.
 * @param signal - optional cancellation.
 * @returns the verified stored bytes.
 */
export async function readAttachmentBytes(
  attachments: AttachmentStore,
  ref: ImageAttachmentRef | FileAttachmentRef,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (isImageRef(ref)) return (await attachments.readImage(ref, signal)).data
  const chunks: Uint8Array[] = []
  for await (const chunk of attachments.readFileStream(ref, signal)) chunks.push(chunk)
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

/** Whether one reference is an image reference: only image references carry a media type. */
function isImageRef(ref: ImageAttachmentRef | FileAttachmentRef): ref is ImageAttachmentRef {
  return (ref as { mediaType?: unknown }).mediaType !== undefined
}

/**
 * Run one export pass over one root session's lineage: trace the lineage,
 * snapshot the tree (an unportable cwd skips it), publish every content-addressed
 * object, then publish the tree manifest last.
 *
 * The requested id may name any session of a tree (a caller such as the
 * session menu exports the selected row, not the tree's top). A complete
 * lineage trace resolves the top of the ancestor chain, and the export always
 * publishes from that root, so a mid-tree selection never silently publishes
 * a partial subtree.
 * @param deps - export dependencies.
 * @param rootSessionId - a session of the tree to export; resolved to the lineage root.
 * @param signal - optional cancellation.
 * @returns the tree's result, reported under the resolved root.
 */
export async function runExport(
  deps: ExportDeps,
  rootSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SyncTreeResult> {
  signal?.throwIfAborted()
  const trace = await deps.sessionQuery.traceSession(rootSessionId, signal)
  if (!trace.complete) {
    return {
      rootSessionId: String(rootSessionId),
      status: 'failed',
      reason: `the lineage of '${String(rootSessionId)}' is incomplete; refusing to export`,
      sessions: [],
    }
  }
  const resolvedRootId = trace.root.header.id
  const tree = resolvedRootId === rootSessionId
    ? trace
    : await deps.sessionQuery.traceSession(resolvedRootId, signal)
  if (!tree.complete) {
    return {
      rootSessionId: String(resolvedRootId),
      status: 'failed',
      reason: `the lineage of '${String(resolvedRootId)}' became incomplete mid-export; refusing to export`,
      sessions: [],
    }
  }
  let snapshots: readonly ExportSnapshot[]
  try {
    snapshots = await snapshotTree(deps, flattenLineage(tree), signal)
  } catch (error: unknown) {
    return {
      rootSessionId: String(resolvedRootId),
      status: 'skipped',
      reason: renderThrown(error),
      sessions: [],
    }
  }
  const sessions: SyncSessionResult[] = []
  const objects = new Map<string, { readonly kind: 'events' | 'attachments'; readonly bytes: Uint8Array }>()
  const entries: SyncSessionEntry[] = []
  try {
    for (const snapshot of snapshots) {
      signal?.throwIfAborted()
      for (const attachment of snapshot.attachments) {
        if (objects.has(attachment.object)) continue
        objects.set(attachment.object, {
          kind: 'attachments',
          bytes: await readAttachmentBytes(deps.attachments as AttachmentStore, attachment.ref, signal),
        })
      }
      entries.push({
        sessionId: String(snapshot.id),
        header: syncHeaderOf(snapshot.header, snapshot.cwd),
        inheritedEventCount: snapshot.inheritedEventCount,
        events: { count: snapshot.events.length, object: snapshot.eventObject },
        ...(snapshot.attachments.length === 0 ? {} : { attachments: snapshot.attachments }),
      })
      sessions.push({ sessionId: String(snapshot.id), status: 'exported', remoteEvents: snapshot.events.length })
      if (objects.has(snapshot.eventObject)) continue
      objects.set(snapshot.eventObject, { kind: 'events', bytes: snapshot.eventBytes })
    }
    const { bytes, revisionHash } = encodeTreeManifest({
      type: 'dsh-session-tree',
      formatVersion: 1,
      rootSessionId: String(resolvedRootId),
      sessions: entries,
    })
    for (const [digest, object] of objects) {
      signal?.throwIfAborted()
      await deps.backend.publishObject(deps.root, object.kind, digest, object.bytes, signalOptions(signal))
    }
    signal?.throwIfAborted()
    await deps.backend.publishTree(deps.root, String(resolvedRootId), revisionHash, bytes, signalOptions(signal))
    return { rootSessionId: String(resolvedRootId), status: 'exported', sessions }
  } catch (error: unknown) {
    return {
      rootSessionId: String(resolvedRootId),
      status: 'failed',
      reason: renderThrown(error),
      sessions,
      completedSteps: [...objects.keys()].map(digest => `published object ${digest}`),
    }
  }
}

/** Project one local header into the sync header shape. */
function syncHeaderOf(header: SessionHeader, cwd: PortableCwd | undefined): SyncSessionEntry['header'] {
  return {
    createdAt: header.createdAt,
    ...(cwd === undefined ? {} : { cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) }),
    isSeeded: header.isSeeded,
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

/** Render one arbitrary thrown value without trusting its string coercion. */
function renderThrown(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

export type { Session }
