/** Portable home-relative working-directory encoding for the sync package. @module @deepseek-ai/dsh-session-sync-format/portable-cwd */

import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { relative, resolve, isAbsolute, sep, join } from 'node:path'
import type { PortableCwd } from './types.ts'
import { SyncFormatError } from './types.ts'

/** Maximum UTF-8 byte length of one path component. */
const MAX_COMPONENT_BYTES = 255

/** Windows reserved device stems, case-insensitive; a component naming one cannot be a path component there. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/** Characters a Windows path component cannot carry. */
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*]/u

/** Control characters and DEL, forbidden in every component. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

/**
 * Target-platform component policy for one portable cwd precheck. POSIX rules
 * apply off-Windows; Windows adds reserved device names, forbidden characters,
 * and trailing-dot/space spelling that its namespace would silently rewrite.
 */
export interface PortableComponentPlatform {
  /** Whether the importing device runs Windows. */
  readonly windows: boolean
}

/** Host platform rules for the running process. */
export const hostPlatform: PortableComponentPlatform = { windows: process.platform === 'win32' }

/**
 * Validate one path component against the universal invariants plus the
 * target platform's namespace rules: non-empty, not `.` or `..`, no separator,
 * no control character, at most 255 UTF-8 bytes, and on Windows no reserved
 * device name, forbidden character, or trailing dot/space.
 * @param value - one portable cwd component.
 * @param platform - target platform rules.
 * @returns whether the component can join a path on the target platform.
 */
export function isPortableComponent(value: string, platform: PortableComponentPlatform = hostPlatform): boolean {
  if (value === '' || value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\') || value.includes(sep)) return false
  if (CONTROL_CHARS.test(value)) return false
  if (Buffer.byteLength(value, 'utf8') > MAX_COMPONENT_BYTES) return false
  if (!platform.windows) return true
  if (WINDOWS_FORBIDDEN_CHARS.test(value)) return false
  if (/[. ]$/u.test(value)) return false
  const stem = value.slice(0, Math.max(value.indexOf('.'), 0)) || value
  return !WINDOWS_DEVICE_NAME.test(stem)
}

/**
 * Decode one portable cwd structurally: the tag and a string array. Whether a
 * component can address a directory on THIS device is a separate question,
 * because a `..` component or a Windows-reserved spelling makes the whole tree
 * skippable rather than making the package malformed.
 * @param value - decoded value from a manifest header.
 * @returns the structurally decoded portable cwd.
 * @throws {SyncFormatError} when the value is not a home-relative encoding.
 */
export function decodePortableCwd(value: unknown): PortableCwd {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyncFormatError('portable cwd must be an object')
  }
  const record = value as { kind?: unknown, components?: unknown }
  if (record.kind !== 'home-relative') {
    throw new SyncFormatError('portable cwd kind must be "home-relative"')
  }
  if (!Array.isArray(record.components)) {
    throw new SyncFormatError('portable cwd components must be an array')
  }
  for (const component of record.components) {
    if (typeof component !== 'string') {
      throw new SyncFormatError('portable cwd components must be strings')
    }
  }
  return { kind: 'home-relative', components: [...record.components as readonly string[]] }
}

/**
 * Whether every component of a decoded portable cwd can join a path on the
 * target platform. A `false` here skips the whole tree; it is not a malformed
 * package.
 * @param value - decoded portable cwd.
 * @param platform - target platform rules.
 * @returns whether the encoding can address a directory on the target platform.
 */
export function isAddressablePortableCwd(
  value: PortableCwd,
  platform: PortableComponentPlatform = hostPlatform,
): boolean {
  return value.components.every(component => isPortableComponent(component, platform))
}

/**
 * Validate a decoded portable cwd against the target platform.
 * @param value - decoded portable cwd.
 * @param platform - target platform rules.
 * @returns the validated portable cwd.
 * @throws {SyncFormatError} when the encoding or any component cannot join a path on the target platform.
 */
export function validatePortableCwd(value: unknown, platform: PortableComponentPlatform = hostPlatform): PortableCwd {
  const decoded = decodePortableCwd(value)
  if (!isAddressablePortableCwd(decoded, platform)) {
    throw new SyncFormatError('portable cwd carries a component the target platform cannot address')
  }
  return decoded
}

/**
 * Resolve a validated portable cwd to one absolute directory below the current
 * user's home. The home is resolved through `realpath` first, so a symlinked
 * home resolves to its real location.
 * @param value - validated portable cwd.
 * @param home - absolute current-user home; omitted resolves and canonicalizes `os.homedir()`.
 * @returns the absolute directory path.
 */
export async function resolvePortableCwd(value: PortableCwd, home?: string): Promise<string> {
  const base = home ?? await canonicalHome()
  return join(base, ...value.components)
}

/**
 * Resolve and canonicalize the current user's actual home directory.
 * @returns the absolute realpath of `os.homedir()`.
 */
export async function canonicalHome(): Promise<string> {
  return await realpath(homedir())
}

/**
 * Compute the portable encoding of one absolute working directory against the
 * current user's home. Home and `cwd` resolve through `realpath`; a `cwd`
 * outside home, an unresolvable path, or a result that cannot re-enter the
 * component invariants yields `undefined` so the caller skips the whole tree.
 * @param cwd - the absolute working directory recorded in the local session header.
 * @param home - absolute current-user home; omitted resolves the actual home.
 * @returns the portable encoding, or `undefined` when the directory is not safely home-relative.
 */
export async function encodePortableCwd(cwd: string, home?: string): Promise<PortableCwd | undefined> {
  if (cwd === '' || !isAbsolute(cwd)) return undefined
  const base = home ?? await canonicalHome()
  let target: string
  try {
    target = await realpath(cwd)
  } catch {
    return undefined
  }
  const comparableBase = base.endsWith(sep) ? base : base + sep
  if (target === base) return { kind: 'home-relative', components: [] }
  if (!target.startsWith(comparableBase)) return undefined
  const relativeValue = relative(base, target)
  if (relativeValue === '' || isAbsolute(relativeValue) || relativeValue.startsWith('..')) return undefined
  const components = relativeValue.split(sep)
  if (components.some(component => !isPortableComponent(component))) return undefined
  return { kind: 'home-relative', components }
}

/**
 * Whether one absolute path is the resolved home or lies beneath it.
 * @param path - absolute candidate path.
 * @param home - absolute current-user home.
 * @returns whether the path stays inside the home tree.
 */
export function isUnderHome(path: string, home: string): boolean {
  const resolved = resolve(path)
  if (resolved === home) return true
  const prefix = home.endsWith(sep) ? home : home + sep
  return resolved.startsWith(prefix)
}
