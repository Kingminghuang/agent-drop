/** Image restore into a content-addressed local attachment store. @module @deepseek-ai/dsh-session-sync/restore-image */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { commitPreparedImageFile } from '@deepseek-ai/dsh-attachment-local'
import { sha256Hex } from '@deepseek-ai/dsh-session-sync-format'

/** One normalized image restored across devices, beside the exact reference the exporting device's session log carries. */
export interface RestoreImageAttachment {
  /** The durable reference recorded by the exporting device's session log. */
  readonly ref: ImageAttachmentRef
  /** Exact normalized bytes whose digest is `ref.attachmentId`. */
  readonly data: Uint8Array
}

/** Structural shape of a content-addressed local store that publishes its versioned root. */
interface LocalRooted {
  readonly root?: unknown
}

/**
 * The local publication root of one store, when the store can restore
 * normalized images in place: only `attachment-local` publishes its
 * content-addressed root. Any other provider — or no store at all — yields
 * `undefined`, and the caller silently gives up attachment restore.
 * @param store - the mounted attachment store, or `undefined`.
 * @returns the absolute versioned storage root, or `undefined` when unusable.
 */
export function localRestoreRoot(store: AttachmentStore | undefined): string | undefined {
  const root = (store as LocalRooted | undefined)?.root
  return typeof root === 'string' && root !== '' ? root : undefined
}

/**
 * Publish one image with its recorded reference into the local store. A target
 * that already holds exactly the referenced bytes short-circuits the
 * publication, so repeated imports are idempotent without touching the
 * publisher's hard-link deduplication. Otherwise the publication verifies the
 * digest and byte count against the reference, then writes the exact bytes
 * immutably at the content-addressed path (staged write, fsync, hard link,
 * deduplication, read-only). The bytes are never re-encoded: a re-encoded
 * image would carry a different content id and no longer resolve the recorded
 * history.
 * @param root - the store's absolute versioned storage root.
 * @param input - the recorded reference beside its exact bytes.
 * @returns completion after the object is durably published.
 * @throws an error when the bytes do not match their reference.
 */
export async function restoreImage(root: string, input: RestoreImageAttachment): Promise<void> {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(String(input.ref.attachmentId))
  if (match?.[1] !== undefined) {
    const sha256 = match[1] as string
    const target = join(root, 'objects', sha256.slice(0, 2), sha256)
    try {
      if (sha256Hex(new Uint8Array(await readFile(target))) === sha256) return
    } catch {
      // Absent or unreadable target: fall through to a fresh publication.
    }
  }
  await commitPreparedImageFile(root, { data: input.data, ref: input.ref })
}
