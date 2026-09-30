/** Sync root normalization and storage-overlap refusals. @module @deepseek-ai/dsh-session-sync/paths */

import { stat, realpath, mkdir } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory names of the harness-owned stores a sync root must not overlap. */
const PROTECTED_STORE_DIRS = ['sessions', 'attachments'] as const

/** Windows drive-absolute check: a bare `\` root or POSIX-only spelling is not fully qualified. */
function fullyQualified(path: string): boolean {
  if (process.platform !== 'win32') return isAbsolute(path)
  const root = resolve(path).split(sep)[0] ?? ''
  return /^[A-Za-z]:$/u.test(root) || path.startsWith('\\\\')
}

/**
 * Refuse a configured sync root that names a harness-owned storage location:
 * the resolved Harness home itself, or one of its session and attachment
 * store directories. One path containing the other is overlap in either
 * direction.
 * @param candidate - resolved absolute candidate root.
 * @returns a diagnostic when the root overlaps a protected store.
 */
export function protectedStoreOverlap(candidate: string): string | undefined {
  const home = resolve(resolveDshHome())
  const protectedPaths = [home, ...PROTECTED_STORE_DIRS.map(dir => resolve(home, dir))]
  const prefixOf = (root: string): string => root.endsWith(sep) ? root : root + sep
  for (const protectedPath of protectedPaths) {
    if (candidate === protectedPath
      || candidate.startsWith(prefixOf(protectedPath))
      || protectedPath.startsWith(prefixOf(candidate))) {
      return `'${candidate}' overlaps the harness store at '${protectedPath}'`
    }
  }
  return undefined
}

/**
 * Validate one configured sync root spelling before any filesystem access.
 * @param root - configured root value.
 * @returns a diagnostic when the spelling cannot name a directory.
 */
export function configuredRootDiagnostic(root: string): string | undefined {
  if (root.trim().length === 0) return 'the sync root is empty'
  if (!fullyQualified(root)) return `'${root}' is not a fully qualified directory path`
  return protectedStoreOverlap(resolve(root))
}

/**
 * Prepare one validated sync root for use: resolve the path, create the
 * directory when missing, and canonicalize through `realpath`. The canonical
 * spelling is what operations record, so a symlinked parent cannot split the
 * medium into two spellings.
 * @param root - configured root that passed {@link configuredRootDiagnostic}.
 * @param options - optional cancellation.
 * @returns the canonical absolute root path.
 * @throws {Error} when the path exists as a non-directory or cannot be created.
 */
export async function prepareSyncRoot(root: string, options?: { readonly signal?: AbortSignal }): Promise<string> {
  options?.signal?.throwIfAborted()
  const target = resolve(root)
  const existing = await stat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (existing !== undefined && !existing.isDirectory()) {
    throw new Error(`sync root '${target}' exists and is not a directory`)
  }
  if (existing === undefined) await mkdir(target, { recursive: true, mode: 0o700 })
  const canonical = await realpath(target)
  const overlap = protectedStoreOverlap(canonical)
  if (overlap !== undefined) throw new Error(overlap)
  return canonical
}
