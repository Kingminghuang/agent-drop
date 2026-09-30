/** Local session observation helpers shared by the sync pipelines. @module @deepseek-ai/dsh-session-sync/observe */

import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** Options carrying an optional cancellation signal. */
export interface SyncSignalOptions {
  /** Optional cancellation. */
  readonly signal?: AbortSignal
}

/**
 * Build the options object a peer call accepts, omitting an absent signal
 * under `exactOptionalPropertyTypes`.
 * @param signal - optional cancellation.
 * @returns the options object with the signal present only when supplied.
 */
export function signalOptions(signal: AbortSignal | undefined): SyncSignalOptions {
  return signal === undefined ? {} : { signal }
}

/** One fixed snapshot of a stored session's logical state. */
export interface SyncSessionSnapshot {
  /** Stored header. */
  readonly header: SessionHeader
  /** Exact fork-inherited prefix length. */
  readonly inheritedEventCount: SessionLogOffset
  /** Validated events in seq order, cut to the snapshot's upper bound. */
  readonly events: readonly SessionEvent[]
}

/** The live-session store members the pipelines use. */
export interface SessionStoreLike {
  /** Look up one live session. */
  get(id: SessionId): Session | undefined
  /** Dispatch the durability checkpoint for one session. */
  flush(session: Session): Promise<boolean>
  /** Message projections installed by the composed plugins. */
  messageProjections: readonly SessionMessageProjectionLike[]
}

/** Minimal projection shape the pipelines pass through to detached replay. */
export interface SessionMessageProjectionLike {
  readonly type: string
}

/**
 * Flush one live session through the store's durability barrier and capture
 * its event count as the snapshot upper bound. A cold id has no in-memory
 * work; its bound comes from the persistence metadata when the backend
 * provides one cheaply.
 * @param sessions - the live-session store.
 * @param persistence - the mounted persistence backend.
 * @param id - the session about to be read.
 * @param signal - optional cancellation around the flush and stat.
 * @returns the inclusive event-count upper bound, or `undefined` when the backend cannot pin one.
 */
export async function snapshotUpperBound(
  sessions: SessionStoreLike | undefined,
  persistence: SessionPersistence,
  id: SessionId,
  signal?: AbortSignal,
): Promise<number | undefined> {
  signal?.throwIfAborted()
  if (sessions !== undefined) {
    const live = sessions.get(id)
    if (live !== undefined) {
      await sessions.flush(live)
      signal?.throwIfAborted()
      return live.seq
    }
  }
  const stat = await persistence.stat(id, signalOptions(signal))
  return stat?.eventCount
}

/**
 * Read one session's stored snapshot through a persistence read handle: the
 * stored header, the exact inherited cut, and the validated events cut to the
 * given upper bound. Cancellation aborts the open and the read.
 * @param persistence - the mounted persistence backend.
 * @param id - the session to read.
 * @param bound - inclusive event-count upper bound; `undefined` reads the whole log.
 * @param signal - optional cancellation.
 * @returns the fixed snapshot.
 * @throws {Error} when the session is absent, unreadable, or its log refuses validation.
 */
export async function readStoredSnapshot(
  persistence: SessionPersistence,
  id: SessionId,
  bound: number | undefined,
  signal?: AbortSignal,
): Promise<SyncSessionSnapshot> {
  const options = signalOptions(signal)
  const handle = await persistence.open(id, 'read', options)
  try {
    const read = await handle.read(0, undefined, options)
    const events = bound === undefined ? read.events : read.events.slice(0, bound)
    return {
      header: structuredClone(handle.header),
      inheritedEventCount: handle.inheritedEventCount,
      events,
    }
  } finally {
    await handle.close()
  }
}

/** The session-query members the pipelines use. */
export interface SessionQueryLike {
  /** Trace one session's ancestry and descendants. */
  traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageLike>
  /** Read and replay-validate one complete session log without making it live. */
  readSession(sessionId: SessionId): Promise<SessionLogSnapshotLike>
}

/** The lineage trace shape the pipelines flatten. */
export interface SessionLineageLike {
  readonly complete: boolean
  readonly target: { readonly header: SessionHeader }
  readonly descendants: readonly SessionLineageNodeLike[]
}

/** One recursive descendant node. */
export interface SessionLineageNodeLike {
  readonly session: { readonly header: SessionHeader }
  readonly descendants: readonly SessionLineageNodeLike[]
}

/** The detached session log snapshot shape the comparison reads. */
export interface SessionLogSnapshotLike {
  readonly session: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

/** One observed local session. */
export interface LocalSessionSnapshot {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

/**
 * Whether two event arrays agree element-wise. Events are adopted, deep-frozen
 * values; structural equality decides, so a byte-identical replay compares
 * equal regardless of object identity.
 * @param left - one array.
 * @param right - the other array.
 * @returns whether both arrays carry the same events in the same order.
 */
export function eventsEqual(left: readonly SessionEvent[], right: readonly SessionEvent[]): boolean {
  if (left.length !== right.length) return false
  for (const [index, event] of left.entries()) {
    if (!eventEquals(event, right[index] as SessionEvent)) return false
  }
  return true
}

/**
 * Whether one event array is a prefix of the other.
 * @param prefix - candidate prefix.
 * @param whole - candidate superset.
 * @returns whether every prefix event equals the whole's event at the same position.
 */
export function eventsArePrefix(prefix: readonly SessionEvent[], whole: readonly SessionEvent[]): boolean {
  if (prefix.length > whole.length) return false
  for (const [index, event] of prefix.entries()) {
    if (!eventEquals(event, whole[index] as SessionEvent)) return false
  }
  return true
}

/** Structural equality of one event pair, envelope and payload included. */
function eventEquals(left: SessionEvent, right: SessionEvent): boolean {
  return left.type === right.type
    && left.seq === right.seq
    && left.time === right.time
    && left.ignorable === right.ignorable
    && left.surfaceOp === right.surfaceOp
    && jsonEquals(left.sourceEventSeqs, right.sourceEventSeqs)
    && jsonEquals(left.data, right.data)
}

/** Structural equality of two JSON-shaped values. */
function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEquals(value, right[index]))
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord)
    if (leftKeys.length !== Object.keys(rightRecord).length) return false
    return leftKeys.every(key => Object.hasOwn(rightRecord, key) && jsonEquals(leftRecord[key], rightRecord[key]))
  }
  return false
}

/** The session-query member the comparison reads. */
export interface SessionQueryReadLike {
  /** Read and replay-validate one complete session log without making it live. */
  readSession(sessionId: SessionId): Promise<SessionLogSnapshotLike>
}

/**
 * Read one local session's live-preferred logical state for comparison.
 * @param sessionQuery - the composed session-query engine.
 * @param id - the session to observe.
 * @returns the detached header, inherited cut, and event log.
 * @throws {Error} when the session is absent or its history fails replay validation.
 */
export async function readLocalSession(
  sessionQuery: SessionQueryReadLike,
  id: SessionId,
): Promise<LocalSessionSnapshot> {
  const snapshot = await sessionQuery.readSession(id)
  return {
    header: snapshot.session,
    inheritedEventCount: snapshot.inheritedEventCount,
    events: snapshot.events,
  }
}
