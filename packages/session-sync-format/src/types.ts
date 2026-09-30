/** The sync-package format vocabulary: portable cwd, session entries, tree manifests. @module @deepseek-ai/dsh-session-sync-format/types */

import type { ImageAttachmentRef, FileAttachmentRef } from '@deepseek-ai/dsh-attachment/types'

/**
 * Current sync-package format version. A manifest stamped with any other
 * version is refused without guessing at compatibility.
 */
export const SYNC_FORMAT_VERSION = 1

/** Portable encoding of one session's working directory, relative to the exporting user's home. */
export interface PortableCwd {
  /** The only encoding; further kinds must land in a format-version successor. */
  readonly kind: 'home-relative'
  /**
   * Path components below the exporting device's user home. An empty array
   * means the original `cwd` was the home directory itself. Components carry
   * no absolute path, no `.` or `..`, no path separator, and no NUL.
   */
  readonly components: readonly string[]
}

/** Sync-header fields carried beside the portable cwd; mirrors the local `SessionHeader`. */
export interface SyncSessionHeader {
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Portable home-relative working directory; absent when the session recorded none. */
  readonly cwd?: PortableCwd
  /** The fork parent session id, when the session is a fork child. */
  readonly parentSession?: string
  /** Whether the session contains a fork-inherited event prefix. */
  readonly isSeeded: boolean
  /** Coarse product classification for a session created as a subagent child. */
  readonly origin?: 'subagent'
  /** Delegation depth; absent (zero) for a top-level session. */
  readonly delegationDepth?: number
  /** Id of the agent preset this session's agent was composed from. */
  readonly agentPreset?: string
}

/** One event object reference: the content digest of one session's JSONL event body. */
export interface SyncEventObject {
  /** Exact number of events encoded in the object. */
  readonly count: number
  /** SHA-256 hex digest of the object's bytes. */
  readonly object: string
}

/** One attachment entry: the original reference, its transfer metadata, and the object digest. */
export interface SyncAttachmentEntry {
  /** Attachment kind; selects the reference shape below. */
  readonly kind: 'image' | 'file'
  /** The reference exactly as the exporting device's session log carries it. */
  readonly ref: ImageAttachmentRef | FileAttachmentRef
  /** SHA-256 hex digest of the stored attachment bytes. */
  readonly object: string
}

/** One session entry inside a tree manifest; parents appear before children. */
export interface SyncSessionEntry {
  /** Session identity. */
  readonly sessionId: string
  /** Sync header fields; the portable cwd is the only `cwd` representation. */
  readonly header: SyncSessionHeader
  /** Exact fork-inherited prefix length; zero when `isSeeded` is false. */
  readonly inheritedEventCount: number
  /** Event object reference. */
  readonly events: SyncEventObject
  /** Attachment entries in first-reference order; deduplicated per image id and per file name. */
  readonly attachments?: readonly SyncAttachmentEntry[]
}

/**
 * One tree manifest: the complete lineage of one root session and the objects
 * that carry its history. The manifest's canonical bytes are named by their
 * own SHA-256 (`treeRevisionHash`), so the file name and its bytes agree.
 */
export interface SyncTreeManifest {
  /** Fixed manifest tag. */
  readonly type: 'dsh-session-tree'
  /** Current sync-package format version. */
  readonly formatVersion: typeof SYNC_FORMAT_VERSION
  /** The root session whose lineage this manifest publishes. */
  readonly rootSessionId: string
  /** Root first, then every descendant in dependency order; ids are unique. */
  readonly sessions: readonly SyncSessionEntry[]
}

/** One tree manifest file observed on the sync medium, before its content is read. */
export interface SyncTreeFile {
  /** Root session id bucket the file sits in. */
  readonly rootSessionId: string
  /** SHA-256 hex digest the file's path claims (`<treeRevisionHash>.json`). */
  readonly revisionHash: string
  /** Absolute path of the manifest file on the backend. */
  readonly path: string
}

/** Refusal to interpret one sync-package artifact. */
export class SyncFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncFormatError'
  }
}
