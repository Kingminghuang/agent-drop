/**
 * Same-origin client for the session-sync Web API: submit an export for one
 * session and follow the operation to settlement. Pure `fetch` — no harness
 * import, so the module is unit-testable in node and bundleable in the
 * browser unchanged.
 *
 * The routes duplicate `@deepseek-ai/dsh-session-sync-web/routes` on purpose:
 * importing across that package boundary would drag node-side declarations
 * into every client bundle for six string constants.
 */

/** One session's outcome inside a settled tree (the fields the action renders). */
export interface ExportSessionOutcome {
  /** Session identity. */
  readonly sessionId: string
  /** Definitive outcome of this pass. */
  readonly status: string
  /** Why the session did not export; absent when written. */
  readonly reason?: string
}

/** One tree's outcome inside a settled export operation. */
export interface ExportTreeOutcome {
  /** Resolved lineage root the package was published under. */
  readonly rootSessionId: string
  /** Definitive outcome of this pass. */
  readonly status: string
  /** Why the tree skipped or failed; absent when fully published. */
  readonly reason?: string
  /** Per-session outcomes. */
  readonly sessions: readonly ExportSessionOutcome[]
}

/** The settled outcome the export action reports to the user. */
export type ExportOutcome =
  | { readonly kind: 'exported'; readonly rootSessionId: string; readonly count: number }
  | { readonly kind: 'failed'; readonly reason: string }

/** The export submission route on the authenticated API channel. */
const EXPORT_PATH = '/api/session-sync/export'

/** The per-operation route prefix on the authenticated API channel. */
const OPERATION_PREFIX = '/api/session-sync/operation/'

/** Wait between operation polls; the Host settles local operations in seconds. */
const POLL_INTERVAL_MS = 500

/**
 * Read one JSON body, mapping transport and parse failures to a readable
 * rejection carrying the status.
 * @param response - the response to read.
 * @returns the parsed body.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error(`HTTP ${String(response.status)} returned a non-JSON body`)
  }
}

/** Read the string `message` field of an error body, or fall back to the status. */
function messageOf(body: unknown, status: number): string {
  const message = typeof body === 'object' && body !== null
    ? (body as { message?: unknown }).message
    : undefined
  return typeof message === 'string' && message.length > 0 ? message : `HTTP ${String(status)}`
}

/** Narrow one polled record into the fields this client reads. */
interface OperationRecord {
  readonly status: string
  readonly error?: string | undefined
  readonly result?: {
    readonly trees?: readonly ExportTreeOutcome[]
  } | undefined
}

function asRecord(body: unknown): OperationRecord {
  if (typeof body !== 'object' || body === null) throw new Error('the operation endpoint returned a non-object body')
  const record = body as Record<string, unknown>
  return {
    status: typeof record.status === 'string' ? record.status : 'unknown',
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(typeof record.result === 'object' && record.result !== null
      ? { result: record.result as OperationRecord['result'] }
      : {}),
  }
}

/**
 * Submit an export for one session and poll until the operation settles.
 * @param sessionId - a session of the tree to export; the Host resolves the
 *   lineage root, so any member of the tree is accepted.
 * @param fetchImpl - injectable fetch (tests).
 * @param delay - injectable wait between polls (tests).
 * @returns the settled outcome: the exported tree with its session count, or
 *   a readable failure reason.
 */
export async function exportSessionTree(
  sessionId: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  delay: (ms: number) => Promise<void> = ms => new Promise(resolve => { setTimeout(resolve, ms) }),
): Promise<ExportOutcome> {
  let submitted: Response
  try {
    submitted = await fetchImpl(EXPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  } catch (error: unknown) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  if (!submitted.ok) {
    const reason = await readJson(submitted).then(body => messageOf(body, submitted.status), () => messageOf(undefined, submitted.status))
    return { kind: 'failed', reason }
  }
  const accepted = await readJson(submitted)
  const id = typeof accepted === 'object' && accepted !== null
    && typeof (accepted as { id?: unknown }).id === 'string'
    ? (accepted as { id: string }).id
    : undefined
  if (id === undefined) return { kind: 'failed', reason: 'the export submission returned no operation id' }

  for (;;) {
    await delay(POLL_INTERVAL_MS)
    let poll: Response
    try {
      poll = await fetchImpl(`${OPERATION_PREFIX}${encodeURIComponent(id)}`)
    } catch (error: unknown) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
    if (!poll.ok) return { kind: 'failed', reason: messageOf(undefined, poll.status) }
    const record = asRecord(await readJson(poll))
    if (record.status === 'failed') {
      return { kind: 'failed', reason: record.error ?? 'the export operation failed without a reason' }
    }
    if (record.status === 'complete') {
      const tree = record.result?.trees?.at(0)
      if (tree === undefined) return { kind: 'failed', reason: 'the export completed without a tree result' }
      return tree.status === 'exported'
        ? { kind: 'exported', rootSessionId: tree.rootSessionId, count: tree.sessions.length }
        : { kind: 'failed', reason: tree.reason ?? `the export ended as '${tree.status}'` }
    }
    // 'accepted' | 'running' (or anything unrecognized): keep polling.
  }
}
