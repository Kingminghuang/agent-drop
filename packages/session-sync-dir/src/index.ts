/** Local-directory sync backend registration. @module @deepseek-ai/dsh-session-sync-dir */

import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SyncTreeFile } from '@deepseek-ai/dsh-session-sync-format'
import {
  SessionSyncBackend,
  type SessionSyncObjectKind,
  type SessionSyncRoot,
} from '@deepseek-ai/dsh-session-sync'
import { prepareSyncRoot } from '@deepseek-ai/dsh-session-sync/paths'
import { listTrees, publishObject, publishTree, readObject, readTree } from './publish.ts'

/** Cordis function-plugin name. */
export const name = 'session-sync-dir'

/** Services required before the backend can mount. */
export const inject = ['sessionSync']

/** The package directory the medium owns inside the configured root. */
const PACKAGE_DIR = 'dsh-session-sync'

/**
 * The local-directory backend: one cloud-replicated folder on this machine.
 * Publishes stage, fsync, and commit content-addressed objects, replace an
 * existing target even when its content differs, and read every commit back
 * to verify its digest before the operation resolves.
 */
export class DirSessionSyncBackend extends SessionSyncBackend {
  /** Backend label. */
  readonly kind = 'dir'

  /**
   * Normalize one configured root, create the package tree beneath it, and
   * refuse a root whose canonical spelling overlaps a harness store.
   * @param root - configured root path.
   * @param options - optional cancellation.
   * @returns the prepared package root.
   */
  override async resolveRoot(root: string, options?: { readonly signal?: AbortSignal }): Promise<SessionSyncRoot> {
    options?.signal?.throwIfAborted()
    const canonical = await prepareSyncRoot(root)
    const packageRoot = join(canonical, PACKAGE_DIR)
    await mkdir(packageRoot, { recursive: true, mode: 0o700 })
    // A symlinked ancestor may resolve the package root elsewhere; the canonical
    // spelling is what every later write and read addresses, and the documented
    // layout is prepared there on every resolution.
    const canonicalPackageRoot = await realpath(packageRoot)
    await ensureLayout(canonicalPackageRoot, options?.signal)
    return { path: canonicalPackageRoot }
  }

  /**
   * Publish one content-addressed object.
   * @param root - prepared package root.
   * @param kind - object family.
   * @param digest - lowercase SHA-256 hex digest.
   * @param data - exact object bytes.
   * @param options - optional cancellation.
   * @returns completion after the committed bytes were verified.
   */
  override publishObject(
    root: SessionSyncRoot,
    kind: SessionSyncObjectKind,
    digest: string,
    data: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    return publishObject(root.path, kind, digest, data, options?.signal)
  }

  /**
   * Publish one tree manifest.
   * @param root - prepared package root.
   * @param rootSessionId - root session bucket.
   * @param revisionHash - digest of the manifest's canonical bytes.
   * @param bytes - manifest bytes.
   * @param options - optional cancellation.
   * @returns completion after the committed bytes were verified.
   */
  override publishTree(
    root: SessionSyncRoot,
    rootSessionId: string,
    revisionHash: string,
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    return publishTree(root.path, rootSessionId, revisionHash, bytes, options?.signal)
  }

  /**
   * List the tree manifest files visible on the medium.
   * @param root - prepared package root.
   * @param options - optional cancellation.
   * @returns one record per candidate file.
   */
  override listTrees(root: SessionSyncRoot, options?: { readonly signal?: AbortSignal }): Promise<readonly SyncTreeFile[]> {
    return listTrees(root.path, options?.signal)
  }

  /**
   * Read one content-addressed object.
   * @param root - prepared package root.
   * @param kind - object family.
   * @param digest - lowercase SHA-256 hex digest.
   * @param options - optional cancellation.
   * @returns the verified bytes.
   */
  override readObject(
    root: SessionSyncRoot,
    kind: SessionSyncObjectKind,
    digest: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array> {
    return readObject(root.path, kind, digest, options?.signal)
  }

  /**
   * Read one tree manifest file.
   * @param root - prepared package root.
   * @param file - the tree file to read.
   * @param options - optional cancellation.
   * @returns the verified bytes.
   */
  override readTree(
    root: SessionSyncRoot,
    file: SyncTreeFile,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array> {
    return readTree(root.path, file, options?.signal)
  }
}

/** Create the package layout beneath one canonical package root. */
async function ensureLayout(packageRoot: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await mkdir(join(packageRoot, 'objects', 'events'), { recursive: true, mode: 0o700 })
  await mkdir(join(packageRoot, 'objects', 'attachments'), { recursive: true, mode: 0o700 })
  await mkdir(join(packageRoot, 'trees'), { recursive: true, mode: 0o700 })
  await mkdir(join(packageRoot, 'tmp'), { recursive: true, mode: 0o700 })
}

/**
 * Mount the local-directory backend on the composed sync service.
 * @param ctx - plugin context carrying the sync service.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.sessionSync.registerBackend(new DirSessionSyncBackend()),
    'session-sync-dir: backend',
  )
}
