/**
 * Behavior tests for the local-directory sync backend: root preparation and
 * storage-overlap refusal, durable content-addressed publication, and
 * digest-verified reads against a real temporary directory.
 */

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SyncObjectMissingError } from '@deepseek-ai/dsh-session-sync'
import type { SessionSyncRoot } from '@deepseek-ai/dsh-session-sync'
import { sha256Hex, treeBucketSegment, treeFileOf } from '@deepseek-ai/dsh-session-sync-format'
import { DirSessionSyncBackend } from '../src/index.ts'

/** Package directory the backend owns beneath one configured root. */
const PACKAGE_DIR = 'dsh-session-sync'

/** The backend under test; it caches no state between calls. */
const backend = new DirSessionSyncBackend()

/** Real temporary directories created by this suite, removed after each test. */
const created: string[] = []

/** The ambient `DSH_HOME` value, restored after each test that overrides it. */
const ambientDshHome = process.env.DSH_HOME

afterEach(async () => {
  if (ambientDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ambientDshHome
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

/**
 * Create one tracked temporary directory.
 * @param prefix - `mkdtemp` prefix naming the directory's purpose.
 * @returns the created directory path.
 */
async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/**
 * Prepare one tracked configured root.
 * @param prefix - `mkdtemp` prefix naming the directory's purpose.
 * @returns the prepared sync root.
 */
async function preparedRoot(prefix: string): Promise<SessionSyncRoot> {
  return backend.resolveRoot(await tempDir(prefix))
}

/**
 * Whether one path exists as a directory.
 * @param path - candidate path.
 * @returns whether the path is an existing directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(entry => entry.isDirectory()).catch(() => false)
}

/**
 * Read one medium file as plain bytes.
 * @param path - file to read.
 * @returns the file's exact bytes.
 */
async function fileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

/**
 * Normalize one byte sequence the backend returned for comparison.
 * @param bytes - bytes read through the backend.
 * @returns a plain `Uint8Array` copy.
 */
function plainBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

/**
 * Settle one promise into its value or its rejection.
 * @param promise - promise under test.
 * @returns the rejection reason, or `undefined` when the promise resolved.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error)
}

/** Bytes of one published event object. */
const EVENT_BYTES = new TextEncoder().encode('{"type":"user/message","seq":0}\n')

/** Bytes of one published tree manifest. */
const TREE_BYTES = new TextEncoder().encode('{"type":"dsh-session-tree","formatVersion":1}\n')

describe('DirSessionSyncBackend.resolveRoot', () => {
  it('normalizes the configured root into one canonical package root', async () => {
    const configured = await tempDir('session-sync-dir-root-')
    const resolved = await backend.resolveRoot(configured)
    expect(resolved).toEqual({ path: await realpath(join(configured, PACKAGE_DIR)) })
    expect(await isDirectory(resolved.path)).toBe(true)
  })

  it('resolves the same configured root twice to the identical canonical path', async () => {
    const configured = await tempDir('session-sync-dir-idempotent-')
    const first = await backend.resolveRoot(configured)
    const again = await backend.resolveRoot(configured)
    expect(again.path).toBe(first.path)
    // A trailing-separator spelling of the same root addresses the same medium.
    await expect(backend.resolveRoot(`${configured}/`)).resolves.toEqual({ path: first.path })
  })

  it('prepares the whole documented layout as soon as the root resolves', async () => {
    // Every documented family exists before the first publish, so a medium that
    // has never carried an object still matches the layout contract.
    const root = await preparedRoot('session-sync-dir-layout-')
    for (const relative of ['objects/events', 'objects/attachments', 'trees', 'tmp']) {
      expect(await isDirectory(join(root.path, relative))).toBe(true)
    }
    await backend.publishObject(root, 'events', sha256Hex(EVENT_BYTES), EVENT_BYTES)
    await backend.publishObject(root, 'attachments', sha256Hex(EVENT_BYTES), EVENT_BYTES)
    await backend.publishTree(root, 'session-root', sha256Hex(TREE_BYTES), TREE_BYTES)
    for (const relative of ['objects/events', 'objects/attachments', 'trees', 'tmp']) {
      expect(await isDirectory(join(root.path, relative))).toBe(true)
    }
  })

  it('follows a symlinked package directory to its canonical target and prepares the layout there', async () => {
    const configured = await tempDir('session-sync-dir-linked-')
    const target = await tempDir('session-sync-dir-linked-target-')
    await symlink(target, join(configured, PACKAGE_DIR), 'dir')
    const resolved = await backend.resolveRoot(configured)
    expect(resolved.path).toBe(await realpath(target))
    for (const relative of ['objects/events', 'objects/attachments', 'trees', 'tmp']) {
      expect(await isDirectory(join(resolved.path, relative))).toBe(true)
    }
  })

  it('refuses a root that overlaps the harness home or one of its stores', async () => {
    const home = await realpath(await tempDir('session-sync-dir-home-'))
    process.env.DSH_HOME = home
    const refusal = `overlaps the harness store at '${home}'`
    // The home entry is consulted first, so every refusal beneath the home
    // cites the home itself, including the session and attachment stores.
    for (const candidate of [home, join(home, 'sessions'), join(home, 'sessions', 'nested'), join(home, 'attachments')]) {
      await expect(backend.resolveRoot(candidate)).rejects.toThrow(refusal)
    }
    // Containment in the other direction is overlap too: this root would own the home.
    await expect(backend.resolveRoot(dirname(home))).rejects.toThrow(refusal)
  })

  it('accepts a root outside every harness store', async () => {
    process.env.DSH_HOME = await realpath(await tempDir('session-sync-dir-home-'))
    const configured = await tempDir('session-sync-dir-sibling-')
    const resolved = await backend.resolveRoot(configured)
    expect(resolved).toEqual({ path: await realpath(join(configured, PACKAGE_DIR)) })
  })
})

describe('DirSessionSyncBackend objects', () => {
  it('publishes an object at its digest-derived path and reads the exact bytes back', async () => {
    const root = await preparedRoot('session-sync-dir-publish-')
    const digest = sha256Hex(EVENT_BYTES)
    await backend.publishObject(root, 'events', digest, EVENT_BYTES)
    expect(await fileBytes(join(root.path, 'objects', 'events', digest))).toEqual(EVENT_BYTES)
    expect(plainBytes(await backend.readObject(root, 'events', digest))).toEqual(EVENT_BYTES)
  })

  it('republishes identical bytes idempotently', async () => {
    const root = await preparedRoot('session-sync-dir-republish-')
    const digest = sha256Hex(EVENT_BYTES)
    await backend.publishObject(root, 'attachments', digest, EVENT_BYTES)
    await backend.publishObject(root, 'attachments', digest, EVENT_BYTES)
    expect(await fileBytes(join(root.path, 'objects', 'attachments', digest))).toEqual(EVENT_BYTES)
    // The staging directory holds no committed leftovers.
    expect(await readdir(join(root.path, 'tmp'))).toEqual([])
  })

  it('replaces an existing path whose content differs and keeps the newly published bytes', async () => {
    const root = await preparedRoot('session-sync-dir-replace-')
    const digest = sha256Hex(EVENT_BYTES)
    await backend.publishObject(root, 'events', digest, EVENT_BYTES)
    const target = join(root.path, 'objects', 'events', digest)
    // A cloud client left different bytes at the digest-named path.
    await writeFile(target, 'stale bytes from another device')
    await backend.publishObject(root, 'events', digest, EVENT_BYTES)
    expect(await fileBytes(target)).toEqual(EVENT_BYTES)
    expect(plainBytes(await backend.readObject(root, 'events', digest))).toEqual(EVENT_BYTES)
  })

  it('refuses bytes that do not match their publication digest and stages nothing', async () => {
    const root = await preparedRoot('session-sync-dir-mismatch-')
    const wrong = 'a'.repeat(64)
    await expect(backend.publishObject(root, 'events', wrong, EVENT_BYTES))
      .rejects.toThrow(/do not match their publication digest/u)
    expect(await stat(join(root.path, 'objects', 'events', wrong)).catch(() => undefined)).toBeUndefined()
    expect(await readdir(join(root.path, 'tmp'))).toEqual([])
  })

  it('refuses an absent object with SyncObjectMissingError', async () => {
    const root = await preparedRoot('session-sync-dir-absent-')
    const digest = sha256Hex(new TextEncoder().encode('never published'))
    const error = await rejectionOf(backend.readObject(root, 'events', digest))
    expect(error).toBeInstanceOf(SyncObjectMissingError)
    expect((error as SyncObjectMissingError).name).toBe('SyncObjectMissingError')
    expect((error as SyncObjectMissingError).message).toContain(digest)
  })

  it('refuses stored bytes that no longer match the requested digest', async () => {
    const root = await preparedRoot('session-sync-dir-corrupt-')
    const digest = sha256Hex(EVENT_BYTES)
    await backend.publishObject(root, 'events', digest, EVENT_BYTES)
    await writeFile(join(root.path, 'objects', 'events', digest), 'corrupted by an external writer')
    const error = await rejectionOf(backend.readObject(root, 'events', digest))
    expect(error).not.toBeInstanceOf(SyncObjectMissingError)
    expect((error as Error).message).toMatch(/failed its digest verification/u)
  })
})

describe('DirSessionSyncBackend trees', () => {
  it('publishes a manifest under its session bucket and reads it back by revision', async () => {
    const root = await preparedRoot('session-sync-dir-tree-')
    const revision = sha256Hex(TREE_BYTES)
    await backend.publishTree(root, 'session-root', revision, TREE_BYTES)
    const path = join(root.path, 'trees', treeBucketSegment('session-root'), `${revision}.json`)
    expect(await fileBytes(path)).toEqual(TREE_BYTES)
    expect(plainBytes(await backend.readTree(root, treeFileOf(path, 'session-root', revision)))).toEqual(TREE_BYTES)
  })

  it('refuses a manifest whose bytes do not match the revision its record names', async () => {
    const root = await preparedRoot('session-sync-dir-revision-')
    const revision = sha256Hex(TREE_BYTES)
    await backend.publishTree(root, 'session-root', revision, TREE_BYTES)
    const path = join(root.path, 'trees', treeBucketSegment('session-root'), `${revision}.json`)
    const error = await rejectionOf(backend.readTree(root, treeFileOf(path, 'session-root', 'b'.repeat(64))))
    expect((error as Error).message).toMatch(/failed its revision verification/u)
  })

  it('lists only digest-named manifests under trees/<bucket>', async () => {
    const root = await preparedRoot('session-sync-dir-list-')
    const revision = sha256Hex(TREE_BYTES)
    await backend.publishTree(root, 'session-root', revision, TREE_BYTES)
    const bucket = join(root.path, 'trees', treeBucketSegment('session-root'))
    await writeFile(join(bucket, 'notes.json'), 'not a manifest name')
    await writeFile(join(bucket, `${revision}.jsonl`), 'wrong suffix')
    await writeFile(join(bucket, `${'A'.repeat(64)}.json`), 'uppercase is not a digest')
    await writeFile(join(root.path, 'trees', `${revision}.json`), 'a file, not a bucket')
    expect(await backend.listTrees(root)).toEqual([
      { rootSessionId: 'session-root', revisionHash: revision, path: join(bucket, `${revision}.json`) },
    ])
  })

  it('lists nothing for a freshly prepared root', async () => {
    const root = await preparedRoot('session-sync-dir-empty-')
    expect(await backend.listTrees(root)).toEqual([])
  })

  it('refuses a record whose path climbs out of the prepared root', async () => {
    const root = await preparedRoot('session-sync-dir-climb-')
    const revision = sha256Hex(TREE_BYTES)
    // `<prepared root>/trees/../..` escapes the package root into its parent.
    const escaped = join(root.path, 'trees', '..', '..', 'escaped.json')
    await writeFile(escaped, TREE_BYTES)
    const error = await rejectionOf(backend.readTree(root, treeFileOf(escaped, '..', revision)))
    expect((error as Error).message).toMatch(/resolves outside the prepared root/u)
  })

  it('refuses a record whose bucket is a symlink pointing outside the root', async () => {
    const root = await preparedRoot('session-sync-dir-symlink-')
    const outside = await tempDir('session-sync-dir-outside-')
    const revision = sha256Hex(TREE_BYTES)
    const outsideFile = join(outside, `${revision}.json`)
    await writeFile(outsideFile, TREE_BYTES)
    await mkdir(join(root.path, 'trees'), { recursive: true })
    await symlink(outside, join(root.path, 'trees', 'escape'), 'dir')
    const record = treeFileOf(join(root.path, 'trees', 'escape', `${revision}.json`), 'escape', revision)
    const error = await rejectionOf(backend.readTree(root, record))
    expect((error as Error).message).toMatch(/resolves outside the prepared root/u)
    // The refused file really was readable at its outside path.
    expect(await fileBytes(outsideFile)).toEqual(TREE_BYTES)
  })
})
