/** Declared-field attachment collection from one session's events. @module @deepseek-ai/dsh-session-sync-format/attachments */

import { assistantStreamChunks } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  FileAttachmentRef,
  ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment/types'
import type { SyncAttachmentEntry } from './types.ts'
import { requireAttachmentDigest, requireDigestPath } from './digest.ts'

/** One content block carrying a durable attachment reference. */
interface AttachmentBlock {
  readonly type?: unknown
  readonly attachment?: unknown
}

/**
 * Read one content array's image and file blocks. Values that are not the
 * declared block shapes stay untouched; unknown content cannot authorize an
 * attachment read.
 * @param content - candidate content array from a declared field.
 * @param images - image dedupe map keyed by attachment id.
 * @param files - file dedupe map keyed by attachment id and stored name.
 */
function readBlocks(
  content: unknown,
  images: Map<string, ImageAttachmentRef>,
  files: Map<string, FileAttachmentRef>,
): void {
  if (!Array.isArray(content)) return
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as AttachmentBlock
    if (typeof block.attachment !== 'object' || block.attachment === null) continue
    if (block.type === 'image') images.set(imageKey(block.attachment as ImageAttachmentRef), block.attachment as ImageAttachmentRef)
    if (block.type === 'file') files.set(fileKey(block.attachment as FileAttachmentRef), block.attachment as FileAttachmentRef)
  }
}

/** Dedupe key of one image reference: the content-addressed object. */
function imageKey(ref: ImageAttachmentRef): string {
  return String(ref.attachmentId)
}

/** Dedupe key of one file reference: the content-addressed object plus its stored name. */
function fileKey(ref: FileAttachmentRef): string {
  return `${String(ref.attachmentId)}\u0000${ref.name}`
}

/**
 * One declared event payload's attachment-bearing fields. First-party events
 * can be present without their producer plugin mounted, so the walk reads only
 * declared fields and leaves every unknown payload opaque.
 */
interface DeclaredPayload {
  readonly content?: unknown
  readonly message?: { readonly content?: unknown }
  readonly inserted?: unknown
  readonly summary?: unknown
  readonly rawOutput?: unknown
  readonly stream?: readonly { readonly type?: unknown; readonly chunk?: { readonly type?: unknown; readonly block?: unknown } }[]
}

/**
 * Collect the distinct attachment references one event names, reading only the
 * declared first-party content fields and completed assistant stream blocks.
 * @param event - one adopted session event.
 * @param images - image dedupe map keyed by attachment id.
 * @param files - file dedupe map keyed by attachment id and stored name.
 */
export function collectEventAttachmentRefs(
  event: SessionEvent,
  images: Map<string, ImageAttachmentRef>,
  files: Map<string, FileAttachmentRef>,
): void {
  const payload = event.data as DeclaredPayload
  const type: string = event.type
  switch (type) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      readBlocks(payload.content, images, files)
      return
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued':
      readBlocks(payload.message?.content, images, files)
      return
    case 'agent/inbox/spliced': {
      const inserted = payload.inserted
      if (!Array.isArray(inserted)) return
      for (const message of inserted) {
        if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
        readBlocks((message as DeclaredPayload).content, images, files)
      }
      return
    }
    case 'compaction/summary':
      readBlocks(payload.summary, images, files)
      readBlocks(payload.rawOutput, images, files)
      return
    case 'assistant/message':
      readBlocks(payload.message?.content, images, files)
      break
    case 'assistant/attempt':
      break
    default:
      // SessionEventMap is merge-extensible; a plugin-owned event declares its
      // own attachment fields and no other package reads them.
      return
  }
  for (const chunk of assistantStreamChunks(event as never, 'block-end')) {
    readBlocks([chunk.block], images, files)
  }
}

/**
 * Collect the distinct attachment references one session's complete log names.
 * @param events - the session's validated events in seq order.
 * @returns image and file dedupe maps in first-reference order.
 */
export function collectAttachments(events: readonly SessionEvent[]): {
  readonly images: readonly ImageAttachmentRef[]
  readonly files: readonly FileAttachmentRef[]
} {
  const images = new Map<string, ImageAttachmentRef>()
  const files = new Map<string, FileAttachmentRef>()
  for (const event of events) collectEventAttachmentRefs(event, images, files)
  return { images: [...images.values()], files: [...files.values()] }
}

/**
 * Build the manifest attachment entries for one session's collected
 * references, paired with the digest each object's bytes hash to.
 * @param images - collected image references in first-reference order.
 * @param files - collected file references in first-reference order.
 * @param objectDigestOf - digest of one attachment's stored bytes, looked up per reference.
 * @returns the manifest entries in the same order.
 * @throws {SyncFormatError} when a reference or digest is not a valid content identifier.
 */
export function attachmentEntries(
  images: readonly ImageAttachmentRef[],
  files: readonly FileAttachmentRef[],
  objectDigestOf: (ref: ImageAttachmentRef | FileAttachmentRef) => string,
): SyncAttachmentEntry[] {
  const entries: SyncAttachmentEntry[] = []
  for (const ref of images) {
    entries.push({ kind: 'image', ref, object: requireDigestPath(objectDigestOf(ref), 'image object digest') })
  }
  for (const ref of files) {
    entries.push({ kind: 'file', ref, object: requireDigestPath(objectDigestOf(ref), 'file object digest') })
  }
  return entries
}

/**
 * Validate one manifest attachment entry's reference digest: the image
 * identifier names the normalized bytes and the file identifier names the
 * verbatim bytes.
 * @param entry - one manifest attachment entry.
 * @returns the digest the entry's object must match.
 */
export function attachmentObjectDigest(entry: SyncAttachmentEntry): string {
  return requireAttachmentDigest(entry.ref.attachmentId, `${entry.kind} attachment id`)
}
