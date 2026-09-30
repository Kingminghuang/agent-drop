/** Same-origin API routes and page route for the session-sync Web UI. @module @deepseek-ai/dsh-session-sync-web */

import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse, IncomingMessage } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-sync'
import { SESSION_SYNC_CONFIG_PATH, SESSION_SYNC_EXPORT_PATH, SESSION_SYNC_IMPORT_PATH, SESSION_SYNC_OPERATIONS_PATH, SESSION_SYNC_OPERATION_PREFIX, SESSION_SYNC_PAGE_PATH, SESSION_SYNC_SCAN_PATH, SESSION_SYNC_SESSIONS_PATH } from './routes.ts'
import { sessionSyncPageHtml } from './page.ts'

/** Trust surface consumed here; the connection package owns the full type. */
interface ConnectionFetch {
  register(route: {
    readonly path: string
    readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
    readonly requestBody: 'buffered'
    readonly fetch: (request: Request) => Promise<Response>
  }): () => Promise<void>
}

/** Configuration write surface consumed here; the settings package owns the full type. */
interface SettingsPeer {
  update(ns: string, patch: Record<string, unknown>): Promise<void>
}

/** The route carrier and the trust fence guarding every route. */
export const inject = ['webServer', 'connection', 'sessionSync']

/** Write-route request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** The node:http half of one page request. */
function servePage(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, HEAD')
    res.end()
    return
  }
  const body = sessionSyncPageHtml()
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  if (req.method === 'HEAD') {
    res.setHeader('content-length', String(Buffer.byteLength(body)))
    res.end()
    return
  }
  res.end(body)
}

/** Collect one bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(request: Request): Promise<string | null> {
  const text = await request.text()
  return Buffer.byteLength(text) > MAX_BODY_BYTES ? null : text
}

/** Reject a write whose media type is not JSON: form posts cannot carry this content type without a CORS preflight. */
function jsonContentRequired(request: Request): Response | undefined {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType === 'application/json') return undefined
  return Response.json({ message: 'content type must be application/json' }, { status: 415 })
}

/**
 * Mount the page route and every same-origin API route.
 * @param ctx - plugin context carrying the web server, connection, and sync service.
 */
export function apply(ctx: Context): void {
  const service = ctx.sessionSync
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SESSION_SYNC_PAGE_PATH,
    handler: (req, res) => { servePage(req, res) },
  }), 'session-sync-web: page route')

  const connection = Reflect.get(ctx, 'connection') as { fetch: ConnectionFetch }
  connection.fetch.register({
    path: SESSION_SYNC_CONFIG_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(Response.json({
      root: service.configuredRoot(),
      rootDiagnostic: service.status().rootDiagnostic ?? undefined,
      backend: service.status().backend,
    }, { status: 200, headers: { 'cache-control': 'no-store' } })),
  })

  connection.fetch.register({
    path: SESSION_SYNC_CONFIG_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const csrf = jsonContentRequired(request)
      if (csrf !== undefined) return csrf
      const text = await readBoundedBody(request)
      if (text === null) return Response.json({ message: 'request body exceeds the size limit' }, { status: 413 })
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        return Response.json({ message: 'request body is not JSON' }, { status: 400 })
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)
        || (body as { root?: unknown }).root !== undefined && typeof (body as { root?: unknown }).root !== 'string') {
        return Response.json({ message: 'request body must carry a string root' }, { status: 400 })
      }
      const rootValue = (body as { root?: string }).root
      const settings = ctx.get('settings') as SettingsPeer | undefined
      if (settings === undefined) {
        return Response.json({ message: 'configuration is unavailable: no settings service is composed' }, { status: 503 })
      }
      try {
        await settings.update('session-sync', { root: rootValue ?? null })
      } catch (error: unknown) {
        return Response.json(
          { message: `configuration save failed; the previous value is still in effect: ${error instanceof Error ? error.message : String(error)}` },
          { status: 500 },
        )
      }
      const status = service.status()
      return Response.json({
        root: service.configuredRoot(),
        effectiveRoot: status.rootDiagnostic === undefined ? service.configuredRoot() : undefined,
        rootDiagnostic: status.rootDiagnostic,
      }, { status: 200, headers: { 'cache-control': 'no-store' } })
    },
  })

  connection.fetch.register({
    path: SESSION_SYNC_SESSIONS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json(
      { sessions: await service.listRootSessions() },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    ),
  })

  connection.fetch.register({
    path: SESSION_SYNC_EXPORT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const csrf = jsonContentRequired(request)
      if (csrf !== undefined) return csrf
      const text = await readBoundedBody(request)
      if (text === null) return Response.json({ message: 'request body exceeds the size limit' }, { status: 413 })
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        return Response.json({ message: 'request body is not JSON' }, { status: 400 })
      }
      const sessionId = typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as { sessionId?: unknown }).sessionId
        : undefined
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return Response.json({ message: 'request body must carry a sessionId' }, { status: 400 })
      }
      return submitOperation(() => service.exportTree(sessionId))
    },
  })

  connection.fetch.register({
    path: SESSION_SYNC_IMPORT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const csrf = jsonContentRequired(request)
      if (csrf !== undefined) return csrf
      const text = await readBoundedBody(request)
      if (text === null) return Response.json({ message: 'request body exceeds the size limit' }, { status: 413 })
      return submitOperation(() => service.importAll())
    },
  })

  connection.fetch.register({
    path: SESSION_SYNC_SCAN_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const csrf = jsonContentRequired(request)
      if (csrf !== undefined) return csrf
      const text = await readBoundedBody(request)
      if (text === null) return Response.json({ message: 'request body exceeds the size limit' }, { status: 413 })
      return submitOperation(() => service.scan())
    },
  })

  connection.fetch.register({
    path: SESSION_SYNC_OPERATIONS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(Response.json(
      { operations: service.operations() },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    )),
  })

  connection.fetch.register({
    path: `${SESSION_SYNC_OPERATION_PREFIX}*`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => Promise.resolve((() => {
      const id = decodeURIComponent(new URL(request.url).pathname.slice(SESSION_SYNC_OPERATION_PREFIX.length))
      const record = service.operation(id)
      if (record === undefined) return Response.json({ message: 'unknown operation' }, { status: 404 })
      return Response.json(record, { status: 200, headers: { 'cache-control': 'no-store' } })
    })()),
  })
}

/** Submit one operation, mapping the busy refusal to its own status. */
function submitOperation(submit: () => { readonly id: string }): Response {
  try {
    const reference = submit()
    return Response.json({ id: reference.id }, { status: 202, headers: { 'cache-control': 'no-store' } })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('already running')) {
      return Response.json({ message }, { status: 409, headers: { 'cache-control': 'no-store' } })
    }
    return Response.json({ message }, { status: 400, headers: { 'cache-control': 'no-store' } })
  }
}
