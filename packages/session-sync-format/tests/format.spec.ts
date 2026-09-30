import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SYNC_FORMAT_VERSION,
  SyncFormatError,
  decodeEventObject,
  decodeTreeManifest,
  encodeEventObject,
  encodePortableCwd,
  encodeTreeManifest,
  isAddressablePortableCwd,
  isPortableComponent,
  requireAttachmentDigest,
  requireDigestPath,
  resolvePortableCwd,
  treeBucketSegment,
  validatePortableCwd,
} from '../src/index.ts'
import type { PortableCwd, SyncAttachmentEntry, SyncSessionEntry, SyncTreeManifest } from '../src/index.ts'
import { hostPlatform, type PortableComponentPlatform } from '../src/portable-cwd.ts'

const windowsPlatform: PortableComponentPlatform = { windows: true }
const created: string[] = []

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'session-sync-format-'))
  created.push(root)
  return root
}

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 12,
  width: 3,
  height: 4,
}

const ATTACHMENT: SyncAttachmentEntry = { kind: 'image', ref: IMAGE_REF, object: 'c'.repeat(64) }

const ROOT_ENTRY: SyncSessionEntry = {
  sessionId: 'session-root',
  header: { createdAt: 100, isSeeded: false },
  inheritedEventCount: 0,
  events: { count: 2, object: 'd'.repeat(64) },
}

const CHILD_ENTRY: SyncSessionEntry = {
  sessionId: 'session-child',
  header: { createdAt: 200, isSeeded: true, parentSession: 'session-root' },
  inheritedEventCount: 1,
  events: { count: 0, object: 'e'.repeat(64) },
}

function manifestBytes(sessions: readonly SyncSessionEntry[], rootSessionId = 'session-root'): Uint8Array {
  return encodeTreeManifest({ type: 'dsh-session-tree', formatVersion: SYNC_FORMAT_VERSION, rootSessionId, sessions }).bytes
}

function turnStart(seq: number, time: number, turn: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time, data: { turn } }
}

describe('sync package format', () => {
  it('round-trips a tree manifest through its canonical bytes and revision hash', () => {
    const manifest: SyncTreeManifest = {
      type: 'dsh-session-tree',
      formatVersion: SYNC_FORMAT_VERSION,
      rootSessionId: 'session-root',
      sessions: [{ ...ROOT_ENTRY, attachments: [ATTACHMENT] }, CHILD_ENTRY],
    }
    const { bytes, revisionHash } = encodeTreeManifest(manifest)
    expect(revisionHash).toMatch(/^[0-9a-f]{64}$/u)
    const decoded = decodeTreeManifest(bytes, 'session-root')
    expect(decoded).toEqual(manifest)
    // Canonical encoding is stable: re-encoding the decoded manifest is byte-identical.
    expect(new TextDecoder().decode(encodeTreeManifest(decoded).bytes)).toBe(new TextDecoder().decode(bytes))
  })

  it('refuses a foreign format version, a mismatched root, and a broken lineage', () => {
    const foreign = encodeTreeManifest({
      type: 'dsh-session-tree',
      formatVersion: 2 as typeof SYNC_FORMAT_VERSION,
      rootSessionId: 'session-root',
      sessions: [ROOT_ENTRY],
    }).bytes
    expect(() => decodeTreeManifest(foreign, 'session-root')).toThrow(SyncFormatError)
    expect(() => decodeTreeManifest(manifestBytes([ROOT_ENTRY]), 'session-other')).toThrow(SyncFormatError)
    expect(() => decodeTreeManifest(manifestBytes([ROOT_ENTRY, ROOT_ENTRY]), 'session-root')).toThrow(SyncFormatError)
    expect(() => decodeTreeManifest(manifestBytes([CHILD_ENTRY, ROOT_ENTRY]), 'session-root')).toThrow(SyncFormatError)
    expect(() => decodeTreeManifest(manifestBytes([
      { ...ROOT_ENTRY, header: { createdAt: 100, isSeeded: false, parentSession: 'session-missing' } },
    ]), 'session-root')).toThrow(SyncFormatError)
    expect(() => decodeTreeManifest(manifestBytes([
      { ...ROOT_ENTRY, inheritedEventCount: 3 },
    ]), 'session-root')).toThrow(SyncFormatError)
  })

  it('round-trips event objects and verifies their digest, count, and sequence', () => {
    const events: readonly SessionEvent[] = [turnStart(0, 1, 1), turnStart(1, 2, 2)]
    const { bytes, object } = encodeEventObject(events)
    expect(decodeEventObject(bytes, { count: 2, object })).toEqual(events)
    expect(() => decodeEventObject(bytes, { count: 1, object })).toThrow(SyncFormatError)
    expect(() => decodeEventObject(bytes, { count: 2, object: 'f'.repeat(64) })).toThrow(SyncFormatError)
    // An empty object is legitimate: a session may carry no event at all.
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    expect(decodeEventObject(new Uint8Array(0), { count: 0, object: empty })).toEqual([])
  })

  it('refuses an event object whose sequence breaks or whose envelope carries unknown keys', () => {
    const broken = encodeEventObject([turnStart(1, 1, 1)])
    expect(() => decodeEventObject(broken.bytes, { count: 1, object: broken.object })).toThrow(SyncFormatError)
    const stray = encodeEventObject([{ ...turnStart(0, 1, 1), extra: true } as unknown as SessionEvent])
    expect(() => decodeEventObject(stray.bytes, { count: 1, object: stray.object })).toThrow(SyncFormatError)
    // The object digest always binds the bytes, even when the structure would pass.
    expect(() => decodeEventObject(stray.bytes, { count: 1, object: 'a'.repeat(64) })).toThrow(SyncFormatError)
  })

  it('encodes and resolves portable home-relative working directories', async () => {
    const root = await tempRoot()
    const home = homedir().replace(/\/+$/u, '')
    const nested = join(home, `session-sync-format-${Date.now().toString(36)}`)
    await mkdir(nested, { recursive: true })
    created.push(nested)
    const encoded = await encodePortableCwd(nested)
    expect(encoded).toEqual({ kind: 'home-relative', components: [nested.slice(home.length + 1)] })
    expect(await resolvePortableCwd(encoded as never)).toBe(nested)
    expect(await encodePortableCwd(home)).toEqual({ kind: 'home-relative', components: [] })
    // Outside home, unresolvable, and relative paths are not portable.
    expect(await encodePortableCwd(root)).toBeUndefined()
    expect(await encodePortableCwd(join(home, 'session-sync-does-not-exist'))).toBeUndefined()
    expect(await encodePortableCwd('relative/path')).toBeUndefined()
    expect(await encodePortableCwd('')).toBeUndefined()
  })

  it('decodes an unaddressable portable cwd structurally and classifies it separately', () => {
    const escaping = encodeTreeManifest({
      type: 'dsh-session-tree',
      formatVersion: SYNC_FORMAT_VERSION,
      rootSessionId: 'session-root',
      sessions: [{ ...ROOT_ENTRY, header: { createdAt: 100, isSeeded: false, cwd: { kind: 'home-relative', components: ['..', 'elsewhere'] } } }],
    }).bytes
    const decoded = decodeTreeManifest(escaping, 'session-root')
    const cwd = decoded.sessions[0]?.header.cwd as PortableCwd
    expect(isAddressablePortableCwd(cwd, hostPlatform)).toBe(false)
    expect(isAddressablePortableCwd(cwd, windowsPlatform)).toBe(false)
    expect(() => validatePortableCwd(cwd, hostPlatform)).toThrow(SyncFormatError)
    expect(isAddressablePortableCwd({ kind: 'home-relative', components: ['a'] }, hostPlatform)).toBe(true)
    expect(isAddressablePortableCwd({ kind: 'home-relative', components: ['a:b'] }, windowsPlatform)).toBe(false)
  })

  it('validates portable components against the target platform', () => {
    expect(isPortableComponent('a', hostPlatform)).toBe(true)
    expect(isPortableComponent('', hostPlatform)).toBe(false)
    expect(isPortableComponent('.', hostPlatform)).toBe(false)
    expect(isPortableComponent('..', hostPlatform)).toBe(false)
    expect(isPortableComponent('a/b', hostPlatform)).toBe(false)
    expect(isPortableComponent('a\\b', hostPlatform)).toBe(false)
    expect(isPortableComponent(`a${String.fromCharCode(0)}b`, hostPlatform)).toBe(false)
    expect(isPortableComponent('a'.repeat(256), hostPlatform)).toBe(false)
    expect(isPortableComponent('con', hostPlatform)).toBe(true)
    expect(isPortableComponent('con', windowsPlatform)).toBe(false)
    expect(isPortableComponent('a:b', hostPlatform)).toBe(true)
    expect(isPortableComponent('a:b', windowsPlatform)).toBe(false)
    expect(isPortableComponent('a.', hostPlatform)).toBe(true)
    expect(isPortableComponent('a.', windowsPlatform)).toBe(false)
    expect(() => validatePortableCwd({ kind: 'other', components: [] }, hostPlatform)).toThrow(SyncFormatError)
    expect(() => validatePortableCwd({ kind: 'home-relative', components: ['..'] }, hostPlatform)).toThrow(SyncFormatError)
    const valid = { kind: 'home-relative', components: ['a'] } as const
    expect(validatePortableCwd(valid, hostPlatform)).toEqual(valid)
  })

  it('validates digest-shaped references and reduces tree buckets safely', () => {
    expect(requireDigestPath('d'.repeat(64), 'digest')).toBe('d'.repeat(64))
    expect(() => requireDigestPath('D'.repeat(64), 'digest')).toThrow(SyncFormatError)
    expect(() => requireDigestPath('d'.repeat(63), 'digest')).toThrow(SyncFormatError)
    expect(requireAttachmentDigest(`sha256:${'a'.repeat(64)}`, 'id')).toBe('a'.repeat(64))
    expect(() => requireAttachmentDigest('sha256:short', 'id')).toThrow(SyncFormatError)
    expect(treeBucketSegment('session-abc')).toBe('session-abc')
    expect(treeBucketSegment('../etc/passwd')).toBe('___etc_passwd')
  })
})
