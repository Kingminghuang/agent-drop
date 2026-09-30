/** Real host composition used by the session-sync suites: storage, sessions, query, attachments, workspaces. @module dsh-session-sync/tests/support/composition */

import { mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
// The Loader-backed fixture emits `app-boot/config-reload`; this merge supplies it.
import type {} from '@deepseek-ai/dsh-app-boot'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
} from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveFileAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../../../deepseek-harness/packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { liveConfig } from '../../../../../deepseek-harness/packages/settings/settings/tests/live-config.ts'
import { SessionSyncService } from '../../../session-sync/src/index.ts'
import { DirSessionSyncBackend } from '../../../session-sync-dir/src/index.ts'

const keptRoots: string[] = []
/** Project directories created under the real home, removed after each test. */
const homeProjects: string[] = []

afterEach(async () => {
  while (homeProjects.length > 0) await rm(homeProjects.pop() as string, { recursive: true, force: true })
  while (keptRoots.length > 0) {
    const root = keptRoots.pop() as string
    await rm(root, { recursive: true, force: true })
  }
})

/** One unique temp directory removed after the test. */
export async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-sync-engine-'))
  keptRoots.push(root)
  return root
}

/** One unique directory under the current user's home, removed after the test. */
export async function homeProject(label: string): Promise<string> {
  const home = (await import('node:os')).homedir()
  const project = join(home, `agent-drop-sync-${label}-${Date.now().toString(36)}`)
  await mkdir(project, { recursive: true })
  homeProjects.push(project)
  return project
}

export const FILE_BYTES = new TextEncoder().encode('attachment bytes')
export const IMAGE_BYTES = new TextEncoder().encode('normalized image raster')
/** The image reference is digest-consistent: its id is the SHA-256 of the bytes. */
export const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${createHash('sha256').update(IMAGE_BYTES).digest('hex')}`),
  mediaType: 'image/png',
  bytes: IMAGE_BYTES.byteLength,
  width: 2,
  height: 2,
}
export const FILE_REF: FileAttachmentRef = {
  attachmentId: AttachmentId('sha256:2222222222222222222222222222222222222222222222222222222222222222'),
  name: 'notes.txt',
  bytes: FILE_BYTES.byteLength,
}

/**
 * Attachment store over memory for files and a real content-addressed root for
 * images, so the import pipeline's restore path exercises the same publication
 * API the production `attachment-local` store uses.
 */
export class TempAttachmentStore extends AttachmentStore {
  private readonly objects = new Map<string, Uint8Array>()

  /** Absolute versioned storage root for images, matching the real store layout. */
  readonly root: string

  readonly imageLimits = Object.freeze({
    maxImageBytes: Number.MAX_SAFE_INTEGER,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: Number.MAX_SAFE_INTEGER,
    maxImagePixels: Number.MAX_SAFE_INTEGER,
    maxImageDimension: Number.MAX_SAFE_INTEGER,
    mediaTypes: Object.freeze(['image/png'] as const),
  })

  constructor(ctx: Context) {
    super(ctx)
    const home = mkdtempSync(join(tmpdir(), 'session-sync-attachments-'))
    keptRoots.push(home)
    this.root = join(home, 'attachments', 'v1')
  }

  /** The content-addressed path of one image object below the root. */
  private imagePath(ref: ImageAttachmentRef): string {
    const sha256 = String(ref.attachmentId).replace(/^sha256:/u, '')
    return join(this.root, 'objects', sha256.slice(0, 2), sha256)
  }

  override async validateImage(input: SaveImageAttachment): Promise<void> {
    void input
  }

  override saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    void input
    return Promise.reject(new AttachmentError('unused in this suite', 'INVALID_IMAGE'))
  }

  override async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    const mapped = this.objects.get(String(ref.attachmentId))
    if (mapped !== undefined) return { ref, data: mapped }
    try {
      const data = new Uint8Array(await readFile(this.imagePath(ref)))
      return { ref, data }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AttachmentError('missing object', 'ATTACHMENT_NOT_FOUND')
      }
      throw error
    }
  }

  override async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    const ref: FileAttachmentRef = { attachmentId: FILE_REF.attachmentId, name: input.name ?? 'file', bytes: input.data.byteLength }
    this.objects.set(String(ref.attachmentId), input.data)
    return ref
  }

  override saveFileStream(): Promise<FileAttachmentRef> {
    return Promise.reject(new AttachmentError('unused in this suite', 'ATTACHMENT_FILES_UNSUPPORTED'))
  }

  override async *readFileStream(ref: FileAttachmentRef): AsyncIterable<Uint8Array> {
    const data = this.objects.get(String(ref.attachmentId))
    if (data === undefined) throw new AttachmentError('missing object', 'ATTACHMENT_NOT_FOUND')
    yield data
  }

  override async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget): Promise<RequestImageAttachment> {
    void ref
    void target
    throw new AttachmentError('unused in this suite', 'ATTACHMENT_PROJECTION_UNSUPPORTED')
  }

  /** Seed one object for the suite without admitting it as an upload.
   *
   * Seeded objects stay in memory only: the import pipeline's image restore
   * publishes through the real content-addressed API into {@link root}, and a
   * pre-existing file at the target would trip the publication's hard-link
   * deduplication. Reads check the map first, then the restored files.
   * @param ref - the reference the session log will carry.
   * @param data - the exact stored bytes.
   */
  storeSeedObject(ref: ImageAttachmentRef | FileAttachmentRef, data: Uint8Array): void {
    this.objects.set(String(ref.attachmentId), data)
  }

  /** Drop one stored object, simulating a store that never received it.
   * @param ref - the reference to forget.
   */
  forget(ref: ImageAttachmentRef | FileAttachmentRef): void {
    this.objects.delete(String(ref.attachmentId))
  }
}

/** The session-query engine with exact reads and lineage; search is unused here. */
class ExactReadQueryEngine extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('search is unused in this suite'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('search is unused in this suite'))
  }
}

/** One mounted device: the real composition plus the sync service. */
export interface Harness {
  /** The mounted context. */
  readonly ctx: Context
  /** The synchronization service. */
  readonly service: SessionSyncService
  /** The in-memory attachment store. */
  readonly attachments: TempAttachmentStore
  /** The JSONL session root this device persists into. */
  readonly sessionsRoot: string
  /** The Loader-backed configuration handle. */
  readonly live: Awaited<ReturnType<typeof liveConfig>>
}

/** Options for mounting one device. */
export interface HarnessOptions {
  /** Session store root; a fresh temp root by default. */
  readonly sessionsRoot?: string
  /** The configured sync root; unset by default. */
  readonly syncRoot?: string
}

/**
 * Boot the real storage/session/query/attachment/workspace composition with the
 * sync service mounted behind the Loader and the `dir` backend registered.
 * @param options - session root and configured sync root.
 * @returns the mounted device.
 */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const sessionsRoot = options.sessionsRoot ?? join(await tempRoot(), 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  const pool = new MemoryMediaPool()
  const backend: StorageBackend = new MemoryStorageBackend(pool)
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  await ctx.plugin(ExactReadQueryEngine)
  await ctx.plugin(WorkspaceRegistry)
  const attachments = new TempAttachmentStore(ctx)
  const live = await liveConfig(ctx, SessionSyncService, { root: options.syncRoot })
  ctx.effect(() => ctx.sessionSync.registerBackend(new DirSessionSyncBackend()), 'test: dir backend')
  return { ctx, service: live.fiber.ctx.sessionSync as unknown as SessionSyncService, attachments, sessionsRoot, live }
}

/** One recorded user message with an optional attachment block beside its text. */
export function textEvent(seq: number, time: number, text: string, refs?: readonly ContentBlock[]): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time,
    surfaceOp: 'append',
    data: createUserMessage({
      content: [{ type: 'text', text }, ...(refs ?? [])],
      source: { kind: 'user' },
    }),
  }
}

/** Persist one root session with a complete turn and two attachment references. */
export async function seedRoot(value: Harness, cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('session-root'),
    createdAt: 1000,
    cwd,
    isSeeded: false,
  }
  const handle = await value.ctx.sessionPersistence.create(header)
  await handle.append([
    { type: 'turn/start', seq: SessionLogOffset(0), time: 1050, data: { turn: 1 } } as unknown as SessionEvent,
    textEvent(1, 1100, 'hello'),
    { type: 'step/start', seq: SessionLogOffset(2), time: 1120, data: { turn: 1, step: 1 } } as unknown as SessionEvent,
    { type: 'step/end', seq: SessionLogOffset(3), time: 1180, data: { turn: 1, step: 1 } } as unknown as SessionEvent,
    { type: 'turn/end', seq: SessionLogOffset(4), time: 1200, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent,
    textEvent(5, 1300, 'with attachment', [
      { type: 'image', attachment: IMAGE_REF },
      { type: 'file', attachment: FILE_REF },
    ]),
  ])
  await handle.flush()
  await handle.close()
  value.attachments.storeSeedObject(IMAGE_REF, IMAGE_BYTES)
  value.attachments.storeSeedObject(FILE_REF, FILE_BYTES)
}

/** Append one more event to the stored root log. */
export async function appendRootEvent(value: Harness, text = 'appended after snapshot'): Promise<void> {
  const handle = await value.ctx.sessionPersistence.open(SessionId('session-root'), 'write')
  try {
    const stored = await handle.read(0, undefined)
    await handle.append([textEvent(stored.events.length, 1400, text)])
    await handle.flush()
  } finally {
    await handle.close()
  }
}

/** Persist one fork child whose header carries the resolved target cwd. */
export async function seedChild(value: Harness, cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('session-child'),
    createdAt: 2000,
    cwd,
    parentSession: SessionId('session-root'),
    isSeeded: true,
  }
  const handle = await value.ctx.sessionPersistence.create(header, { inheritedEventCount: SessionLogOffset(1) })
  await handle.append([
    textEvent(0, 1100, 'inherited prefix'),
    { type: 'session/end-seed', seq: SessionLogOffset(1), time: 1150, data: { inherited: true } } as unknown as SessionEvent,
    textEvent(2, 2100, 'child-owned work'),
  ])
  await handle.flush()
  await handle.close()
}

/** The single manifest file published under one root-session bucket.
 * @param syncRoot - the configured sync root.
 * @param rootSessionId - the bucket to inspect.
 * @returns the manifest path and its decoded text.
 */
export async function readPublishedManifest(
  syncRoot: string,
  rootSessionId: string,
): Promise<{ readonly path: string, readonly text: string }> {
  const bucket = join(syncRoot, 'dsh-session-sync', 'trees', rootSessionId)
  const names = await readdir(bucket)
  const name = names[0] as string
  const path = join(bucket, name)
  const { readFile } = await import('node:fs/promises')
  return { path, text: await readFile(path, 'utf8') }
}
