/**
 * Behavior tests for the session-sync Web plugin: the page route it mounts on
 * the web server and the same-origin API it registers on the connection
 * service. The plugin is applied to a hand-built context whose three injected
 * peers and optional settings service are structural stand-ins, so every test
 * drives the handlers the plugin actually registered.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  SessionSyncService,
  SessionSyncStatus,
  SyncOperationKind,
  SyncOperationRecord,
  SyncOperationRef,
  SyncRootSession,
} from '@deepseek-ai/dsh-session-sync'
import { apply } from '../src/index.ts'
import { sessionSyncPageHtml } from '../src/page.ts'
import {
  SESSION_SYNC_CONFIG_PATH,
  SESSION_SYNC_EXPORT_PATH,
  SESSION_SYNC_IMPORT_PATH,
  SESSION_SYNC_OPERATIONS_PATH,
  SESSION_SYNC_OPERATION_PREFIX,
  SESSION_SYNC_PAGE_PATH,
  SESSION_SYNC_SCAN_PATH,
  SESSION_SYNC_SESSIONS_PATH,
} from '../src/routes.ts'

/** Origin the tests deliver from; the carrier applies its trust fence before any route body runs. */
const ORIGIN = 'http://127.0.0.1:3080'

/** The methods the plugin's API routes own. */
type ApiMethod = 'GET' | 'POST'

/** Contexts mounted by this suite, disposed after every test. */
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/** The node:http request members the page handler reads. */
interface PageRequest {
  /** HTTP method the carrier presented. */
  readonly method: string
}

/** The node:http response members the page handler writes. */
interface PageResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** One page route the web-server stub captured. */
interface CapturedPageRoute {
  /** Route match kind the plugin asked for. */
  readonly kind: string
  /** Absolute path the plugin claimed. */
  readonly path: string
  /** Handler owning the full response lifecycle. */
  readonly handler: (req: PageRequest, res: PageResponse) => void | Promise<void>
}

/** One exact API route the connection stub captured. */
interface CapturedApiRoute {
  /** Absolute path the plugin claimed, or its `*`-suffixed prefix. */
  readonly path: string
  /** Methods the plugin claimed for this path. */
  readonly methods: readonly ApiMethod[]
  /** Body mode the plugin asked the carrier for; every write here is buffered. */
  readonly requestBody: 'buffered'
  /** Handler receiving one already-trusted request. */
  readonly fetch: (request: Request) => Promise<Response>
}

/** Recording stand-in for the node:http response the page handler writes. */
class FakePageResponse implements PageResponse {
  statusCode = 0
  /** Body text of every `end` call, in order. */
  readonly bodies: (string | undefined)[] = []
  private readonly headers = new Map<string, string>()

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value)
  }

  end(body?: string): void {
    this.bodies.push(body)
  }

  /**
   * Read one recorded header.
   * @param name - case-insensitive header name.
   * @returns the recorded value, or `undefined` when the handler set none.
   */
  header(name: string): string | undefined {
    return this.headers.get(name.toLowerCase())
  }
}

/** One submission the sync-service stub accepted. */
interface StubSubmission {
  /** Direction the route requested. */
  readonly kind: SyncOperationKind
  /** Root session an export named; absent for import and scan. */
  readonly sessionId?: string
}

/** The service members the Web routes read, taken from the real service. */
type SessionSyncPeer = Pick<
  SessionSyncService,
  'configuredRoot' | 'status' | 'listRootSessions' | 'exportTree' | 'importAll' | 'scan' | 'operations' | 'operation'
>

/** Recording stand-in for `ctx.sessionSync`. */
class FakeSessionSync implements SessionSyncPeer {
  /** Configured root the routes report; `undefined` models an unset root. */
  root: string | undefined
  /** Diagnostic reported for an unusable root. */
  rootDiagnostic: string | undefined = undefined
  /** Mounted backend kind the config route reports. */
  backend: string | undefined = undefined
  /** Root-session snapshot, newest first, exactly as the service would return it. */
  sessions: readonly SyncRootSession[] = []
  /** Submissions the routes accepted, in order. */
  readonly submissions: StubSubmission[] = []
  /** Operation records in acceptance order. */
  readonly records: SyncOperationRecord[] = []
  /** When set, every submission raises it; models the service refusing to accept work. */
  failure: Error | undefined = undefined
  private accepted = 0

  /**
   * @param root - configured root to report.
   */
  constructor(root?: string) {
    this.root = root
  }

  configuredRoot(): string | undefined {
    return this.root
  }

  status(): SessionSyncStatus {
    return { root: this.root, rootDiagnostic: this.rootDiagnostic, backend: this.backend }
  }

  async listRootSessions(): Promise<readonly SyncRootSession[]> {
    return this.sessions
  }

  exportTree(rootSessionId: string): SyncOperationRef {
    const reference = this.accept('export')
    this.submissions.push({ kind: 'export', sessionId: rootSessionId })
    return reference
  }

  importAll(): SyncOperationRef {
    const reference = this.accept('import')
    this.submissions.push({ kind: 'import' })
    return reference
  }

  scan(): SyncOperationRef {
    const reference = this.accept('scan')
    this.submissions.push({ kind: 'scan' })
    return reference
  }

  operations(): readonly SyncOperationRecord[] {
    return this.records
  }

  operation(id: string): SyncOperationRecord | undefined {
    return this.records.find(record => record.id === id)
  }

  /** Mint one accepted operation, refusing before anything is recorded while `failure` is set. */
  private accept(kind: SyncOperationKind): SyncOperationRef {
    if (this.failure !== undefined) throw this.failure
    this.accepted += 1
    const id = `op-${this.accepted}`
    this.records.push({ id, kind, submittedAt: 1_000 + this.accepted, root: this.root ?? '', status: 'accepted' })
    return { id, done: Promise.resolve({ trees: [] }) }
  }
}

/** One configuration write the settings stub accepted. */
interface SettingsWrite {
  /** Namespace the route wrote. */
  readonly ns: string
  /** Patch the route wrote. */
  readonly patch: Record<string, unknown>
}

/** The settings surface the config route writes through. */
interface SettingsPeer {
  update(ns: string, patch: Record<string, unknown>): Promise<void>
}

/** Recording stand-in for `ctx.settings`. */
class FakeSettings implements SettingsPeer {
  /** Writes the route accepted, in order. */
  readonly writes: SettingsWrite[] = []
  /** When set, every write raises it before the patch is applied. */
  failure: Error | undefined = undefined

  /**
   * @param applyPatch - what Settings does with an accepted patch; the sync
   * service reads its live config, so this is what makes a root effective.
   */
  constructor(private readonly applyPatch: (patch: Record<string, unknown>) => void) {}

  async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    if (this.failure !== undefined) throw this.failure
    this.writes.push({ ns, patch })
    this.applyPatch(patch)
  }
}

/** One mounted plugin: its context, peer stubs, and captured routes. */
interface WebMount {
  /** The context the plugin was applied to. */
  readonly ctx: Context
  /** The sync-service stand-in the routes project. */
  readonly service: FakeSessionSync
  /** The settings stand-in; `undefined` when the mount composes no settings service. */
  readonly settings: FakeSettings | undefined
  /** Page routes the web-server stub captured, in registration order. */
  readonly pageRoutes: readonly CapturedPageRoute[]
  /** API routes the connection stub captured, in registration order. */
  readonly apiRoutes: readonly CapturedApiRoute[]
}

/** Composition switches for one mount. */
interface MountOptions {
  /** Set `false` to compose the plugin without a settings service. */
  readonly settings?: boolean
}

/**
 * Mount the plugin on a hand-built context. Cordis types each service by the
 * class that provides it, which no test double can satisfy structurally, so
 * each stand-in is cast once at its provide site and nowhere else.
 * @param options - composition switches for the mount.
 * @returns the mount with its stubs and captured routes.
 */
function mountWeb(options: MountOptions = {}): WebMount {
  const service = new FakeSessionSync()
  const pageRoutes: CapturedPageRoute[] = []
  const apiRoutes: CapturedApiRoute[] = []
  const ctx = new Context()
  ctx.provide('sessionSync', service as never)
  ctx.provide('webServer', {
    register: (route: CapturedPageRoute) => {
      pageRoutes.push(route)
      return () => {
        const index = pageRoutes.indexOf(route)
        if (index >= 0) pageRoutes.splice(index, 1)
      }
    },
  } as never)
  ctx.provide('connection', {
    fetch: {
      register: (route: CapturedApiRoute) => {
        apiRoutes.push(route)
        return async () => {}
      },
    },
  } as never)
  const settings = options.settings === false
    ? undefined
    : new FakeSettings((patch) => {
      service.root = typeof patch['root'] === 'string' ? patch['root'] : undefined
    })
  if (settings !== undefined) ctx.provide('settings', settings as never)
  apply(ctx)
  contexts.push(ctx)
  return { ctx, service, settings, pageRoutes, apiRoutes }
}

/**
 * Read the one page route the plugin registered.
 * @param mount - the mounted plugin.
 * @returns the captured page route.
 * @throws {Error} when the plugin registered no page route.
 */
function pageRoute(mount: WebMount): CapturedPageRoute {
  const route = mount.pageRoutes[0]
  if (route === undefined) throw new Error('the plugin registered no page route')
  return route
}

/**
 * Read the settings stand-in of a mount that composes one.
 * @param mount - the mounted plugin.
 * @returns the recording settings stub.
 * @throws {Error} when the mount composes no settings service.
 */
function settingsOf(mount: WebMount): FakeSettings {
  if (mount.settings === undefined) throw new Error('this mount composes no settings service')
  return mount.settings
}

/**
 * Serve one page request with a recording response.
 * @param mount - the mounted plugin.
 * @param method - HTTP method to present.
 * @returns the recorded response.
 */
async function servePageRequest(mount: WebMount, method: string): Promise<FakePageResponse> {
  const response = new FakePageResponse()
  await pageRoute(mount).handler({ method }, response)
  return response
}

/**
 * Read the one document the page handler wrote.
 * @param response - the recorded page response.
 * @returns the served HTML document.
 * @throws {Error} when the handler did not write exactly one document.
 */
function pageBody(response: FakePageResponse): string {
  const body = response.bodies.length === 1 ? response.bodies[0] : undefined
  if (typeof body !== 'string') throw new Error('the page handler did not write exactly one document')
  return body
}

/**
 * Build one bodyless API request.
 * @param method - the method the route owns.
 * @param path - absolute request path.
 * @returns the request the carrier would hand to the route.
 */
function request(method: ApiMethod, path: string): Request {
  return new Request(`${ORIGIN}${path}`, { method })
}

/**
 * Build one JSON-typed API request.
 * @param method - the method the route owns.
 * @param path - absolute request path.
 * @param value - JSON value to serialize as the body.
 * @returns the request the carrier would hand to the route.
 */
function jsonRequest(method: ApiMethod, path: string, value: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
}

/**
 * Build one API request with a raw body and optional media type.
 * @param method - the method the route owns.
 * @param path - absolute request path.
 * @param body - raw body text.
 * @param contentType - media type to send, or `undefined` to send none at all.
 * @returns the request the carrier would hand to the route.
 */
function rawRequest(method: ApiMethod, path: string, body: string, contentType?: string): Request {
  const headers = new Headers()
  if (contentType !== undefined) headers.set('content-type', contentType)
  return new Request(`${ORIGIN}${path}`, { method, headers, body })
}

/**
 * Whether one captured route owns a request path: an exact path verbatim, or
 * the prefix a trailing `*` claims.
 * @param route - the captured route.
 * @param path - the request pathname.
 * @returns `true` when this route answers for the path.
 */
function routeOwns(route: CapturedApiRoute, path: string): boolean {
  return route.path.endsWith('*')
    ? path.startsWith(route.path.slice(0, -1))
    : route.path === path
}

/** One same-origin call the page script makes. */
interface PageCall {
  /** Method the call names; a call that names none is a GET. */
  readonly method: ApiMethod
  /** Absolute path the call reaches. */
  readonly path: string
}

/**
 * Read the text of one `api(...)` call after its first string argument.
 * @param html - the served document.
 * @param start - index just past that string argument.
 * @returns the call text up to the parenthesis closing the call.
 * @throws {Error} when the call is never closed.
 */
function callArguments(html: string, start: number): string {
  let depth = 0
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (character === '(') depth += 1
    else if (character === ')') {
      if (depth === 0) return html.slice(start, index)
      depth -= 1
    }
  }
  throw new Error('the page script leaves a call unterminated')
}

/**
 * Read every API call the page script makes.
 * @param html - the served document.
 * @returns the method and path of each call, in document order.
 * @throws {Error} when a call names a method no route here can own.
 */
function pageCalls(html: string): PageCall[] {
  const calls: PageCall[] = []
  for (const match of html.matchAll(/api\('([^']+)'/gu)) {
    const path = match[1]
    if (path === undefined) continue
    const method = /method:\s*'([A-Z]+)'/u.exec(callArguments(html, (match.index ?? 0) + match[0].length))?.[1] ?? 'GET'
    if (method !== 'GET' && method !== 'POST') throw new Error(`the page calls ${path} with an unsupported method ${method}`)
    calls.push({ method, path })
  }
  return calls
}

/**
 * Deliver one request to the route that owns its path and method.
 * @param mount - the mounted plugin.
 * @param request - the request to deliver.
 * @returns the route's response.
 * @throws {Error} when the plugin registered no route for this path and method.
 */
async function deliver(mount: WebMount, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname
  const route = mount.apiRoutes.find(candidate =>
    candidate.methods.some(method => method === request.method) && routeOwns(candidate, path))
  if (route === undefined) throw new Error(`no captured route for ${request.method} ${path}`)
  return await route.fetch(request)
}

/**
 * Decode one JSON response body.
 * @param response - the response to read.
 * @returns the decoded JSON value.
 */
async function jsonBody(response: Response): Promise<unknown> {
  return await response.json()
}

/**
 * Whether a decoded JSON value is a plain string-keyed object.
 * @param value - the decoded value.
 * @returns `true` for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the `message` field of one decoded response body.
 * @param body - the decoded body.
 * @returns the message text.
 * @throws {Error} when the body carries no string message.
 */
function messageOf(body: unknown): string {
  const message = isRecord(body) ? body['message'] : undefined
  if (typeof message !== 'string') throw new Error('the response body carries no message')
  return message
}

/**
 * Read the operation id of one accepted submission response.
 * @param response - the submission response.
 * @returns the accepted operation id.
 * @throws {Error} when the body carries no string id.
 */
async function acceptedId(response: Response): Promise<string> {
  const body = await jsonBody(response)
  const id = isRecord(body) ? body['id'] : undefined
  if (typeof id !== 'string') throw new Error('the submission response carries no operation id')
  return id
}

/** Root sessions the stub reports: two roots, newest first, the older one archived. */
const ROOT_SESSIONS: readonly SyncRootSession[] = [
  { sessionId: 'session-newest', createdAt: 3_000, live: true, persisted: true, archived: false, title: 'Newest work' },
  { sessionId: 'session-archived', createdAt: 1_000, live: false, persisted: true, archived: true },
]

/** The three submission routes with one body each route accepts. */
const SUBMISSION_CASES = [
  { kind: 'export', path: SESSION_SYNC_EXPORT_PATH, body: { sessionId: 'session-newest' } },
  { kind: 'import', path: SESSION_SYNC_IMPORT_PATH, body: {} },
  { kind: 'scan', path: SESSION_SYNC_SCAN_PATH, body: {} },
] as const

/** Every write route the plugin owns; each one enforces the JSON media type. */
const WRITE_PATHS = [
  SESSION_SYNC_CONFIG_PATH,
  SESSION_SYNC_EXPORT_PATH,
  SESSION_SYNC_IMPORT_PATH,
  SESSION_SYNC_SCAN_PATH,
] as const

/** The write routes that parse their body as JSON before doing anything. */
const JSON_WRITE_PATHS = [SESSION_SYNC_CONFIG_PATH, SESSION_SYNC_EXPORT_PATH] as const

describe('session-sync Web plugin', () => {
  describe('route registration', () => {
    it('claims the page path and every API path from routes.ts', () => {
      const mount = mountWeb()
      expect(mount.pageRoutes.map(route => [route.kind, route.path])).toEqual([['exact', SESSION_SYNC_PAGE_PATH]])
      expect(mount.apiRoutes.map(route => [route.path, route.methods, route.requestBody])).toEqual([
        [SESSION_SYNC_CONFIG_PATH, ['GET'], 'buffered'],
        [SESSION_SYNC_CONFIG_PATH, ['POST'], 'buffered'],
        [SESSION_SYNC_SESSIONS_PATH, ['GET'], 'buffered'],
        [SESSION_SYNC_EXPORT_PATH, ['POST'], 'buffered'],
        [SESSION_SYNC_IMPORT_PATH, ['POST'], 'buffered'],
        [SESSION_SYNC_SCAN_PATH, ['POST'], 'buffered'],
        [SESSION_SYNC_OPERATIONS_PATH, ['GET'], 'buffered'],
        [`${SESSION_SYNC_OPERATION_PREFIX}*`, ['GET'], 'buffered'],
      ])
    })

    it('releases the page route when the plugin fiber disposes', async () => {
      const mount = mountWeb()
      expect(mount.pageRoutes).toHaveLength(1)
      await mount.ctx.fiber.dispose()
      expect(mount.pageRoutes).toEqual([])
    })
  })

  describe('the page route', () => {
    it('serves the static self-contained document with HTML no-store headers for GET', async () => {
      const mount = mountWeb()
      const response = await servePageRequest(mount, 'GET')
      expect(response.statusCode).toBe(200)
      expect(response.header('content-type')).toBe('text/html; charset=utf-8')
      expect(response.header('cache-control')).toBe('no-store')
      const html = pageBody(response)
      expect(html).toBe(sessionSyncPageHtml())
      expect(html.startsWith('<!doctype html>')).toBe(true)
    })

    it('answers HEAD exactly like GET and writes no body', async () => {
      const mount = mountWeb()
      const get = await servePageRequest(mount, 'GET')
      const head = await servePageRequest(mount, 'HEAD')
      expect(head.statusCode).toBe(200)
      expect(head.header('content-type')).toBe(get.header('content-type'))
      expect(head.header('cache-control')).toBe(get.header('cache-control'))
      expect(head.header('content-length')).toBe(String(Buffer.byteLength(pageBody(get))))
      expect(head.bodies).toEqual([undefined])
    })

    it('refuses a write method with an Allow header', async () => {
      const mount = mountWeb()
      const response = await servePageRequest(mount, 'POST')
      expect(response.statusCode).toBe(405)
      expect(response.header('allow')).toBe('GET, HEAD')
      expect(response.bodies).toEqual([undefined])
    })

    it('names no host data and polls only the same-origin routes from routes.ts', async () => {
      const mount = mountWeb()
      mount.service.root = '/srv/secret-root'
      mount.service.rootDiagnostic = 'the root is unreadable'
      mount.service.sessions = [{ sessionId: 'session-secret', createdAt: 1, live: true, persisted: true, archived: false }]
      // One accepted operation exists on the host while the page is served.
      await deliver(mount, jsonRequest('POST', SESSION_SYNC_SCAN_PATH, {}))

      const html = pageBody(await servePageRequest(mount, 'GET'))
      // Nothing the host holds is rendered into the document.
      expect(html.includes('session-secret')).toBe(false)
      expect(html.includes('op-1')).toBe(false)
      expect(html.includes('/srv/secret-root')).toBe(false)
      expect(html.includes('the root is unreadable')).toBe(false)
      // The script is self-contained and reaches only same-origin paths.
      expect(/https?:\/\//u.test(html)).toBe(false)
      expect(pageCalls(html).map(call => `${call.method} ${call.path}`).sort()).toEqual([
        `GET ${SESSION_SYNC_CONFIG_PATH}`,
        `GET ${SESSION_SYNC_OPERATIONS_PATH}`,
        `GET ${SESSION_SYNC_SESSIONS_PATH}`,
        `POST ${SESSION_SYNC_CONFIG_PATH}`,
        `POST ${SESSION_SYNC_EXPORT_PATH}`,
        `POST ${SESSION_SYNC_IMPORT_PATH}`,
        `POST ${SESSION_SYNC_SCAN_PATH}`,
      ].sort())
    })
  })

  describe('the configuration API', () => {
    it('reports the configured root, no diagnostic, and the composed backend', async () => {
      const mount = mountWeb()
      mount.service.root = '/srv/cloud/session-sync'
      mount.service.backend = 'dir'
      const response = await deliver(mount, request('GET', SESSION_SYNC_CONFIG_PATH))
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await jsonBody(response)).toEqual({ root: '/srv/cloud/session-sync', backend: 'dir' })
    })

    it('reports the diagnostic for an unusable root and no root once it is unset', async () => {
      const mount = mountWeb()
      // The service owns root validation; the route only projects its status.
      mount.service.root = 'relative/root'
      mount.service.rootDiagnostic = "'relative/root' is not a fully qualified directory path"
      mount.service.backend = 'dir'
      expect(await jsonBody(await deliver(mount, request('GET', SESSION_SYNC_CONFIG_PATH)))).toEqual({
        root: 'relative/root',
        rootDiagnostic: "'relative/root' is not a fully qualified directory path",
        backend: 'dir',
      })
      mount.service.root = undefined
      mount.service.rootDiagnostic = undefined
      expect(await jsonBody(await deliver(mount, request('GET', SESSION_SYNC_CONFIG_PATH)))).toEqual({ backend: 'dir' })
    })

    it('saves the given root through settings and reports it as effective', async () => {
      const mount = mountWeb()
      mount.service.backend = 'dir'
      const response = await deliver(mount, jsonRequest('POST', SESSION_SYNC_CONFIG_PATH, { root: '/srv/cloud/next' }))
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(settingsOf(mount).writes).toEqual([{ ns: 'session-sync', patch: { root: '/srv/cloud/next' } }])
      expect(await jsonBody(response)).toEqual({ root: '/srv/cloud/next', effectiveRoot: '/srv/cloud/next' })
    })

    it('clears the root when the body carries none, and never claims the old one is effective', async () => {
      const mount = mountWeb()
      mount.service.root = '/srv/cloud/previous'
      mount.service.backend = 'dir'
      const response = await deliver(mount, jsonRequest('POST', SESSION_SYNC_CONFIG_PATH, {}))
      expect(response.status).toBe(200)
      expect(settingsOf(mount).writes).toEqual([{ ns: 'session-sync', patch: { root: null } }])
      expect(await jsonBody(response)).toEqual({})
    })

    it('reports a failed settings write as a failure and never as an effective value', async () => {
      const mount = mountWeb()
      mount.service.root = '/srv/cloud/previous'
      mount.service.backend = 'dir'
      settingsOf(mount).failure = new Error('settings store is read-only')
      const response = await deliver(mount, jsonRequest('POST', SESSION_SYNC_CONFIG_PATH, { root: '/srv/cloud/next' }))
      expect(response.status).toBe(500)
      const body = await jsonBody(response)
      expect(body).toEqual({ message: expect.stringContaining('configuration save failed') })
      expect(messageOf(body)).toContain('settings store is read-only')
      expect(messageOf(body)).toContain('previous value is still in effect')
      // The refused write changed nothing: the previous root stays configured.
      expect(settingsOf(mount).writes).toEqual([])
      expect(mount.service.root).toBe('/srv/cloud/previous')
    })

    it('reports configuration as unavailable when no settings service is composed', async () => {
      const mount = mountWeb({ settings: false })
      const response = await deliver(mount, jsonRequest('POST', SESSION_SYNC_CONFIG_PATH, { root: '/srv/cloud' }))
      expect(response.status).toBe(503)
      expect(await jsonBody(response)).toEqual({ message: 'configuration is unavailable: no settings service is composed' })
    })

    it.each(WRITE_PATHS)('refuses a %s write whose media type is not application/json', async (path) => {
      const mount = mountWeb()
      const form = await deliver(mount, rawRequest('POST', path, '{"root":"/srv/cloud"}', 'text/plain'))
      expect(form.status).toBe(415)
      expect(await jsonBody(form)).toEqual({ message: 'content type must be application/json' })
      // A form post cannot carry the JSON media type, so this is the CSRF rule.
      const untyped = await deliver(mount, rawRequest('POST', path, '{"root":"/srv/cloud"}'))
      expect(untyped.status).toBe(415)
      expect(settingsOf(mount).writes).toEqual([])
      expect(mount.service.submissions).toEqual([])
    })

    it.each(JSON_WRITE_PATHS)('refuses a %s write whose JSON body is malformed', async (path) => {
      const mount = mountWeb()
      const response = await deliver(mount, rawRequest('POST', path, '{"root":', 'application/json'))
      expect(response.status).toBe(400)
      expect(await jsonBody(response)).toEqual({ message: 'request body is not JSON' })
      expect(settingsOf(mount).writes).toEqual([])
      expect(mount.service.submissions).toEqual([])
    })

    it.each(['null', '"root"', '[]', '{"root":42}'])('refuses a config body that is not an object with a string root: %s', async (body) => {
      const mount = mountWeb()
      const response = await deliver(mount, rawRequest('POST', SESSION_SYNC_CONFIG_PATH, body, 'application/json'))
      expect(response.status).toBe(400)
      expect(await jsonBody(response)).toEqual({ message: 'request body must carry a string root' })
      expect(settingsOf(mount).writes).toEqual([])
    })

    it('refuses a body past the size ceiling before reaching settings', async () => {
      const mount = mountWeb()
      const response = await deliver(mount, rawRequest(
        'POST',
        SESSION_SYNC_CONFIG_PATH,
        JSON.stringify({ root: 'x'.repeat(70 * 1024) }),
        'application/json',
      ))
      expect(response.status).toBe(413)
      expect(await jsonBody(response)).toEqual({ message: 'request body exceeds the size limit' })
      expect(settingsOf(mount).writes).toEqual([])
    })
  })

  describe('the session and operation API', () => {
    it('lists the service root-session snapshot newest first, archived session marked', async () => {
      const mount = mountWeb()
      mount.service.sessions = ROOT_SESSIONS
      const response = await deliver(mount, request('GET', SESSION_SYNC_SESSIONS_PATH))
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      // The fixture is newest first and the route carries that order verbatim.
      expect(ROOT_SESSIONS.map(session => session.createdAt)).toEqual([3_000, 1_000])
      expect(await jsonBody(response)).toEqual({ sessions: ROOT_SESSIONS })
      // The list is the live service snapshot, not a value captured at mount.
      mount.service.sessions = []
      expect(await jsonBody(await deliver(mount, request('GET', SESSION_SYNC_SESSIONS_PATH)))).toEqual({ sessions: [] })
    })

    it.each(['{}', '{"sessionId":""}', '{"sessionId":42}', '[]'])('refuses an export without a usable sessionId: %s', async (body) => {
      const mount = mountWeb()
      const response = await deliver(mount, rawRequest('POST', SESSION_SYNC_EXPORT_PATH, body, 'application/json'))
      expect(response.status).toBe(400)
      expect(await jsonBody(response)).toEqual({ message: 'request body must carry a sessionId' })
      expect(mount.service.submissions).toEqual([])
    })

    it('submits the named export and answers 202 with the operation id', async () => {
      const mount = mountWeb()
      mount.service.root = '/srv/cloud'
      const response = await deliver(mount, jsonRequest('POST', SESSION_SYNC_EXPORT_PATH, { sessionId: 'session-newest' }))
      expect(response.status).toBe(202)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await acceptedId(response)).toBe('op-1')
      expect(mount.service.submissions).toEqual([{ kind: 'export', sessionId: 'session-newest' }])
    })

    it.each(SUBMISSION_CASES)('submits one $kind and answers 202 with the operation id', async ({ kind, path, body }) => {
      const mount = mountWeb()
      mount.service.root = '/srv/cloud'
      const response = await deliver(mount, jsonRequest('POST', path, body))
      expect(response.status).toBe(202)
      expect(await acceptedId(response)).toBe('op-1')
      expect(mount.service.submissions).toHaveLength(1)
      expect(mount.service.submissions[0]?.kind).toBe(kind)
    })

    it.each(SUBMISSION_CASES)('answers 409 with the service refusal when $kind finds it busy', async ({ path, body }) => {
      const mount = mountWeb()
      mount.service.failure = new Error('session-sync: an operation is already running')
      const response = await deliver(mount, jsonRequest('POST', path, body))
      expect(response.status).toBe(409)
      expect(await jsonBody(response)).toEqual({ message: 'session-sync: an operation is already running' })
      expect(mount.service.submissions).toEqual([])
    })

    it('answers 400, not 500, when the service refuses a submission for another reason', async () => {
      const mount = mountWeb()
      mount.service.failure = new Error('session-sync: no sync root is configured')
      const response = await deliver(mount, jsonRequest('POST', SESSION_SYNC_SCAN_PATH, {}))
      expect(response.status).toBe(400)
      expect(await jsonBody(response)).toEqual({ message: 'session-sync: no sync root is configured' })
    })

    it('lists every operation in acceptance order', async () => {
      const mount = mountWeb()
      mount.service.root = '/srv/cloud'
      const first = await acceptedId(await deliver(mount, jsonRequest('POST', SESSION_SYNC_EXPORT_PATH, { sessionId: 'session-newest' })))
      const second = await acceptedId(await deliver(mount, jsonRequest('POST', SESSION_SYNC_IMPORT_PATH, {})))
      const third = await acceptedId(await deliver(mount, jsonRequest('POST', SESSION_SYNC_SCAN_PATH, {})))
      expect([first, second, third]).toEqual(['op-1', 'op-2', 'op-3'])
      const response = await deliver(mount, request('GET', SESSION_SYNC_OPERATIONS_PATH))
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await jsonBody(response)).toEqual({
        operations: [
          { id: first, kind: 'export', submittedAt: 1_001, root: '/srv/cloud', status: 'accepted' },
          { id: second, kind: 'import', submittedAt: 1_002, root: '/srv/cloud', status: 'accepted' },
          { id: third, kind: 'scan', submittedAt: 1_003, root: '/srv/cloud', status: 'accepted' },
        ],
      })
    })

    it('returns one operation record and answers 404 for an unknown id', async () => {
      const mount = mountWeb()
      mount.service.root = '/srv/cloud'
      const id = await acceptedId(await deliver(mount, jsonRequest('POST', SESSION_SYNC_SCAN_PATH, {})))
      const found = await deliver(mount, request('GET', `${SESSION_SYNC_OPERATION_PREFIX}${id}`))
      expect(found.status).toBe(200)
      expect(found.headers.get('cache-control')).toBe('no-store')
      expect(await jsonBody(found)).toEqual({
        id,
        kind: 'scan',
        submittedAt: 1_001,
        root: '/srv/cloud',
        status: 'accepted',
      })
      const missing = await deliver(mount, request('GET', `${SESSION_SYNC_OPERATION_PREFIX}op-404`))
      expect(missing.status).toBe(404)
      expect(await jsonBody(missing)).toEqual({ message: 'unknown operation' })
      // The id is one decoded path segment, so an encoded id still resolves.
      mount.service.records.push({ id: 'op/encoded id', kind: 'import', submittedAt: 1_004, root: '/srv/cloud', status: 'running' })
      const encoded = await deliver(mount, request('GET', `${SESSION_SYNC_OPERATION_PREFIX}${encodeURIComponent('op/encoded id')}`))
      expect(encoded.status).toBe(200)
      expect(await jsonBody(encoded)).toEqual({
        id: 'op/encoded id',
        kind: 'import',
        submittedAt: 1_004,
        root: '/srv/cloud',
        status: 'running',
      })
    })
  })

  describe('page and API agreement', () => {
    it('makes every call the browser makes dispatchable by a registered route', () => {
      const mount = mountWeb()
      const calls = pageCalls(sessionSyncPageHtml())
      // A drift between the page's method and the registered route is invisible
      // to every API test above: it breaks only the browser.
      for (const call of calls) {
        expect(mount.apiRoutes.some(route => routeOwns(route, call.path) && route.methods.some(method => method === call.method))).toBe(true)
      }
      expect(calls.filter(call => call.path === SESSION_SYNC_CONFIG_PATH).map(call => call.method).sort()).toEqual(['GET', 'POST'])
    })
  })
})
