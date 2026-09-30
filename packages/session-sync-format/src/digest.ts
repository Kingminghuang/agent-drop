/** Digest helpers for the content-addressed sync package. @module @deepseek-ai/dsh-session-sync-format/digest */

import { createHash } from 'node:crypto'
import { SyncFormatError } from './types.ts'

/** Length of one lowercase SHA-256 hex digest. */
const SHA256_HEX_LENGTH = 64

/**
 * Hash one byte sequence with SHA-256.
 * @param data - exact bytes to hash.
 * @returns the lowercase hex digest.
 */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Hash one text sequence with SHA-256.
 * @param text - UTF-8 text to hash.
 * @returns the lowercase hex digest.
 */
export function sha256HexText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Validate one digest path reference: lowercase hex SHA-256, safe as a single
 * path component. The value never names a subpath, an absolute path, or a NUL.
 * @param value - candidate digest reference from a manifest.
 * @param label - diagnostic subject.
 * @returns the same value after validation.
 */
export function requireDigestPath(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || value.length !== SHA256_HEX_LENGTH
    || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new SyncFormatError(`${label} must be a lowercase 64-hex SHA-256 digest`)
  }
  return value
}

/**
 * Validate one `sha256:<hex>` attachment identifier and return its digest.
 * @param value - candidate attachment id from a manifest reference.
 * @param label - diagnostic subject.
 * @returns the 64-hex digest behind the identifier.
 */
export function requireAttachmentDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('sha256:')) {
    throw new SyncFormatError(`${label} must be a "sha256:<hex>" content identifier`)
  }
  return requireDigestPath(value.slice('sha256:'.length), `${label} digest`)
}
