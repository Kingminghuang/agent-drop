/** Unit coverage for the attachment image restore into the local store. @module dsh-session-sync/tests/restore-image.spec */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { describe, expect, test } from 'vitest'
import { sha256Hex } from '@deepseek-ai/dsh-session-sync-format'
import { localRestoreRoot, restoreImage } from '../src/restore-image.ts'

const keptRoots: string[] = []

afterEach(async () => {
  while (keptRoots.length > 0) await rm(keptRoots.pop() as string, { recursive: true, force: true })
})

/** One unique temp directory removed after the test. */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-sync-restore-'))
  keptRoots.push(root)
  return root
}

describe('restoreImage', () => {
  test('publishes exact bytes at the content-addressed path without re-encoding', async () => {
    // Mirror the real layout: root = <dshHome>/attachments/v1, so durability
    // bookkeeping only touches directories under the private dshHome.
    const dshHome = join(await tempRoot(), 'dsh')
    const root = join(dshHome, 'attachments', 'v1')
    const data = new Uint8Array([9, 8, 7, 6, 5, 4])
    const sha = sha256Hex(data)
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${sha}`),
      mediaType: 'image/png',
      bytes: data.byteLength,
      width: 2,
      height: 2,
    }
    await restoreImage(root, { ref, data })
    const stored = await readFile(join(root, 'objects', sha.slice(0, 2), sha))
    expect([...new Uint8Array(stored)]).toEqual([...data])
  })

  test('rejects bytes whose digest differs from the recorded reference', async () => {
    const dshHome = join(await tempRoot(), 'dsh')
    const root = join(dshHome, 'attachments', 'v1')
    const data = new Uint8Array([1, 1, 2, 3])
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: data.byteLength,
      width: 2,
      height: 2,
    }
    await expect(restoreImage(root, { ref, data })).rejects.toThrowError()
  })
})

describe('localRestoreRoot', () => {
  test('accepts a non-empty string root', () => {
    const root = join(tmpdir(), 'attachments', 'v1')
    expect(localRestoreRoot({ root } as unknown as AttachmentStore)).toBe(root)
  })

  test('yields undefined for providers without a usable root', () => {
    expect(localRestoreRoot(undefined)).toBeUndefined()
    expect(localRestoreRoot({} as AttachmentStore)).toBeUndefined()
    expect(localRestoreRoot({ root: '' } as unknown as AttachmentStore)).toBeUndefined()
    expect(localRestoreRoot({ root: 7 } as unknown as AttachmentStore)).toBeUndefined()
  })
})
