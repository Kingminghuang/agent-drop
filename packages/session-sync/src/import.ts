/** Import pipeline: validate, compare, and write one tree's sessions. @module @deepseek-ai/dsh-session-sync/import */

import { mkdir, realpath, stat } from 'node:fs/promises'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { materializeAppendBatch } from '@deepseek-ai/dsh-session-persistence'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import {
  decodeEventObject,
  decodeTreeManifest,
  encodePortableCwd,
  hostPlatform,
  isAddressablePortableCwd,
  isUnderHome,
  resolvePortableCwd,
  canonicalHome,
  validatePortableCwd,
  type PortableCwd,
  type SyncAttachmentEntry,
  type SyncSessionEntry,
  type SyncTreeFile,
  type SyncTreeManifest,
} from '@deepseek-ai/dsh-session-sync-format'
import type { SessionSyncBackend, SessionSyncRoot } from './backend.ts'
import { SyncObjectMissingError } from './backend.ts'
import { eventsArePrefix, eventsEqual, signalOptions } from './observe.ts'
import { localRestoreRoot, restoreImage } from './restore-image.ts'
import type { SyncSessionBinding, SyncSessionResult, SyncTreeResult } from './types.ts'

/** The host members the import pipeline reads. */
export interface ImportDeps {
  /** Live-session store; a live session refuses the write path. */
  readonly sessions: SessionStore | undefined
  /** Mounted persistence backend. */
  readonly sessionPersistence: SessionPersistence
  /** Composed session-query engine; reads local history for comparison. */
  readonly sessionQuery: SessionQueryEngine
  /** Mounted attachment store. */
  readonly attachments: AttachmentStore | undefined
  /** Composed workspace registry. */
  readonly workspaceRegistry: WorkspaceRegistry | undefined
  /** Prepared storage backend. */
  readonly backend: SessionSyncBackend
  /** Prepared sync root. */
  readonly root: SessionSyncRoot
}

/** One session's validated import state: manifest entry beside its decoded events. */
export interface ValidatedSession {
  /** The manifest entry. */
  readonly entry: SyncSessionEntry
  /** The decoded events. */
  readonly events: readonly SessionEvent[]
}

/** One directory the import pass prepared on this device. */
export interface PreparedDirectory {
  /** The canonical absolute directory. */
  readonly path: string
  /** Whether this pass created it. */
  readonly created: boolean
  /** The workspace binding, when the registry is composed. */
  readonly workspace: Workspace | undefined
}

/** Outcome of validating one tree's objects before anything is written. */
export interface TreeValidation {
  /** Sessions whose every object is present and verified, in manifest order. */
  readonly validated: readonly ValidatedSession[]
  /** Sessions waiting for objects to arrive. */
  readonly pendingSessionIds: readonly string[]
}

/**
 * Read and validate one tree manifest file: the revision digest must match the
 * bytes, and the manifest must decode under the host platform's component rules.
 * @param backend - the prepared storage backend.
 * @param root - the prepared sync root.
 * @param file - the tree file to read.
 * @param signal - optional cancellation.
 * @returns the validated manifest.
 * @throws {Error} when the file is unreadable or its manifest is invalid.
 */
export async function readValidatedManifest(
  backend: SessionSyncBackend,
  root: SessionSyncRoot,
  file: SyncTreeFile,
  signal?: AbortSignal,
): Promise<SyncTreeManifest> {
  const bytes = await backend.readTree(root, file, signalOptions(signal))
  return decodeTreeManifest(bytes, file.rootSessionId)
}

/**
 * Validate one manifest session entry's portable cwd against the target
 * platform: the encoding must decode and every component must join a path.
 * @param entry - one manifest session entry.
 * @returns nothing after successful validation.
 * @throws {SyncFormatError} when the portable cwd cannot address a directory here.
 */
export function precheckPortableCwd(entry: SyncSessionEntry): void {
  if (entry.header.cwd !== undefined) validatePortableCwd(entry.header.cwd, hostPlatform)
}

/**
 * Whole-tree portable cwd precheck, run before any directory, workspace,
 * session, or attachment is created. One unaddressable component skips the
 * entire tree: nothing is written and nothing is reported as imported.
 * @param manifest - the validated manifest.
 * @returns the skip reason, or `undefined` when every portable cwd is addressable here.
 */
export function portableCwdSkipReason(manifest: SyncTreeManifest): string | undefined {
  for (const entry of manifest.sessions) {
    const cwd = entry.header.cwd
    if (cwd === undefined) continue
    if (!isAddressablePortableCwd(cwd, hostPlatform)) {
      return `session '${entry.sessionId}' carries a working directory this device cannot address`
    }
  }
  return undefined
}

/**
 * Validate one tree fully before anything is written: every session's event
 * object and attachment objects must exist with correct digests, and every
 * portable cwd must address a directory on this platform. A present object
 * that fails validation throws; an absent object marks its session pending.
 * @param deps - import dependencies.
 * @param manifest - the validated manifest.
 * @param signal - optional cancellation.
 * @returns the per-session validation outcome.
 * @throws {Error} when any referenced object is present but fails validation.
 */
export async function validateTree(
  deps: ImportDeps,
  manifest: SyncTreeManifest,
  signal?: AbortSignal,
): Promise<TreeValidation> {
  const validated: ValidatedSession[] = []
  const pendingSessionIds: string[] = []
  for (const entry of manifest.sessions) {
    signal?.throwIfAborted()
    precheckPortableCwd(entry)
    let events: readonly SessionEvent[]
    try {
      const bytes = await deps.backend.readObject(deps.root, 'events', entry.events.object, signalOptions(signal))
      events = decodeEventObject(bytes, entry.events)
    } catch (error: unknown) {
      if (error instanceof SyncObjectMissingError) {
        pendingSessionIds.push(entry.sessionId)
        continue
      }
      throw error
    }
    let attachmentsArrived = true
    for (const attachment of entry.attachments ?? []) {
      try {
        await deps.backend.readObject(deps.root, 'attachments', attachment.object, signalOptions(signal))
      } catch (error: unknown) {
        if (error instanceof SyncObjectMissingError) {
          attachmentsArrived = false
          break
        }
        throw error
      }
    }
    if (attachmentsArrived) validated.push({ entry, events })
    else pendingSessionIds.push(entry.sessionId)
  }
  return { validated, pendingSessionIds }
}

/**
 * Prepare one target directory on this device: resolve the portable cwd,
 * create the directory when missing, canonicalize through `realpath`, verify
 * home containment, and reuse or create the workspace record.
 * @param cwd - the validated portable cwd.
 * @param workspaceRegistry - the composed registry, or `undefined`.
 * @param signal - optional cancellation.
 * @returns the prepared directory.
 * @throws {Error} when the directory cannot be created, leaves home, or the workspace refuses.
 */
export async function prepareDirectory(
  cwd: PortableCwd,
  workspaceRegistry: WorkspaceRegistry | undefined,
  signal?: AbortSignal,
): Promise<PreparedDirectory> {
  signal?.throwIfAborted()
  const home = await canonicalHome()
  const absolute = await resolvePortableCwd(cwd, home)
  const created = !(await pathExists(absolute))
  if (created) await mkdir(absolute, { recursive: true, mode: 0o700 })
  const canonical = await realpath(absolute)
  if (!isUnderHome(canonical, home)) {
    throw new Error(`resolved directory '${canonical}' is outside the current user's home`)
  }
  const workspace = workspaceRegistry === undefined ? undefined : await workspaceRegistry.create(canonical)
  return { path: canonical, created, workspace }
}

/** Whether one absolute path exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Restore one session's attachments through the mounted store: images are
 * published with their recorded reference into the content-addressed local
 * root, files are committed verbatim under their recorded name. A produced
 * reference that differs from the manifest entry fails the session.
 *
 * When the mounted provider cannot restore attachments in place — no store
 * composed, or anything other than the content-addressed local store — the
 * whole restore silently gives up: no objects are read, no attachments land,
 * and the session's events import as usual.
 * @param deps - import dependencies.
 * @param entries - the manifest attachment entries.
 * @param signal - optional cancellation.
 * @returns nothing after every attachment is durably published, or immediately when restore is unavailable.
 * @throws {Error} when a read fails or a produced reference differs.
 */
export async function restoreAttachments(
  deps: ImportDeps,
  entries: readonly SyncAttachmentEntry[],
  signal?: AbortSignal,
): Promise<void> {
  const root = localRestoreRoot(deps.attachments)
  if (root === undefined) return
  const attachments = deps.attachments as AttachmentStore
  for (const entry of entries) {
    signal?.throwIfAborted()
    const bytes = await deps.backend.readObject(deps.root, 'attachments', entry.object, signalOptions(signal))
    if (entry.kind === 'image') {
      await restoreImage(root, { ref: entry.ref as ImageAttachmentRef, data: bytes })
      continue
    }
    const recorded = entry.ref as FileAttachmentRef
    const produced = await attachments.saveFile({ data: bytes, name: recorded.name })
    if (String(produced.attachmentId) !== String(recorded.attachmentId)
      || produced.name !== recorded.name
      || produced.bytes !== recorded.bytes) {
      throw new Error(`restored file attachment '${recorded.name}' does not match its recorded reference`)
    }
  }
}

/**
 * Whether two sync headers agree on every identity field. Portable cwd,
 * delegation depth, and the inherited cut compare in their normalized forms,
 * so an unchanged logical history never reads as a fork over a path spelling.
 * @param local - the local header with its absolute cwd.
 * @param remote - the manifest header with its portable cwd.
 * @param localPortable - the local header's portable cwd, or `undefined` when unrepresentable.
 * @returns whether every compared field agrees.
 */
export function headersEqual(
  local: SessionHeader,
  remote: SyncSessionEntry['header'],
  localPortable: PortableCwd | undefined,
): boolean {
  if (local.createdAt !== remote.createdAt) return false
  if (!cwdEqual(local.cwd, localPortable, remote.cwd)) return false
  if (!optionalStringEqual(local.parentSession, remote.parentSession)) return false
  if (local.isSeeded !== remote.isSeeded) return false
  if (!optionalStringEqual(local.origin, remote.origin)) return false
  if ((local.delegationDepth ?? 0) !== (remote.delegationDepth ?? 0)) return false
  return optionalStringEqual(local.agentPreset, remote.agentPreset)
}

/** Structural equality of one portable cwd against the local absolute spelling. */
function cwdEqual(
  localCwd: string | undefined,
  localPortable: PortableCwd | undefined,
  remote: PortableCwd | undefined,
): boolean {
  if (localCwd === undefined && remote === undefined) return true
  if (localCwd !== undefined && localPortable === undefined) return false
  if (localPortable === undefined || remote === undefined) return false
  if (localPortable.components.length !== remote.components.length) return false
  return localPortable.components.every((component, index) => component === remote.components[index])
}

/** Optional-string equality treating undefined and empty identically. */
function optionalStringEqual(local: string | undefined, remote: string | undefined): boolean {
  const left = local === undefined || local === '' ? undefined : local
  const right = remote === undefined || remote === '' ? undefined : remote
  return left === right
}

/**
 * Compare one local session against one validated remote session.
 * @param local - the observed local session, or `undefined` when absent.
 * @param remoteEvents - the decoded remote events.
 * @param remoteEntry - the manifest entry.
 * @param localPortable - the local header's portable cwd, or `undefined`.
 * @returns the comparison verdict: append the suffix, skip, or keep a conflict.
 */
export function compareSessions(
  local: LocalSessionSnapshot | undefined,
  remoteEvents: readonly SessionEvent[],
  remoteEntry: SyncSessionEntry,
  localPortable: PortableCwd | undefined,
): 'skip' | 'append' | 'conflict' {
  if (local === undefined) return 'append'
  if (eventsEqual(local.events, remoteEvents)) {
    return headersEqual(local.header, remoteEntry.header, localPortable) ? 'skip' : 'conflict'
  }
  if (eventsArePrefix(local.events, remoteEvents)) {
    return headersEqual(local.header, remoteEntry.header, localPortable) ? 'append' : 'conflict'
  }
  if (eventsArePrefix(remoteEvents, local.events)) {
    return headersEqual(local.header, remoteEntry.header, localPortable) ? 'skip' : 'conflict'
  }
  return 'conflict'
}

/**
 * Write one session's history through the persistence backend. A live session
 * is compared without taking its write handle; every other write reconfirms
 * the local history through the handle itself before appending, so a retry
 * continues from the current local history without repeating events.
 * @param deps - import dependencies.
 * @param id - the session identity.
 * @param remoteEntry - the manifest entry.
 * @param remoteEvents - the decoded remote events.
 * @param header - the resolved local header (absolute cwd).
 * @param signal - optional cancellation.
 * @returns the per-session write outcome without the binding.
 * @throws {Error} when the persistence backend refuses the write.
 */
export async function writeSessionHistory(
  deps: ImportDeps,
  id: SessionId,
  remoteEntry: SyncSessionEntry,
  remoteEvents: readonly SessionEvent[],
  header: SessionHeader,
  signal?: AbortSignal,
): Promise<Omit<SyncSessionResult, 'sessionId' | 'binding'>> {
  const live = deps.sessions?.get(id)
  if (live !== undefined) return await liveSessionVerdict(deps, id, remoteEntry, remoteEvents, live)
  const local = await observeLocal(deps, id)
  const portable = await localPortableOf(header)
  const verdict = compareSessions(local, remoteEvents, remoteEntry, portable)
  if (verdict === 'skip') return skipResult(local?.events.length, remoteEvents.length)
  if (verdict === 'conflict') return conflictResult(local, remoteEvents)
  let handle: SessionHandle | undefined
  try {
    handle = await deps.sessionPersistence.create(header, {
      inheritedEventCount: SessionLogOffset(remoteEntry.inheritedEventCount),
    })
  } catch (error: unknown) {
    if (!(error instanceof Error && error.name === 'SessionAlreadyExistsError')) throw error
  }
  if (handle === undefined) {
    return await appendThroughOpen(deps, id, remoteEntry, remoteEvents, header, signal)
  }
  try {
    await handle.append(materializeAppendBatch(remoteEvents))
    await handle.flush(signalOptions(signal))
  } finally {
    await handle.close()
  }
  return { status: 'created', remoteEvents: remoteEvents.length }
}

/** The skip outcome: the local history already covers the package. */
function skipResult(
  localEvents: number | undefined,
  remoteEvents: number,
): Omit<SyncSessionResult, 'sessionId' | 'binding'> {
  return {
    status: 'skipped',
    ...(localEvents === undefined ? {} : { localEvents }),
    remoteEvents,
  }
}

/** The verdict path for a live session: compare without taking the write handle. */
async function liveSessionVerdict(
  deps: ImportDeps,
  id: SessionId,
  remoteEntry: SyncSessionEntry,
  remoteEvents: readonly SessionEvent[],
  live: Session,
): Promise<Omit<SyncSessionResult, 'sessionId' | 'binding'>> {
  const local = await observeLocal(deps, id)
  const portable = await localPortableOf(live.header)
  const verdict = compareSessions(local, remoteEvents, remoteEntry, portable)
  if (verdict === 'skip') return skipResult(local?.events.length, remoteEvents.length)
  return {
    status: 'failed',
    reason: `session '${String(id)}' is live; its write handle is held by the running agent`,
    ...(local === undefined ? {} : { localEvents: local.events.length }),
    remoteEvents: remoteEvents.length,
  }
}

/**
 * Append one remote suffix through an existing session's write handle,
 * reconfirming the local history through that handle before the append.
 * @param deps - import dependencies.
 * @param id - the session identity.
 * @param remoteEntry - the manifest entry.
 * @param remoteEvents - the decoded remote events.
 * @param header - the stored header the handle carries.
 * @param signal - optional cancellation.
 * @returns the per-session write outcome.
 * @throws {Error} when the handle cannot be taken or the append fails.
 */
export async function appendThroughOpen(
  deps: ImportDeps,
  id: SessionId,
  remoteEntry: SyncSessionEntry,
  remoteEvents: readonly SessionEvent[],
  header: SessionHeader,
  signal?: AbortSignal,
): Promise<Omit<SyncSessionResult, 'sessionId' | 'binding'>> {
  let handle: SessionHandle
  try {
    handle = await deps.sessionPersistence.open(id, 'write', signalOptions(signal))
  } catch (error: unknown) {
    if (error instanceof SyncObjectMissingError) {
      return {
        status: 'failed',
        reason: `session '${String(id)}' vanished between compare and write: ${error.message}`,
        remoteEvents: remoteEvents.length,
      }
    }
    return {
      status: 'failed',
      reason: `session '${String(id)}' write ownership is held: ${renderThrown(error)}`,
      remoteEvents: remoteEvents.length,
    }
  }
  try {
    const stored = await handle.read(0, undefined, signalOptions(signal))
    const portable = await localPortableOf(header)
    const verdict = compareSessions(
      {
        header: handle.header,
        inheritedEventCount: handle.inheritedEventCount,
        events: stored.events,
      },
      remoteEvents,
      remoteEntry,
      portable,
    )
    if (verdict === 'skip') return skipResult(stored.events.length, remoteEvents.length)
    if (verdict === 'conflict') return conflictResult(
      {
        header: handle.header,
        inheritedEventCount: handle.inheritedEventCount,
        events: stored.events,
      },
      remoteEvents,
    )
    const suffix = remoteEvents.slice(stored.events.length)
    await handle.append(materializeAppendBatch(suffix))
    await handle.flush(signalOptions(signal))
    return { status: 'appended', localEvents: stored.events.length, remoteEvents: remoteEvents.length }
  } finally {
    await handle.close()
  }
}

/**
 * The tree outcome that one import pass reports: a single failed session fails
 * the tree, a conflict keeps it visible as a conflict, an unreached object or a
 * fully skipped pass reports that instead of a success.
 * @param sessions - the per-session outcomes in manifest order.
 * @returns the tree status.
 */
function treeStatusOf(sessions: readonly SyncSessionResultDraft[]): SyncTreeResult['status'] {
  if (sessions.some(session => session.status === 'failed')) return 'failed'
  if (sessions.some(session => session.status === 'conflict')) return 'conflict'
  if (sessions.some(session => session.status === 'pending')) return 'pending'
  if (sessions.length > 0 && sessions.every(session => session.status === 'skipped')) return 'skipped'
  return 'imported'
}

/** One observed local session. */
interface LocalSessionSnapshot {
  /** Stored header. */
  readonly header: SessionHeader
  /** Exact inherited cut. */
  readonly inheritedEventCount: SessionHandle['inheritedEventCount']
  /** Validated events in seq order. */
  readonly events: readonly SessionEvent[]
}

/** Read one local session through the session-query engine; absence stays undefined. */
async function observeLocal(deps: ImportDeps, id: SessionId): Promise<LocalSessionSnapshot | undefined> {
  try {
    const snapshot = await deps.sessionQuery.readSession(id)
    return {
      header: snapshot.session,
      inheritedEventCount: snapshot.inheritedEventCount,
      events: snapshot.events,
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'SessionQueryError'
      && (error as { code?: string }).code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
    throw error
  }
}

/** The local header's portable spelling, or undefined when it cannot be represented. */
async function localPortableOf(header: SessionHeader): Promise<PortableCwd | undefined> {
  if (header.cwd === undefined) return undefined
  return await encodePortableCwd(header.cwd)
}

/** The conflict outcome: both versions are kept, nothing is written. */
function conflictResult(
  local: LocalSessionSnapshot | undefined,
  remoteEvents: readonly SessionEvent[],
): Omit<SyncSessionResult, 'sessionId' | 'binding'> {
  return {
    status: 'conflict',
    reason: 'the local history and the sync package diverge; keeping both versions',
    ...(local === undefined ? {} : { localEvents: local.events.length }),
    remoteEvents: remoteEvents.length,
  }
}

/**
 * Run one import pass over one tree manifest file: read and validate the
 * manifest, verify every referenced object, precheck every portable cwd,
 * prepare each target directory and workspace, then compare and write each
 * session in manifest order. Nothing unwritten is claimed: a session
 * interrupted mid-write continues on retry from the current local history.
 * @param deps - import dependencies.
 * @param file - the tree file to import.
 * @param signal - optional cancellation.
 * @returns the tree's result.
 */
export async function runImportTree(
  deps: ImportDeps,
  file: SyncTreeFile,
  signal?: AbortSignal,
): Promise<SyncTreeResult> {
  signal?.throwIfAborted()
  let manifest: SyncTreeManifest
  try {
    manifest = await readValidatedManifest(deps.backend, deps.root, file, signal)
  } catch (error: unknown) {
    return {
      rootSessionId: file.rootSessionId,
      status: 'failed',
      reason: `the tree manifest was refused: ${renderThrown(error)}`,
      sessions: [],
    }
  }
  // Whole-tree precheck before any local preparation: an unaddressable portable
  // cwd skips the tree instead of failing it, and nothing is created.
  const skipReason = portableCwdSkipReason(manifest)
  if (skipReason !== undefined) {
    return {
      rootSessionId: file.rootSessionId,
      status: 'skipped',
      reason: skipReason,
      sessions: manifest.sessions.map(entry => ({
        sessionId: entry.sessionId,
        status: 'skipped',
        reason: skipReason,
        remoteEvents: entry.events.count,
      })),
    }
  }
  let validation: TreeValidation
  try {
    validation = await validateTree(deps, manifest, signal)
  } catch (error: unknown) {
    return {
      rootSessionId: file.rootSessionId,
      status: 'failed',
      reason: `the tree was refused before any write: ${renderThrown(error)}`,
      sessions: [],
    }
  }
  const directories = new Map<string, PreparedDirectory>()
  const preparedDirectories: SyncCreatedDirectoryDraft[] = []
  const completedSteps: string[] = []
  const sessions: SyncSessionResultDraft[] = []
  try {
    for (const pending of validation.pendingSessionIds) {
      sessions.push({
        sessionId: pending,
        status: 'pending',
        reason: 'the sync package has not arrived completely; retry after the cloud client finishes transferring',
      })
    }
    for (const { entry } of validation.validated) {
      if (entry.header.cwd === undefined) continue
      const portable = validatePortableCwd(entry.header.cwd, hostPlatform)
      const key = portableKey(portable)
      if (directories.has(key)) continue
      const prepared = await prepareDirectory(portable, deps.workspaceRegistry, signal)
      directories.set(key, prepared)
      preparedDirectories.push({ path: prepared.path })
      completedSteps.push(`${prepared.created ? 'created' : 'reused'} directory ${prepared.path}`)
      if (prepared.workspace !== undefined) completedSteps.push(`workspace ready ${prepared.path}`)
    }
    for (const { entry, events } of validation.validated) {
      signal?.throwIfAborted()
      const prepared = entry.header.cwd === undefined
        ? undefined
        : directories.get(portableKey(validatePortableCwd(entry.header.cwd, hostPlatform)))
      await restoreAttachments(deps, entry.attachments ?? [], signal)
      const written = await writeSessionHistory(
        deps,
        entry.sessionId as SessionId,
        entry,
        events,
        resolvedHeaderOf(entry, prepared?.path),
        signal,
      )
      sessions.push({
        sessionId: entry.sessionId,
        ...written,
        ...(prepared === undefined ? {} : await bindingOf(entry, prepared, written.status)),
      })
    }
    const status = treeStatusOf(sessions)
    const outcomeReason = status === 'imported'
      ? undefined
      : sessions.find(session => session.status === status)?.reason
    return {
      rootSessionId: file.rootSessionId,
      status,
      ...(outcomeReason === undefined ? {} : { reason: outcomeReason }),
      sessions,
      createdDirectories: await Promise.all(preparedDirectories.map(async directory => ({
        path: directory.path,
        empty: await isEmptyDirectory(directory.path),
      }))),
    }
  } catch (error: unknown) {
    return {
      rootSessionId: file.rootSessionId,
      status: 'failed',
      reason: renderThrown(error),
      sessions,
      completedSteps,
    }
  }
}

/** Draft of one auto-created directory before its emptiness is measured. */
interface SyncCreatedDirectoryDraft {
  /** Absolute local directory path. */
  readonly path: string
}

/** Draft of one session result before its binding settles. */
type SyncSessionResultDraft = Omit<SyncSessionResult, 'binding'> & {
  /** Binding outcome, appended once the write settles. */
  readonly binding?: SyncSessionBinding
}

/** Map key of one portable cwd: its slash-joined component path. */
function portableKey(portable: PortableCwd): string {
  return portable.components.join('/')
}

/** Project one manifest entry into the local header beside its resolved directory. */
function resolvedHeaderOf(entry: SyncSessionEntry, dirPath: string | undefined): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: entry.sessionId as SessionId,
    createdAt: entry.header.createdAt,
    ...(dirPath === undefined ? {} : { cwd: dirPath }),
    ...(entry.header.parentSession === undefined ? {} : { parentSession: entry.header.parentSession as SessionId }),
    isSeeded: entry.header.isSeeded,
    ...(entry.header.origin === undefined ? {} : { origin: entry.header.origin }),
    delegationDepth: entry.header.delegationDepth ?? 0,
    ...(entry.header.agentPreset === undefined ? {} : { agentPreset: entry.header.agentPreset }),
  }
}

/**
 * Bind one written session to its workspace.
 * @param entry - the manifest entry.
 * @param prepared - the prepared directory.
 * @param status - the write outcome; only written sessions bind.
 * @returns the binding outcome.
 */
async function bindingOf(
  entry: SyncSessionEntry,
  prepared: PreparedDirectory,
  status: SyncSessionResult['status'],
): Promise<{ readonly binding: SyncSessionBinding }> {
  if (status !== 'created' && status !== 'appended') {
    return { binding: { attached: false, reason: 'the session was not written in this pass' } }
  }
  if (prepared.workspace === undefined) {
    return { binding: { attached: false, reason: 'no workspace registry is composed' } }
  }
  try {
    await prepared.workspace.attachSession(entry.sessionId as SessionId)
    return { binding: { attached: true } }
  } catch (error: unknown) {
    return {
      binding: {
        attached: false,
        reason: renderThrown(error),
      },
    }
  }
}

/** Whether one directory holds no entries. */
async function isEmptyDirectory(path: string): Promise<boolean> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(path)
  return entries.length === 0
}

/** Render one arbitrary thrown value without trusting its string coercion. */
function renderThrown(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}
