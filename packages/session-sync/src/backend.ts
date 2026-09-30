/** The storage seam behind the session-sync service. @module @deepseek-ai/dsh-session-sync/backend */

import type { SyncTreeFile } from '@deepseek-ai/dsh-session-sync-format'

/** One sync medium root the backend prepared for use. */
export interface SessionSyncRoot {
  /** Normalized absolute root path. */
  readonly path: string
}

/** Object families the sync package addresses. */
export type SessionSyncObjectKind = 'events' | 'attachments'

/** A backend read found the addressed object absent. */
export class SyncObjectMissingError extends Error {
  /**
   * @param message - which object was absent.
   */
  constructor(message: string) {
    super(message)
    this.name = 'SyncObjectMissingError'
  }
}

/**
 * One storage backend behind `ctx.sessionSync`. The backend owns the medium's
 * write ordering, replacement rules, digest verification, and path layout;
 * the service owns the format, comparison, and operation semantics.
 *
 * Every publish commits durably before it resolves, replaces an existing
 * target even when its content differs, and reads the committed bytes back to
 * verify the digest. An interrupted publish must never resolve and never
 * leave a committed file that fails its digest read. Reads verify the bytes
 * against the digest the caller holds and refuse an absent object with
 * {@link SyncObjectMissingError}.
 */
export abstract class SessionSyncBackend {
  /** Backend label used by diagnostics and composition. */
  abstract readonly kind: string

  /**
   * Normalize and validate one configured root: resolve the path, create or
   * reuse the directory, and refuse a root that overlaps another medium's
   * storage. Symbolic links must not carry a write outside the resolved root.
   * @param root - configured root path.
   * @param options - optional cancellation.
   * @returns the prepared root.
   */
  abstract resolveRoot(root: string, options?: { readonly signal?: AbortSignal }): Promise<SessionSyncRoot>

  /**
   * Publish one content-addressed object at its digest-derived path.
   * @param root - prepared root.
   * @param kind - object family.
   * @param digest - lowercase SHA-256 hex digest of the bytes.
   * @param data - exact object bytes.
   * @param options - optional cancellation.
   * @returns completion after the published bytes were read back and verified.
   */
  abstract publishObject(
    root: SessionSyncRoot,
    kind: SessionSyncObjectKind,
    digest: string,
    data: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>

  /**
   * Publish one tree manifest at `<rootSessionId>/<revisionHash>.json` after
   * every object it references is already published.
   * @param root - prepared root.
   * @param rootSessionId - root session bucket.
   * @param revisionHash - digest of the manifest's canonical bytes.
   * @param bytes - manifest bytes.
   * @param options - optional cancellation.
   * @returns completion after the published bytes were read back and verified.
   */
  abstract publishTree(
    root: SessionSyncRoot,
    rootSessionId: string,
    revisionHash: string,
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>

  /**
   * List the tree manifest files currently visible on the medium. A file whose
   * name is not a digest-shaped `.json` file is not a candidate; order carries
   * no validity meaning.
   * @param root - prepared root.
   * @param options - optional cancellation.
   * @returns one record per candidate file.
   */
  abstract listTrees(root: SessionSyncRoot, options?: { readonly signal?: AbortSignal }): Promise<readonly SyncTreeFile[]>

  /**
   * Read one object and verify its bytes against the digest the caller holds.
   * @param root - prepared root.
   * @param kind - object family.
   * @param digest - lowercase SHA-256 hex digest.
   * @param options - optional cancellation.
   * @returns the verified bytes.
   * @throws {SyncObjectMissingError} when the object is absent.
   * @throws {Error} when the object is unreadable or fails its digest.
   */
  abstract readObject(
    root: SessionSyncRoot,
    kind: SessionSyncObjectKind,
    digest: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array>

  /**
   * Read one tree manifest file and verify its bytes against the revision
   * digest its name claims.
   * @param root - prepared root.
   * @param file - the tree file to read.
   * @param options - optional cancellation.
   * @returns the verified bytes.
   * @throws {Error} when the file is absent, unreadable, or fails its revision digest.
   */
  abstract readTree(
    root: SessionSyncRoot,
    file: SyncTreeFile,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array>
}
