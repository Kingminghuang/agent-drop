/** Event-object encoding and structural decoding for the sync package. @module @deepseek-ai/dsh-session-sync-format/events */

import { adoptSessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SyncEventObject } from './types.ts'
import { SyncFormatError } from './types.ts'
import { sha256Hex } from './digest.ts'

/** Envelope keys one encoded logical event may carry. */
const EVENT_ENVELOPE_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])

/**
 * Encode one session's events as the sync event object: one canonical logical
 * event per line in seq order, with a trailing newline. The bytes are named
 * by their own SHA-256.
 * @param events - the session's complete validated event log, in seq order.
 * @returns the object bytes beside the digest the manifest must carry.
 */
export function encodeEventObject(events: readonly SessionEvent[]): { bytes: Uint8Array; object: string } {
  if (events.length === 0) {
    const bytes = new Uint8Array(0)
    return { bytes, object: sha256Hex(bytes) }
  }
  const text = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
  const bytes = new TextEncoder().encode(text)
  return { bytes, object: sha256Hex(bytes) }
}

/**
 * Decode and structurally validate one event object against its manifest
 * reference. Each line must parse to an event envelope carrying only known
 * keys, with seq contiguous from 0 and a count matching the manifest. Envelope
 * validation adopts each event in place; full replay validation against the
 * session's history happens when the importer folds the log.
 * @param bytes - the object file's bytes.
 * @param reference - the manifest's event-object reference.
 * @returns the validated events in seq order.
 * @throws {SyncFormatError} when the bytes, any line, or the count fails validation.
 */
export function decodeEventObject(bytes: Uint8Array, reference: SyncEventObject): SessionEvent[] {
  const digest = sha256Hex(bytes)
  if (digest !== reference.object) {
    throw new SyncFormatError(`event object bytes do not match their digest (${reference.object})`)
  }
  if (bytes.length === 0) {
    if (reference.count !== 0) {
      throw new SyncFormatError('empty event object does not match its declared count')
    }
    return []
  }
  const text = new TextDecoder().decode(bytes)
  if (!text.endsWith('\n')) throw new SyncFormatError('event object is missing its trailing newline')
  const lines = text.slice(0, -1).split('\n')
  if (lines.length !== reference.count) {
    throw new SyncFormatError(`event object carries ${String(lines.length)} lines; its manifest declares ${String(reference.count)}`)
  }
  const events: SessionEvent[] = []
  for (const [index, line] of lines.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new SyncFormatError(`event object line ${String(index)} is not valid JSON`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SyncFormatError(`event object line ${String(index)} must be a JSON object`)
    }
    const record = parsed as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!EVENT_ENVELOPE_KEYS.has(key)) {
        throw new SyncFormatError(`event object line ${String(index)} carries unknown envelope key "${key}"`)
      }
    }
    if (typeof record.type !== 'string' || record.type === ''
      || typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 0
      || typeof record.time !== 'number' || !Number.isSafeInteger(record.time)
      || record.data === undefined
      || (record.ignorable !== undefined && record.ignorable !== true)) {
      throw new SyncFormatError(`event object line ${String(index)} has an invalid event envelope`)
    }
    if (record.seq !== index) {
      throw new SyncFormatError(`event object line ${String(index)} carries seq ${String(record.seq)}; positions must stay contiguous from 0`)
    }
    events.push(adoptSessionEvent(record as unknown as SessionEvent))
  }
  return events
}
