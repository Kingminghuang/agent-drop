/** Session synchronization service (`ctx.sessionSync`). @module @deepseek-ai/dsh-session-sync */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cosmokit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { decodeTreeManifest } from '@deepseek-ai/dsh-session-sync-format'
import type { SyncTreeFile } from '@deepseek-ai/dsh-session-sync-format'
import type { SessionSyncBackend, SessionSyncRoot } from './backend.ts'
import { configuredRootDiagnostic } from './paths.ts'
import { SyncOperationRegistry } from './operations.ts'
import { runExport } from './export.ts'
import { runImportTree } from './import.ts'
import { scanTree } from './scan.ts'
import type { SyncOperationKind, SyncOperationRecord, SyncOperationRef, SyncOperationResult } from './types.ts'

export { SessionSyncBackend, SyncObjectMissingError, type SessionSyncObjectKind, type SessionSyncRoot } from './backend.ts'
export * from './types.ts'
export { SyncOperationRegistry } from './operations.ts'
export { configuredRootDiagnostic, prepareSyncRoot, protectedStoreOverlap } from './paths.ts'

/** Plugin configuration: the sync root the Web UI edits and every entry point reads. */
export interface Config {
  /**
   * Local sync directory the external cloud client replicates across devices.
   * Unset refuses every submission; a configured root is validated before use.
   */
  readonly root: Volatile<string | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-device session synchronization service. */
    sessionSync: SessionSyncService
  }
}

/** One candidate root session exposed to the Web UI. */
export interface SyncRootSession {
  /** Session identity. */
  readonly sessionId: string
  /** Creation instant, in Unix epoch milliseconds. */
  readonly createdAt: number
  /** Absolute working directory, when the session records one. */
  readonly cwd?: string
  /** Whether the session is live in this process. */
  readonly live: boolean
  /** Whether the persistence backend lists the session. */
  readonly persisted: boolean
  /** Whether the session is archived. */
  readonly archived: boolean
  /** Latest folded title, when the title engine is composed. */
  readonly title?: string
}

/** The service's status view. */
export interface SessionSyncStatus {
  /** The configured root, verbatim. */
  readonly root: string | undefined
  /** Why the configured root cannot be used; absent when usable or unset. */
  readonly rootDiagnostic: string | undefined
  /** The mounted backend kind, when one is composed. */
  readonly backend: string | undefined
}

/**
 * Cross-device session synchronization service. Every operation captures its
 * root at acceptance and keeps using it; submissions serialize on one chain,
 * so a submission arriving while an operation is under way is refused as busy.
 */
export class SessionSyncService extends Service {
  static inject = ['sessions', 'sessionPersistence', 'sessionQuery']

  static Config = z.object({
    root: z.string().volatile(),
  })

  /** Resolved plugin config. */
  private readonly config: Config
  /** Backends mounted on this service, keyed by kind. */
  private readonly backends = new Map<string, SessionSyncBackend>()
  /** Process-local operation records and the serialization chain. */
  private readonly registry = new SyncOperationRegistry()

  /**
   * @param ctx - owning host context.
   * @param config - validated plugin config.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionSync')
    this.config = config
  }

  /**
   * Mount one storage backend. Duplicate kinds fail loud: a composition
   * mounting two backends of one kind is a misconfiguration.
   * @param backend - the backend to mount.
   * @returns the exact disposer removing this backend.
   */
  registerBackend(backend: SessionSyncBackend): () => void {
    if (this.backends.has(backend.kind)) {
      throw new Error(`session-sync: a backend of kind "${backend.kind}" is already registered`)
    }
    this.backends.set(backend.kind, backend)
    return () => {
      if (this.backends.get(backend.kind) === backend) this.backends.delete(backend.kind)
    }
  }

  /**
   * Read the configured sync root verbatim.
   * @returns the configured root, or `undefined` when unset.
   */
  configuredRoot(): string | undefined {
    return this.config.root.get()
  }

  /**
   * Read the status view: configured root, its validity, and the mounted
   * backend kind.
   * @returns the status snapshot.
   */
  status(): SessionSyncStatus {
    const root = this.config.root.get()
    return {
      root,
      rootDiagnostic: root === undefined ? undefined : configuredRootDiagnostic(root),
      backend: this.backends.keys().next().value,
    }
  }

  /**
   * Resolve the mounted backend.
   * @returns the backend.
   * @throws {Error} when no backend is composed.
   */
  backend(): SessionSyncBackend {
    const backend = this.backends.values().next().value
    if (backend === undefined) {
      throw new Error('session-sync: no sync backend is composed; mount a backend provider')
    }
    return backend
  }

  /**
   * Export one session tree as a sync package. The id may name any session of
   * the tree; the pipeline resolves it to the lineage root and always
   * publishes the whole tree from there.
   * @param rootSessionId - a session of the tree to export.
   * @param options - optional cancellation owned by the submitting entry point.
   * @returns the operation reference.
   * @throws {Error} when an operation is already under way or the root is unusable.
   */
  exportTree(rootSessionId: string, options?: { readonly signal?: AbortSignal }): SyncOperationRef {
    return this.submit('export', async (signal, root) => {
      const tree = await runExport(
        {
          ...this.peers(),
          backend: this.backend(),
          root,
        },
        rootSessionId as SessionId,
        signal,
      )
      return { trees: [tree] }
    }, options)
  }

  /**
   * Import every tree manifest currently visible on the medium.
   * @param options - optional cancellation owned by the submitting entry point.
   * @returns the operation reference.
   * @throws {Error} when an operation is already under way or the root is unusable.
   */
  importAll(options?: { readonly signal?: AbortSignal }): SyncOperationRef {
    return this.submit('import', async (signal, root) => {
      const peers = this.peers()
      const files = await orderedTreeFiles(peers.backend, root, signal)
      const trees: Awaited<ReturnType<typeof runImportTree>>[] = []
      for (const file of files) {
        signal.throwIfAborted()
        trees.push(await runImportTree(
          {
            sessions: peers.sessions,
            sessionPersistence: peers.sessionPersistence,
            sessionQuery: peers.sessionQuery,
            attachments: peers.attachments,
            workspaceRegistry: peers.workspaceRegistry,
            backend: peers.backend,
            root,
          },
          file,
          signal,
        ))
      }
      return { trees }
    }, options)
  }

  /**
   * Scan the medium: every visible tree manifest is read and every referenced
   * object is verified, reporting readiness without writing anything.
   * @param options - optional cancellation.
   * @returns the operation reference.
   * @throws {Error} when an operation is already under way or the root is unusable.
   */
  scan(options?: { readonly signal?: AbortSignal }): SyncOperationRef {
    return this.submit('scan', async (signal, root) => {
      const peers = this.peers()
      const files = await orderedTreeFiles(peers.backend, root, signal)
      const trees: Awaited<ReturnType<typeof scanTree>>[] = []
      for (const file of files) {
        signal.throwIfAborted()
        trees.push(await scanTree({ backend: peers.backend, root }, file, signal))
      }
      return { trees }
    }, options)
  }

  /**
   * List the candidate root sessions with their archive state, newest first.
   * @param signal - optional cancellation.
   * @returns root sessions in newest-first order.
   */
  async listRootSessions(signal?: AbortSignal): Promise<readonly SyncRootSession[]> {
    const peers = this.peers()
    const records = await peers.sessionQuery.listSessions(signal)
    const archived = new Set((peers.workspaceRegistry?.archivedSessionIds ?? []).map(String))
    const roots = records.filter(record => record.header.parentSession === undefined)
    const titles = await this.readTitles(roots.map(record => record.header.id))
    return roots.map((record) => {
      const title = titles.get(String(record.header.id))
      return {
        sessionId: String(record.header.id),
        createdAt: record.header.createdAt,
        ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
        live: record.live,
        persisted: record.persisted,
        archived: archived.has(String(record.header.id)),
        ...(title === undefined ? {} : { title }),
      }
    })
  }

  /**
   * Read one operation's exposed record.
   * @param id - operation identity.
   * @returns the record snapshot, or `undefined` when unknown.
   */
  operation(id: string): SyncOperationRecord | undefined {
    return this.registry.get(id)
  }

  /**
   * List every record in acceptance order, oldest first.
   * @returns the record snapshots.
   */
  operations(): readonly SyncOperationRecord[] {
    return this.registry.list()
  }

  /** The structural peers, read from the host context. */
  private peers(): {
    /** The live-session store. */
    readonly sessions: SessionStore
    /** The mounted persistence backend. */
    readonly sessionPersistence: SessionPersistence
    /** The composed session-query engine. */
    readonly sessionQuery: SessionQueryEngine
    /** The mounted attachment store. */
    readonly attachments: AttachmentStore | undefined
    /** The composed workspace registry. */
    readonly workspaceRegistry: WorkspaceRegistry | undefined
    /** The mounted backend. */
    readonly backend: SessionSyncBackend
  } {
    return {
      sessions: this.ctx.sessions,
      sessionPersistence: this.ctx.sessionPersistence,
      sessionQuery: this.ctx.sessionQuery,
      attachments: this.ctx.get('attachments'),
      workspaceRegistry: this.ctx.get('workspaceRegistry'),
      backend: this.backend(),
    }
  }

  /** Read each requested session's latest folded title. */
  private async readTitles(ids: readonly SessionId[]): Promise<Map<string, string>> {
    const engine = this.ctx.get('sessionTitle') as SessionTitleEngineSlice | undefined
    if (engine === undefined) return new Map()
    const observations = await engine.readTitleSnapshots(ids).catch(() => [] as readonly TitleObservationSlice[])
    const titles = new Map<string, string>()
    for (const observation of observations) {
      if (observation.status !== 'fulfilled') continue
      titles.set(String(observation.sessionId), observation.value.title.title)
    }
    return titles
  }

  /** Refuse a submission while an operation is under way. */
  private assertIdle(): void {
    if (!this.registry.hasActive()) return
    throw new Error('session-sync: an operation is already running')
  }

  /** Validate the configured root before a submission is accepted. */
  private assertRootUsable(): void {
    const root = this.config.root.get()
    if (root === undefined) throw new Error('session-sync: no sync root is configured')
    const diagnostic = configuredRootDiagnostic(root)
    if (diagnostic !== undefined) throw new Error(`session-sync: ${diagnostic}`)
  }

  /**
   * Enqueue one operation with its accepted root.
   * @param kind - operation direction.
   * @param run - the operation body; the accepted root is validated and prepared inside it.
   * @returns the operation reference.
   * @throws {Error} when an operation is already under way or the root is unusable.
   */
  private submit(
    kind: SyncOperationKind,
    run: (signal: AbortSignal, root: SessionSyncRoot) => Promise<SyncOperationResult>,
    options?: { readonly signal?: AbortSignal },
  ): SyncOperationRef {
    this.assertIdle()
    this.assertRootUsable()
    const configured = this.config.root.get() as string
    const backend = this.backend()
    return this.registry.submit(kind, configured, async (signal) => {
      const root = await backend.resolveRoot(configured, { signal })
      return await run(signal, root)
    }, options)
  }
}

/**
 * Order the medium's tree manifests so one bucket converges in a single pass:
 * the fewest recorded events first, the richest history last. Every revision of
 * a bucket stays importable on its own, so the order never decides which
 * content wins — it only keeps the reported outcome stable and lets the newest
 * history be compared against the local log last. A manifest that cannot be
 * read keeps its digest order and is reported by the pipeline itself.
 * @param backend - the prepared backend.
 * @param root - the prepared sync root.
 * @param signal - cancellation.
 * @returns the tree files in a stable order.
 */
async function orderedTreeFiles(
  backend: SessionSyncBackend,
  root: SessionSyncRoot,
  signal: AbortSignal,
): Promise<readonly SyncTreeFile[]> {
  const files = await backend.listTrees(root, { signal })
  const weighted = await Promise.all(files.map(async file => {
    try {
      const bytes = await backend.readTree(root, file, { signal })
      const manifest = decodeTreeManifest(bytes, file.rootSessionId)
      const events = manifest.sessions.reduce((total, entry) => total + entry.events.count, 0)
      return { file, events }
    } catch {
      return { file, events: Number.MAX_SAFE_INTEGER }
    }
  }))
  return weighted
    .sort((left, right) => left.events - right.events || left.file.revisionHash.localeCompare(right.file.revisionHash))
    .map(entry => entry.file)
}

/** The title engine members the service reads. */
interface SessionTitleEngineSlice {
  readTitleSnapshots(ids: readonly SessionId[]): Promise<readonly TitleObservationSlice[]>
}

/** One folded title observation. */
type TitleObservationSlice =
  | { readonly sessionId: SessionId; readonly status: 'fulfilled'; readonly value: { readonly title: { readonly title: string } } }
  | { readonly sessionId: SessionId; readonly status: 'rejected' }

export default SessionSyncService
