/** Operation records and the mutex chain behind the sync service. @module @deepseek-ai/dsh-session-sync/operations */

import type { SyncOperationKind, SyncOperationRecord, SyncOperationRef, SyncOperationResult } from './types.ts'

/** Mutable record state behind one exposed snapshot. */
interface MutableOperation {
  /** Operation identity. */
  readonly id: string
  /** Operation direction. */
  readonly kind: SyncOperationKind
  /** Acceptance instant, in Unix epoch milliseconds. */
  readonly submittedAt: number
  /** Root captured at acceptance. */
  readonly root: string
  /** Current lifecycle state. */
  status: SyncOperationRecord['status']
  /** Final outcome, present only when terminal. */
  result: SyncOperationResult | undefined
  /** Rendered failure reason, present only with `failed`. */
  error: string | undefined
  /** Settles once, with the final result or the failure. */
  readonly resolvers: PromiseWithResolvers<SyncOperationResult>
}

/** The deferred settlement of one operation. */
interface PromiseWithResolvers<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

/** Render one arbitrary thrown value without trusting its string coercion.
 * @param value - thrown value.
 * @returns a readable diagnostic.
 */
export function renderThrown(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

/**
 * Process-local registry of sync operations. Every operation carries its
 * accepted root; submissions serialize on one chain, so at most one operation
 * runs at a time and a submission arriving while one is under way is refused
 * as busy. Records stay process-local: after a restart the page re-scans the
 * medium instead of replaying anything.
 */
export class SyncOperationRegistry {
  private readonly records = new Map<string, MutableOperation>()
  private sequence = 0
  private chain: Promise<void> = Promise.resolve()

  /**
   * Whether an operation is accepted or running right now.
   * @returns whether a new submission would be refused as busy.
   */
  hasActive(): boolean {
    return [...this.records.values()].some(record => record.status === 'accepted' || record.status === 'running')
  }

  /**
   * Enqueue one operation after every earlier one settles. The submitter's own
   * cancellation reaches the operation body: aborting it interrupts the
   * pipeline at its next checkpoint and the record settles as failed with the
   * abort reason, so an accepted operation never stays silently running.
   * @param kind - operation direction.
   * @param root - the root captured at acceptance.
   * @param run - the operation body; its rejection fails the record.
   * @param options - the submitting entry point's cancellation.
   * @returns the reference the submitting entry point correlates.
   */
  submit(
    kind: SyncOperationKind,
    root: string,
    run: (signal: AbortSignal) => Promise<SyncOperationResult>,
    options?: { readonly signal?: AbortSignal },
  ): SyncOperationRef {
    const id = `sync-${String(++this.sequence)}`
    const controller = new AbortController()
    const external = options?.signal
    if (external !== undefined) {
      if (external.aborted) controller.abort(external.reason)
      else external.addEventListener('abort', () => { controller.abort(external.reason) }, { once: true, signal: controller.signal })
    }
    const deferred = Promise.withResolvers<SyncOperationResult>()
    const record: MutableOperation = {
      id,
      kind,
      submittedAt: Date.now(),
      root,
      status: 'accepted',
      result: undefined,
      error: undefined,
      resolvers: deferred,
    }
    this.records.set(id, record)
    const done = this.chain.then(() => this.execute(record, controller.signal, run))
    this.chain = done.then(() => undefined, () => undefined)
    return { id, done: deferred.promise }
  }

  /** Run one record to a terminal state, containing executor failures in the record. */
  private async execute(
    record: MutableOperation,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<SyncOperationResult>,
  ): Promise<void> {
    record.status = 'running'
    try {
      signal.throwIfAborted()
      const result = await run(signal)
      record.result = result
      record.status = 'complete'
      record.resolvers.resolve(result)
    } catch (error: unknown) {
      record.status = 'failed'
      record.error = renderThrown(error)
      record.resolvers.reject(error instanceof Error ? error : new Error(record.error))
    }
  }

  /**
   * Read one operation's exposed record.
   * @param id - operation identity.
   * @returns the record snapshot, or `undefined` when unknown.
   */
  get(id: string): SyncOperationRecord | undefined {
    const record = this.records.get(id)
    return record === undefined ? undefined : this.snapshot(record)
  }

  /**
   * List every record in acceptance order, oldest first.
   * @returns the record snapshots.
   */
  list(): readonly SyncOperationRecord[] {
    return [...this.records.values()].map(record => this.snapshot(record))
  }

  /** One detached record snapshot. */
  private snapshot(record: MutableOperation): SyncOperationRecord {
    return {
      id: record.id,
      kind: record.kind,
      submittedAt: record.submittedAt,
      root: record.root,
      status: record.status,
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.error === undefined ? {} : { error: record.error }),
    }
  }
}
