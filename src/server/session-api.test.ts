import { describe, expect, it } from 'vitest'
import { createSessionApi, MAX_SESSION_REQUEST_BODY_BYTES, type AuthVerifier } from './session-api'
import { InMemorySessionRepository, SessionService, type SessionRepository, type StoredSession } from '../lib/session-service'

const headers = { authorization: 'Bearer owner', 'content-type': 'application/json' }
const request = (path: string, init: RequestInit = {}) => new Request(`https://example.test${path}`, { ...init, headers: { ...headers, ...init.headers } })
const auth: AuthVerifier = { async verify(r) { return r.headers.get('authorization') === 'Bearer owner' ? { ownerId: 'owner-synthetic' } : r.headers.get('authorization') === 'Bearer other' ? { ownerId: 'other-synthetic' } : undefined } }
const session = (sessionId = 'session-synthetic') => ({ protocolVersion: 1, sessionId })
const chunk = (overrides = {}) => ({ protocolVersion: 1, sessionId: 'session-synthetic', chunkId: 'chunk-synthetic', sequence: 0, captureStartMs: 0, captureEndMs: 1, mimeType: 'audio/mp4', byteLength: 1, sha256: 'a'.repeat(64), continuityState: 'observed-continuous', confirmedGaps: [], ...overrides })
function api(repository: SessionRepository = new InMemorySessionRepository()) { return createSessionApi(new SessionService(repository), auth) }
async function create(handler: ReturnType<typeof api>, body = session()) { return handler(request('/api/v1/sessions', { method: 'POST', body: JSON.stringify(body) })) }
function assertPublic(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
}

describe('session API', () => {
  it('does not pull unauthenticated create bodies or invoke the repository/service', async () => {
    let pulls = 0; let creates = 0
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; c.enqueue(new Uint8Array([123])); c.close() } }, { highWaterMark: 0 })
    const repository: SessionRepository = { async get() { throw new Error('must not read') }, async create() { creates += 1; return true }, async compareAndSet() { throw new Error('must not write') } }
    const handler = createSessionApi(new SessionService(repository), auth)
    const unauthenticated = new Request('https://example.test/api/v1/sessions', { method: 'POST', body: stream, duplex: 'half' } as RequestInit); const baseline = pulls
    const response = await handler(unauthenticated)
    expect(response.status).toBe(401); expect(pulls).toBe(baseline); expect(creates).toBe(0); assertPublic(response)
  })
  it('verifies every lifecycle status, revision, and ETag', async () => {
    const handler = api()
    const created = await create(handler); expect(created.status).toBe(201); expect(created.headers.get('etag')).toBe('"0"'); expect((await created.json() as { data: { revision: number } }).data.revision).toBe(0)
    const read = await handler(request('/api/v1/sessions/session-synthetic')); expect(read.status).toBe(200); expect(read.headers.get('etag')).toBe('"0"')
    const started = await handler(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"0"' } })); expect(started.status).toBe(200); expect(started.headers.get('etag')).toBe('"1"')
    const added = await handler(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk()) })); expect(added.status).toBe(200); expect(added.headers.get('etag')).toBe('"2"')
    const finalized = await handler(request('/api/v1/sessions/session-synthetic/finalize', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify({ protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 0 }) })); expect(finalized.status).toBe(200); expect(finalized.headers.get('etag')).toBe('"3"')
    const deleted = await handler(request('/api/v1/sessions/session-synthetic', { method: 'DELETE', headers: { 'if-match': '"3"' } })); expect(deleted.status).toBe(200); expect(deleted.headers.get('etag')).toBe('"4"')
  })
  it('makes cross-owner and nonexistent reads identically public', async () => {
    const handler = api(); await create(handler)
    const other = await handler(request('/api/v1/sessions/session-synthetic', { headers: { authorization: 'Bearer other' } }))
    const absent = await handler(request('/api/v1/sessions/absent', { headers: { authorization: 'Bearer other' } }))
    expect(other.status).toBe(absent.status); expect(await other.json()).toEqual(await absent.json())
  })
  it('does not let body, query, or header owner IDs replace verifier identity', async () => {
    const handler = api()
    const body = await create(handler, { ...session(), ownerId: 'other-synthetic' }); expect(body.status).toBe(400); expect(JSON.stringify(await body.json())).not.toContain('other-synthetic')
    const query = await handler(request('/api/v1/sessions?ownerId=other-synthetic', { method: 'POST', body: JSON.stringify(session()) })); expect(query.status).toBe(404)
    await create(handler, session('owned')); const header = await handler(request('/api/v1/sessions/owned', { headers: { ownerid: 'other-synthetic' } })); expect(header.status).toBe(200)
  })
  it('enforces content length, valid 65,536-byte JSON, UTF-8, and a failed cancellation', async () => {
    const handler = api()
    const early = await handler(request('/api/v1/sessions', { method: 'POST', headers: { 'content-length': '65537' }, body: '{}' })); expect(early.status).toBe(413)
    const source = JSON.stringify(session('exact-boundary')); const exact = `${source}${' '.repeat(MAX_SESSION_REQUEST_BODY_BYTES - new TextEncoder().encode(source).byteLength)}`
    const accepted = await handler(request('/api/v1/sessions', { method: 'POST', body: exact })); expect(accepted.status).toBe(201)
    expect((await handler(request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json; charset=latin1' }, body: '{}' }))).status).toBe(415)
    const invalidUtf8 = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0xc3, 0x28])); c.close() } }); expect((await handler(request('/api/v1/sessions', { method: 'POST', body: invalidUtf8, duplex: 'half' } as RequestInit))).status).toBe(400)
    const oversized = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(MAX_SESSION_REQUEST_BODY_BYTES + 1)); c.error(new Error('cancel fails')) } }); expect((await handler(request('/api/v1/sessions', { method: 'POST', body: oversized, duplex: 'half' } as RequestInit))).status).toBe(413)
  })
  it('maps all service conflicts to 409, including stale CAS and missing chunks', async () => {
    const handler = api(); await create(handler); expect((await create(handler)).status).toBe(409)
    await handler(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"0"' } }))
    expect((await handler(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"1"' } }))).status).toBe(409)
    expect((await handler(request('/api/v1/sessions/session-synthetic/finalize', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify({ protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 1 }) }))).status).toBe(409)
    await handler(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk()) }))
    expect((await handler(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify(chunk({ sha256: 'b'.repeat(64) })) }))).status).toBe(409)
    expect((await handler(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify(chunk({ chunkId: 'other' })) }))).status).toBe(409)
    expect((await handler(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk({ chunkId: 'stale', sequence: 2 })) }))).status).toBe(409)
    expect((await handler(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify(chunk({ chunkId: 'second', sequence: 1 })) }))).status).toBe(200)
    expect((await handler(request('/api/v1/sessions/session-synthetic/finalize', { method: 'POST', headers: { 'if-match': '"3"' }, body: JSON.stringify({ protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 0 }) }))).status).toBe(409)
  })
  it('applies public security headers and non-disclosure to all response status classes', async () => {
    const handler = api(); const responses = [await create(handler), await handler(request('/api/v1/sessions/session-synthetic')), await handler(request('/api/v1/sessions/session-synthetic/start', { method: 'POST' })), await handler(request('/api/v1/sessions/session-synthetic', { method: 'PUT' })), await handler(request('/api/v1/nope')), await handler(new Request('https://example.test/api/v1/sessions')), await handler(request('/api/v1/sessions', { method: 'POST', body: '{' })), await handler(request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })]
    await handler(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"0"' } })); responses.push(await handler(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"1"' } })), await handler(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_SESSION_REQUEST_BODY_BYTES + 1)); c.close() } }), duplex: 'half' } as RequestInit)))
    const broken: SessionRepository = { async get() { throw new Error('secret') }, async create() { throw new Error('secret') }, async compareAndSet() { throw new Error('secret') } }
    responses.push(await create(api(broken)))
    for (const response of responses) { assertPublic(response); expect(JSON.stringify(await response.json())).not.toMatch(/owner-synthetic|token|sha256|digest|raw|secret/i) }
  })
  it('distinguishes If-Match forms and sanitizes dependency errors', async () => {
    const handler = api(); await create(handler)
    expect((await handler(request('/api/v1/sessions/session-synthetic/start', { method: 'POST' }))).status).toBe(428)
    for (const value of ['*', 'W/"0"', '"0", "1"', '"9007199254740992"']) expect((await handler(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': value } }))).status).toBe(400)
    class BrokenRepository implements SessionRepository { async get(): Promise<StoredSession | undefined> { throw new Error('secret') }; async create(): Promise<boolean> { throw new Error('secret') }; async compareAndSet(): Promise<boolean> { throw new Error('secret') } }
    const response = await create(api(new BrokenRepository())); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: { code: 'internal-error' } })
  })
})
