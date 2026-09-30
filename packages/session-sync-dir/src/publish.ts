/** Durable publish and verified read for the local sync directory. @module @deepseek-ai/dsh-session-sync-dir/publish */

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, readFile, realpath, rename, rm, readdir, stat } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import {
  requireDigestPath,
  sha256Hex,
  treeBucketSegment,
  treeFileOf,
  type SyncTreeFile,
} from '@deepseek-ai/dsh-session-sync-format'
import { SyncObjectMissingError } from '@deepseek-ai/dsh-session-sync'
import type { SessionSyncObjectKind } from '@deepseek-ai/dsh-session-sync'

/** Package-relative directory names. */
const OBJECTS_DIR = 'objects'
const EVENTS_DIR = 'events'
const ATTACHMENTS_DIR = 'attachments'
const TREES_DIR = 'trees'
const TMP_DIR = 'tmp'
const MANIFEST_SUFFIX = '.json'

/**
 * Whether one filesystem error reports an already-existing target. Real Node
 * errors carry the errno `code`; filesystem broker shims may surface the same
 * condition only through the message prefix.
 * @param error - the caught error.
 * @returns whether the target already existed.
 */
function isExistingTarget(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return true
  return /^EEXIST:/u.test((error as Error)?.message ?? '')
}

/** Make one directory's entry durable where the platform exposes directory handles. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Create one directory tree and persist every ancestor entry below the
 * prepared root, so a directory a publish references is durable before the
 * publish resolves.
 * @param path - directory to create.
 * @param boundary - ancestor the caller vouches is already durable.
 */
async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    if (parent === level) return
    level = parent
  }
}

/**
 * Verify one candidate path's directory stays inside the prepared root, so a
 * symlinked ancestor cannot carry a write outside the medium.
 * @param target - absolute candidate path.
 * @param rootPath - prepared package root.
 * @returns nothing after successful containment.
 * @throws {Error} when the target leaves the root.
 */
async function assertInsideRoot(target: string, rootPath: string): Promise<void> {
  const canonicalTarget = await realpath(dirname(target))
  const canonicalRoot = await realpath(rootPath)
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + '/')) {
    throw new Error(`sync write target '${target}' resolves outside the prepared root`)
  }
}

/**
 * Stage one object's bytes: an exclusive temp file inside the package's temp
 * directory, fsynced before publication.
 * @param rootPath - prepared package root.
 * @param data - exact object bytes.
 * @param signal - optional cancellation observed between writes.
 * @returns the staged path beside its digest.
 */
async function stageObject(
  rootPath: string,
  data: Uint8Array,
  signal?: AbortSignal,
): Promise<{ path: string; digest: string }> {
  const staging = join(rootPath, TMP_DIR)
  await ensureDurableDirectory(staging, parse(rootPath).root)
  const temporary = join(staging, `${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let closed = false
  try {
    await handle.writeFile(data)
    signal?.throwIfAborted()
    await handle.sync()
    signal?.throwIfAborted()
    closed = true
    await handle.close()
    return { path: temporary, digest: sha256Hex(data) }
  } catch (error: unknown) {
    if (!closed) await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Publish one staged file at its target: replace an existing target even when
 * its content differs, then read the committed bytes back and verify the
 * digest. A publish that cannot prove its committed bytes never resolves.
 * @param rootPath - prepared package root.
 * @param target - absolute final path.
 * @param digest - expected digest of the committed bytes.
 * @param stagedPath - staged temp path to publish.
 * @param signal - optional cancellation.
 * @returns nothing after the committed bytes were verified.
 */
async function publishStaged(
  rootPath: string,
  target: string,
  digest: string,
  stagedPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  // Create the target's family directory first; containment is asserted against
  // the canonical spelling after the directory exists.
  await ensureDurableDirectory(dirname(target), rootPath)
  await assertInsideRoot(target, rootPath)
  try {
    if (process.platform === 'win32') {
      await rename(stagedPath, target)
    } else {
      try {
        await link(stagedPath, target)
      } catch (error: unknown) {
        // The target holds different content or a stale copy; replacing one
        // digest-named path is the documented overwrite rule. Filesystem
        // broker shims may report EEXIST without an errno `code`, so the
        // message prefix is matched too.
        if (!isExistingTarget(error)) throw error
        await rename(stagedPath, target)
      }
    }
  } finally {
    await rm(stagedPath, { force: true }).catch(() => {})
    await syncDirectory(dirname(target))
  }
  const committed = await readFile(target)
  signal?.throwIfAborted()
  if (sha256Hex(committed) !== digest) {
    throw new Error(`committed sync object at '${target}' failed its digest readback (${digest})`)
  }
}

/**
 * Publish one content-addressed object: stage, verify the digest, publish at
 * the digest-derived path, then read the committed bytes back and verify.
 * @param rootPath - prepared package root.
 * @param kind - object family.
 * @param digest - lowercase SHA-256 hex digest.
 * @param data - exact object bytes.
 * @param signal - optional cancellation.
 * @returns nothing after the committed bytes were verified.
 * @throws {Error} when the bytes, the committed file, or the readback fails verification.
 */
export async function publishObject(
  rootPath: string,
  kind: SessionSyncObjectKind,
  digest: string,
  data: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  requireDigestPath(digest, 'object digest')
  const staged = await stageObject(rootPath, data, signal)
  if (staged.digest !== digest) {
    await rm(staged.path, { force: true })
    throw new Error(`sync object bytes do not match their publication digest (${digest})`)
  }
  const target = join(rootPath, OBJECTS_DIR, kind === 'events' ? EVENTS_DIR : ATTACHMENTS_DIR, digest)
  await publishStaged(rootPath, target, digest, staged.path, signal)
}

/**
 * Publish one tree manifest at `<rootSessionId>/<revisionHash>.json`.
 * @param rootPath - prepared package root.
 * @param rootSessionId - root session bucket.
 * @param revisionHash - digest of the manifest's canonical bytes.
 * @param bytes - manifest bytes.
 * @param signal - optional cancellation.
 * @returns nothing after the committed bytes were verified.
 * @throws {Error} when the bytes, the committed file, or the readback fails verification.
 */
export async function publishTree(
  rootPath: string,
  rootSessionId: string,
  revisionHash: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  requireDigestPath(revisionHash, 'tree revision')
  const staged = await stageObject(rootPath, bytes, signal)
  if (staged.digest !== revisionHash) {
    await rm(staged.path, { force: true })
    throw new Error(`tree manifest bytes do not match their revision digest (${revisionHash})`)
  }
  const target = join(rootPath, TREES_DIR, treeBucketSegment(rootSessionId), `${revisionHash}${MANIFEST_SUFFIX}`)
  await publishStaged(rootPath, target, revisionHash, staged.path, signal)
}

/**
 * Read one content-addressed object and verify its bytes.
 * @param rootPath - prepared package root.
 * @param kind - object family.
 * @param digest - lowercase SHA-256 hex digest.
 * @param signal - optional cancellation.
 * @returns the verified bytes.
 * @throws {SyncObjectMissingError} when the object is absent.
 * @throws {Error} when the object is unreadable or fails its digest.
 */
export async function readObject(
  rootPath: string,
  kind: SessionSyncObjectKind,
  digest: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  requireDigestPath(digest, 'object digest')
  const target = join(rootPath, OBJECTS_DIR, kind === 'events' ? EVENTS_DIR : ATTACHMENTS_DIR, digest)
  let bytes: Buffer
  try {
    bytes = await readFile(target)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SyncObjectMissingError(`sync object '${digest}' has not arrived yet`)
    }
    throw error
  }
  signal?.throwIfAborted()
  const actual = sha256Hex(bytes)
  if (actual !== digest) {
    throw new Error(`sync object '${digest}' failed its digest verification (${actual})`)
  }
  return bytes
}

/**
 * Read one tree manifest file and verify its bytes against the revision its
 * name claims. The file's directory must resolve inside the prepared root, so
 * a manifest path can never carry a read outside the medium.
 * @param rootPath - prepared package root.
 * @param file - the tree file to read.
 * @param signal - optional cancellation.
 * @returns the verified bytes.
 * @throws {SyncObjectMissingError} when the file is absent.
 * @throws {Error} when the file leaves the root, is unreadable, or fails its revision digest.
 */
export async function readTree(
  rootPath: string,
  file: SyncTreeFile,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const canonicalTarget = await realpath(dirname(file.path))
  const canonicalRoot = await realpath(rootPath)
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + '/')) {
    throw new Error(`tree manifest '${file.path}' resolves outside the prepared root`)
  }
  let bytes: Buffer
  try {
    bytes = await readFile(file.path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SyncObjectMissingError(`tree manifest '${file.revisionHash}' has not arrived yet`)
    }
    throw error
  }
  signal?.throwIfAborted()
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== file.revisionHash) {
    throw new Error(`tree manifest '${file.revisionHash}' failed its revision verification (${actual})`)
  }
  return bytes
}

/**
 * List the tree manifest files visible under the prepared root. A file whose
 * name is not a digest-shaped `.json` is not a candidate; order carries no
 * validity meaning.
 * @param rootPath - prepared package root.
 * @param signal - optional cancellation.
 * @returns one record per candidate file.
 */
export async function listTrees(rootPath: string, signal?: AbortSignal): Promise<readonly SyncTreeFile[]> {
  signal?.throwIfAborted()
  const treesRoot = join(rootPath, TREES_DIR)
  let buckets: string[]
  try {
    buckets = await readdir(treesRoot)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: SyncTreeFile[] = []
  for (const bucket of buckets) {
    signal?.throwIfAborted()
    const bucketPath = join(treesRoot, bucket)
    const directory = await stat(bucketPath).then(entry => entry.isDirectory()).catch(() => false)
    if (!directory) continue
    for (const name of await readdir(bucketPath)) {
      if (!name.endsWith(MANIFEST_SUFFIX)) continue
      const stem = name.slice(0, -MANIFEST_SUFFIX.length)
      try {
        requireDigestPath(stem, 'tree revision')
      } catch {
        continue
      }
      files.push(treeFileOf(join(bucketPath, name), bucket, stem))
    }
  }
  return files
}
