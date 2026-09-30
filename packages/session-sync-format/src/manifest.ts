/** Tree-manifest encode, decode, and structural validation for the sync package. @module @deepseek-ai/dsh-session-sync-format/manifest */

import type {
  SyncAttachmentEntry,
  SyncEventObject,
  SyncSessionEntry,
  SyncTreeFile,
  SyncTreeManifest,
} from './types.ts'
import { SYNC_FORMAT_VERSION, SyncFormatError } from './types.ts'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { requireAttachmentDigest, requireDigestPath, sha256HexText } from './digest.ts'
import { decodePortableCwd } from './portable-cwd.ts'

/** Characters a filesystem path segment cannot carry; root ids are host-minted but the brand allows any string. */
const UNSAFE_SEGMENT = /[^A-Za-z0-9_-]/gu

/**
 * Reduce one session id to one safe tree-bucket segment. Distinct host-minted
 * ids never collide; a hostile id loses its separators before it can leave the
 * bucket.
 * @param id - raw session id.
 * @returns a filesystem-safe single path segment.
 */
export function treeBucketSegment(id: string): string {
  const segment = id.replace(UNSAFE_SEGMENT, '_')
  return segment === '' ? '_' : segment
}

/**
 * Canonical JSON encoding of one value: stable key order as constructed, no
 * indentation, one trailing newline.
 * @param value - manifest or other JSON-serializable payload.
 * @returns the canonical text bytes.
 */
export function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`)
}

/**
 * Encode one tree manifest and return its bytes beside the tree revision the
 * canonical bytes hash to.
 * @param manifest - validated manifest to encode.
 * @returns the canonical bytes and their SHA-256 tree revision hash.
 */
export function encodeTreeManifest(manifest: SyncTreeManifest): { bytes: Uint8Array; revisionHash: string } {
  const bytes = encodeCanonicalJson(manifest)
  return { bytes, revisionHash: sha256HexText(new TextDecoder().decode(bytes)) }
}

/**
 * Validate the structural shape of one event-object reference.
 * @param value - candidate `events` field.
 * @returns the validated reference.
 * @throws {SyncFormatError} when the count or digest is not a valid reference.
 */
function requireEventObject(value: unknown): SyncEventObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyncFormatError('session entry events must be an object')
  }
  const record = value as { count?: unknown; object?: unknown }
  if (typeof record.count !== 'number' || !Number.isSafeInteger(record.count) || record.count < 0) {
    throw new SyncFormatError('session entry event count must be a non-negative safe integer')
  }
  return { count: record.count, object: requireDigestPath(record.object, 'event object digest') }
}

/**
 * Validate one decoded attachment reference against its declared kind: image
 * references carry intrinsic display metadata, file references carry the
 * sanitized stored name and byte length.
 * @param kind - declared attachment kind.
 * @param ref - candidate reference.
 * @returns the validated reference.
 * @throws {SyncFormatError} when the reference does not match its kind.
 */
function requireAttachmentRef(kind: 'image' | 'file', ref: unknown): ImageAttachmentRef | FileAttachmentRef {
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
    throw new SyncFormatError('attachment entry ref must be an object')
  }
  const record = ref as Record<string, unknown>
  requireAttachmentDigest(record.attachmentId, 'attachment id')
  if (kind === 'image') {
    if (typeof record.mediaType !== 'string' || typeof record.width !== 'number'
      || typeof record.height !== 'number' || typeof record.bytes !== 'number'
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0
      || !Number.isSafeInteger(record.width) || record.width < 0
      || !Number.isSafeInteger(record.height) || record.height < 0) {
      throw new SyncFormatError('image attachment reference carries invalid metadata')
    }
    return record as unknown as ImageAttachmentRef
  }
  if (typeof record.name !== 'string' || record.name === ''
    || typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
    throw new SyncFormatError('file attachment reference carries invalid metadata')
  }
  return record as unknown as FileAttachmentRef
}

/**
 * Validate one decoded attachment entry.
 * @param value - candidate entry.
 * @returns the validated entry.
 * @throws {SyncFormatError} when the kind, reference, or digest is invalid.
 */
function requireAttachmentEntry(value: unknown): SyncAttachmentEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyncFormatError('attachment entry must be an object')
  }
  const record = value as { kind?: unknown; ref?: unknown; object?: unknown }
  if (record.kind !== 'image' && record.kind !== 'file') {
    throw new SyncFormatError('attachment entry kind must be "image" or "file"')
  }
  return {
    kind: record.kind,
    ref: requireAttachmentRef(record.kind, record.ref),
    object: requireDigestPath(record.object, 'attachment object digest'),
  }
}

/**
 * Validate one decoded session entry: header fields, the seeded/cut
 * relationship, and the event-object reference. The portable cwd is decoded
 * structurally; whether this device can address it is the import precheck's
 * decision, not a manifest validity question.
 * @param value - candidate entry.
 * @returns the validated entry.
 * @throws {SyncFormatError} when any field fails validation.
 */
function requireSessionEntry(value: unknown): SyncSessionEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyncFormatError('manifest session entry must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId === '') {
    throw new SyncFormatError('session entry id must be a non-empty string')
  }
  const headerValue = record.header
  if (typeof headerValue !== 'object' || headerValue === null || Array.isArray(headerValue)) {
    throw new SyncFormatError('session entry header must be an object')
  }
  const header = headerValue as Record<string, unknown>
  if (typeof header.createdAt !== 'number' || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0) {
    throw new SyncFormatError('session header createdAt must be a non-negative safe integer')
  }
  if (typeof header.isSeeded !== 'boolean') {
    throw new SyncFormatError('session header isSeeded must be a boolean')
  }
  // Structural decode only: an unaddressable component skips the tree at import
  // time instead of making the published package malformed.
  if (header.cwd !== undefined) decodePortableCwd(header.cwd)
  if (header.parentSession !== undefined
    && (typeof header.parentSession !== 'string' || header.parentSession === '')) {
    throw new SyncFormatError('session header parentSession must be a non-empty string when present')
  }
  if (header.delegationDepth !== undefined
    && (typeof header.delegationDepth !== 'number' || !Number.isSafeInteger(header.delegationDepth)
      || header.delegationDepth < 0)) {
    throw new SyncFormatError('session header delegationDepth must be a non-negative safe integer when present')
  }
  if (header.origin !== undefined && header.origin !== 'subagent') {
    throw new SyncFormatError('session header origin must be "subagent" when present')
  }
  if (header.agentPreset !== undefined
    && (typeof header.agentPreset !== 'string' || header.agentPreset === '')) {
    throw new SyncFormatError('session header agentPreset must be a non-empty string when present')
  }
  if (typeof record.inheritedEventCount !== 'number'
    || !Number.isSafeInteger(record.inheritedEventCount) || record.inheritedEventCount < 0) {
    throw new SyncFormatError('session entry inheritedEventCount must be a non-negative safe integer')
  }
  if (!header.isSeeded && record.inheritedEventCount !== 0) {
    throw new SyncFormatError('unseeded session entry carries inherited events')
  }
  return {
    sessionId: record.sessionId,
    header: header as unknown as SyncSessionEntry['header'],
    inheritedEventCount: record.inheritedEventCount,
    events: requireEventObject(record.events),
    ...(record.attachments === undefined
      ? {}
      : { attachments: (record.attachments as readonly unknown[]).map(requireAttachmentEntry) }),
  }
}

/**
 * Decode and validate one tree manifest from canonical bytes. A foreign
 * format version refuses without guessing at compatibility. Structural checks
 * cover field types, identity, the parent-before-child order, lineage closure,
 * and every object digest reference; the objects themselves are read and
 * digest-checked by the caller, and whether this device can address a portable
 * cwd is the import precheck's decision.
 * @param bytes - the manifest file's bytes.
 * @param claimedRootSessionId - root id bucket the file was found in.
 * @returns the validated manifest.
 * @throws {SyncFormatError} when the bytes are not a valid current-format manifest.
 */
export function decodeTreeManifest(bytes: Uint8Array, claimedRootSessionId: string): SyncTreeManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new SyncFormatError('tree manifest is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyncFormatError('tree manifest must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  if (record.type !== 'dsh-session-tree') {
    throw new SyncFormatError('tree manifest type must be "dsh-session-tree"')
  }
  if (record.formatVersion !== SYNC_FORMAT_VERSION) {
    throw new SyncFormatError(
      `unsupported sync-package format version ${JSON.stringify(record.formatVersion)}; this build reads v${SYNC_FORMAT_VERSION}`,
    )
  }
  if (typeof record.rootSessionId !== 'string' || record.rootSessionId === '') {
    throw new SyncFormatError('tree manifest rootSessionId must be a non-empty string')
  }
  if (record.rootSessionId !== claimedRootSessionId) {
    throw new SyncFormatError('tree manifest root does not match its tree bucket')
  }
  if (!Array.isArray(record.sessions) || record.sessions.length === 0) {
    throw new SyncFormatError('tree manifest must carry at least the root session')
  }
  const sessions = record.sessions.map(entry => requireSessionEntry(entry))
  const ids = new Set<string>()
  const positions = new Map<string, number>()
  for (const [index, entry] of sessions.entries()) {
    if (ids.has(entry.sessionId)) {
      throw new SyncFormatError(`tree manifest carries duplicate session id "${entry.sessionId}"`)
    }
    ids.add(entry.sessionId)
    positions.set(entry.sessionId, index)
  }
  const root = sessions[0] as SyncSessionEntry
  if (root.sessionId !== record.rootSessionId) {
    throw new SyncFormatError('tree manifest must carry the root session first')
  }
  if (root.header.parentSession !== undefined) {
    throw new SyncFormatError('the root session of a tree manifest carries no parent')
  }
  for (const entry of sessions) {
    if (entry.header.parentSession === undefined) continue
    const parentAt = positions.get(entry.header.parentSession)
    if (parentAt === undefined) {
      throw new SyncFormatError(`session "${entry.sessionId}" names a parent outside the manifest`)
    }
    if (parentAt >= (positions.get(entry.sessionId) as number)) {
      throw new SyncFormatError(`session "${entry.sessionId}" appears before its parent`)
    }
  }
  return {
    type: 'dsh-session-tree',
    formatVersion: SYNC_FORMAT_VERSION,
    rootSessionId: record.rootSessionId,
    sessions,
  }
}

/**
 * Validate one tree-file path claim: the revision name must be the lowercase
 * SHA-256 of the file's bytes.
 * @param bytes - the manifest file's bytes.
 * @param revisionHash - digest claimed by the file name.
 * @returns nothing after successful validation.
 * @throws {SyncFormatError} when the claimed digest does not match the bytes.
 */
export function requireTreeRevision(bytes: Uint8Array, revisionHash: string): void {
  requireDigestPath(revisionHash, 'tree revision')
  const actual = sha256HexText(new TextDecoder().decode(bytes))
  if (actual !== revisionHash) {
    throw new SyncFormatError(`tree manifest bytes do not match their revision digest (${revisionHash})`)
  }
}

/**
 * Build the tree-file record for one manifest path: the revision digest and
 * root bucket are path claims the caller validates after reading the file.
 * @param file - absolute manifest path.
 * @param rootSessionId - root id bucket.
 * @param revisionHash - digest claimed by the file name.
 * @returns the tree-file record.
 */
export function treeFileOf(file: string, rootSessionId: string, revisionHash: string): SyncTreeFile {
  return { rootSessionId, revisionHash, path: file }
}
