/** The export submission/polling client: submission refusals and settlement mapping. */
import { describe, expect, it } from 'vitest'
import { exportSessionTree } from '../src/client/api.ts'

/** A fetch double resolving one canned response. */
function fetchOf(responses: readonly (Response | Error)[]): typeof fetch {
  let index = 0
  return (() => {
    const response = responses[index]
    index += 1
    if (response instanceof Error) return Promise.reject(response)
    return Promise.resolve(response)
  }) as unknown as typeof fetch
}

/** A JSON response with the given status and body. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** An immediate no-op wait, so polls spin without real timers. */
const noDelay = (): Promise<void> => Promise.resolve()

describe('exportSessionTree', () => {
  it('submits, polls a running operation, and reports the exported tree', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input)
      calls.push(`${String(init?.method ?? 'GET')} ${url}`)
      if (url === '/api/session-sync/export') {
        expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
        expect(init?.body).toBe(JSON.stringify({ sessionId: 'session-child' }))
        return Promise.resolve(json(202, { id: 'op-1' }))
      }
      if (url === '/api/session-sync/operation/op-1') {
        return Promise.resolve(json(200, calls.length <= 2
          ? { id: 'op-1', kind: 'export', status: 'running' }
          : {
              id: 'op-1', kind: 'export', status: 'complete',
              result: { trees: [{ rootSessionId: 'session-root', status: 'exported', sessions: [{ sessionId: 'session-root', status: 'exported' }, { sessionId: 'session-child', status: 'exported' }] }] },
            }))
      }
      return Promise.resolve(json(404, { message: 'unknown operation' }))
    }
    const outcome = await exportSessionTree('session-child', fetchImpl, noDelay)
    expect(outcome).toEqual({ kind: 'exported', rootSessionId: 'session-root', count: 2 })
    expect(calls[0]).toBe('POST /api/session-sync/export')
    expect(calls.at(-1)).toBe('GET /api/session-sync/operation/op-1')
  })

  it('maps a busy refusal to a readable failure without polling', async () => {
    const fetchImpl = fetchOf([json(409, { message: 'an operation is already running' })])
    const outcome = await exportSessionTree('session-root', fetchImpl, noDelay)
    expect(outcome).toEqual({ kind: 'failed', reason: 'an operation is already running' })
  })

  it('maps a settled failed operation to its rendered reason', async () => {
    const fetchImpl = fetchOf([
      json(202, { id: 'op-2' }),
      json(200, { id: 'op-2', kind: 'export', status: 'failed', error: 'the configured root is unusable' }),
    ])
    const outcome = await exportSessionTree('session-root', fetchImpl, noDelay)
    expect(outcome).toEqual({ kind: 'failed', reason: 'the configured root is unusable' })
  })

  it('maps a completed tree that did not export to its reason', async () => {
    const fetchImpl = fetchOf([
      json(202, { id: 'op-3' }),
      json(200, {
        id: 'op-3', kind: 'export', status: 'complete',
        result: { trees: [{ rootSessionId: 'session-root', status: 'failed', reason: 'lineage incomplete', sessions: [] }] },
      }),
    ])
    const outcome = await exportSessionTree('session-root', fetchImpl, noDelay)
    expect(outcome).toEqual({ kind: 'failed', reason: 'lineage incomplete' })
  })

  it('reports a transport failure of the submission itself', async () => {
    const fetchImpl = fetchOf([new Error('network unreachable')])
    const outcome = await exportSessionTree('session-root', fetchImpl, noDelay)
    expect(outcome).toEqual({ kind: 'failed', reason: 'network unreachable' })
  })
})
