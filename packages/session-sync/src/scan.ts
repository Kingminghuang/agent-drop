/** Scan pipeline: read every visible tree manifest and verify its objects without writing. @module @deepseek-ai/dsh-session-sync/scan */

import {
  decodeEventObject,
  decodeTreeManifest,
  hostPlatform,
  validatePortableCwd,
  type SyncSessionEntry,
  type SyncTreeFile,
  type SyncTreeManifest,
} from '@deepseek-ai/dsh-session-sync-format'
import type { SessionSyncBackend, SessionSyncRoot } from './backend.ts'
import { SyncObjectMissingError } from './backend.ts'
import { signalOptions } from './observe.ts'
import type { SyncSessionResult, SyncTreeResult } from './types.ts'

/** The host members the scan pipeline reads. */
export interface ScanDeps {
  /** Prepared storage backend. */
  readonly backend: SessionSyncBackend
  /** Prepared sync root. */
  readonly root: SessionSyncRoot
}

/**
 * Scan one tree manifest file: read and validate the manifest, then confirm
 * every referenced object is readable with the correct digest. Nothing is
 * written; the result tells an import whether the tree can proceed.
 * @param deps - scan dependencies.
 * @param file - the tree file to scan.
 * @param signal - optional cancellation.
 * @returns the tree's scan result.
 */
export async function scanTree(
  deps: ScanDeps,
  file: SyncTreeFile,
  signal?: AbortSignal,
): Promise<SyncTreeResult> {
  signal?.throwIfAborted()
  let manifest: SyncTreeManifest
  try {
    const bytes = await deps.backend.readTree(deps.root, file, signalOptions(signal))
    manifest = decodeTreeManifest(bytes, file.rootSessionId)
  } catch (error: unknown) {
    return {
      rootSessionId: file.rootSessionId,
      status: 'failed',
      reason: `the tree manifest was refused: ${renderThrown(error)}`,
      sessions: [],
    }
  }
  const sessions: SyncSessionResult[] = []
  let pending = false
  let skipped = false
  for (const entry of manifest.sessions) {
    signal?.throwIfAborted()
    const readiness = await scanSession(deps, entry, signal)
    sessions.push(readiness)
    if (readiness.status === 'pending') pending = true
    if (readiness.status === 'skipped') skipped = true
  }
  const status: SyncTreeResult['status'] = skipped ? 'skipped' : pending ? 'pending' : 'ready'
  const reason = skipped
    ? 'a session carries a working directory this device cannot address'
    : pending
      ? 'the sync package has not arrived completely'
      : undefined
  return {
    rootSessionId: file.rootSessionId,
    status,
    ...(reason === undefined ? {} : { reason }),
    sessions,
  }
}

/**
 * Confirm one session's objects: the event object and every attachment object
 * must be readable with the correct digest, and the portable cwd must address
 * a directory on this platform.
 * @param deps - scan dependencies.
 * @param entry - one manifest session entry.
 * @param signal - optional cancellation.
 * @returns the session's readiness row.
 */
async function scanSession(
  deps: ScanDeps,
  entry: SyncSessionEntry,
  signal?: AbortSignal,
): Promise<SyncSessionResult> {
  try {
    const bytes = await deps.backend.readObject(deps.root, 'events', entry.events.object, signalOptions(signal))
    decodeEventObject(bytes, entry.events)
    for (const attachment of entry.attachments ?? []) {
      await deps.backend.readObject(deps.root, 'attachments', attachment.object, signalOptions(signal))
    }
  } catch (error: unknown) {
    if (error instanceof SyncObjectMissingError) {
      return {
        sessionId: entry.sessionId,
        status: 'pending',
        reason: 'the sync package has not arrived completely',
        remoteEvents: entry.events.count,
      }
    }
    return {
      sessionId: entry.sessionId,
      status: 'failed',
      reason: renderThrown(error),
      remoteEvents: entry.events.count,
    }
  }
  if (entry.header.cwd !== undefined) {
    try {
      validatePortableCwd(entry.header.cwd, hostPlatform)
    } catch (error: unknown) {
      return {
        sessionId: entry.sessionId,
        status: 'skipped',
        reason: renderThrown(error),
        remoteEvents: entry.events.count,
      }
    }
  }
  return { sessionId: entry.sessionId, status: 'ready', remoteEvents: entry.events.count }
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
