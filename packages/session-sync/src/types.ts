/** Public result and operation vocabulary of the session-sync service. @module @deepseek-ai/dsh-session-sync/types */

/** Outcome of one sync operation on one session tree. */
export type SyncTreeStatus = 'exported' | 'imported' | 'skipped' | 'pending' | 'conflict' | 'failed' | 'ready'

/** Outcome of one sync operation on one session. */
export type SyncSessionStatus = 'created' | 'appended' | 'exported' | 'skipped' | 'pending' | 'conflict' | 'failed' | 'ready'

/** Workspace attachment reported for one imported session. */
export interface SyncSessionBinding {
  /** Whether the session joined its workspace. */
  readonly attached: boolean
  /** Why the session stayed unbound; absent when attached. */
  readonly reason?: string
}

/** One auto-created local directory an import prepared. */
export interface SyncCreatedDirectory {
  /** Absolute local directory path. */
  readonly path: string
  /** Whether the directory held no files after import. */
  readonly empty: boolean
}

/** One session's outcome inside a tree. */
export interface SyncSessionResult {
  /** Session identity. */
  readonly sessionId: string
  /** Definitive outcome of this pass. */
  readonly status: SyncSessionStatus
  /** Why the session skipped, conflicted, or failed; absent when written. */
  readonly reason?: string
  /** Local event count observed at compare time, when the session existed locally. */
  readonly localEvents?: number
  /** Remote event count observed in the sync package. */
  readonly remoteEvents?: number
  /** Workspace binding outcome; absent for export passes and for sessions that never wrote. */
  readonly binding?: SyncSessionBinding
}

/** One tree's outcome inside a sync operation. */
export interface SyncTreeResult {
  /** Root session identity. */
  readonly rootSessionId: string
  /** Definitive outcome of this pass. */
  readonly status: SyncTreeStatus
  /** Why the tree skipped, stayed pending, or failed; absent when fully published. */
  readonly reason?: string
  /** Per-session outcomes; empty when the tree never reached its session pass. */
  readonly sessions: readonly SyncSessionResult[]
  /** Directories this import auto-created, with their emptiness; absent for export and scan. */
  readonly createdDirectories?: readonly SyncCreatedDirectory[]
  /** Local preparation steps completed before a failure stopped the tree; absent on success. */
  readonly completedSteps?: readonly string[]
}

/** Final state of one sync operation. */
export interface SyncOperationResult {
  readonly trees: readonly SyncTreeResult[]
}

/** Operation lifecycle state. */
export type SyncOperationStatus = 'accepted' | 'running' | 'complete' | 'failed'

/** Direction of one sync operation. */
export type SyncOperationKind = 'export' | 'import' | 'scan'

/** One sync operation's record, safe to expose over the status API. */
export interface SyncOperationRecord {
  /** Operation identity minted by the service. */
  readonly id: string
  /** Operation direction. */
  readonly kind: SyncOperationKind
  /** Unix epoch milliseconds of acceptance. */
  readonly submittedAt: number
  /** Normalized sync root captured at acceptance; operations keep using it. */
  readonly root: string
  /** Current lifecycle state. */
  readonly status: SyncOperationStatus
  /** Final outcome; present only when the operation reached a terminal state. */
  readonly result?: SyncOperationResult
  /** Rendered failure reason; present only with `failed`. */
  readonly error?: string
}

/** Reference returned to the submitting entry point. */
export interface SyncOperationRef {
  /** Operation identity. */
  readonly id: string
  /** Settles once, with the final result or the failure reason as the rejection. */
  readonly done: Promise<SyncOperationResult>
}
