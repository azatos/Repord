import { describe, expect, it } from 'vitest'
import { createSessionApi, MAX_SESSION_REQUEST_BODY_BYTES, type AuthVerifier } from './session-api'
import { InMemorySessionRepository, SessionService, type SessionRepository, type StoredSession } from '../lib/session-service'

const json = { 'content-type': 'application/json', authorization: 'Bearer owner' }
const request = (path: string, init: RequestInit = {}) => new Request(`https://example.test${path}`, { ...init, headers: { ...json, ...init.headers } })
const auth: AuthVerifier = { async verify(request) { return request.headers.get('authorization') === 'Bearer owner' ? { ownerId: 'owner-synthetic' } : request.headers.get('authorization') === 'Bearer other' ? { ownerId: 'other-synthetic' } : undefined } }
const session = (id = 'session-synthetic') => ({ protocolVersion: 1, sessionId: id })
const chunk = (overrides: Record<string, unknown> = {}) => ({ protocolVersion: 1, sessionId: 'session-synthetic', chunkId: 'chunk-synthetic', sequence: 0, captureStartMs: 0, captureEndMs: 1, mimeType: 'audio/mp4', byteLength: 1, sha256: 'a'.repeat(64), continuityState: 'observed-continuous', confirmedGaps: [], ...overrides })
function setup(repository: SessionRepository = new InMemorySessionRepository()) { return createSessionApi(new SessionService(repository), auth) }
async function create(api: ReturnType<typeof setup>, body: unknown = session()) { return api(request('/api/v1/sessions', { method: 'POST', body: JSON.stringify(body) })) }
async function start(api: ReturnType<typeof setup>, tag = '"0"') { return api(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': tag } })) }
function assertPublic(response: Response) {
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
}

describe('session API', () => {
  it('uses exact public envelopes, security headers, ETags, and no sensitive fields', async () => {
    const response = await create(setup())
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ data: { protocolVersion: 1, sessionId: 'session-synthetic', state: 'created', revision: 0, receivedChunkCount: 0, receivedSequences: [], confirmedGapCount: 0, continuitySummary: 'not-observed' } })
    expect(response.headers.get('etag')).toBe('"0"'); expect(response.headers.get('location')).toBe('/api/v1/sessions/session-synthetic')
    assertPublic(response)
    expect(JSON.stringify(await (await create(setup())).json())).not.toMatch(/owner|token|sha256|digest|raw/i)
  })
  it('authenticates before route and body handling, and hides cross-owner sessions using one service', async () => {
    let reads = 0; let creates = 0; const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads += 1; controller.enqueue(new Uint8Array([123])); controller.close() } }, { highWaterMark: 0 })
    const repository: SessionRepository = { async get() { throw new Error('unused') }, async create() { creates += 1; return true }, async compareAndSet() { throw new Error('unused') } }
    const api = setup(repository); const unauthenticated = new Request('https://example.test/nope', { method: 'POST', body: stream, duplex: 'half' } as RequestInit); const baseline = reads
    const unauthorized = await api(unauthenticated); expect(unauthorized.status).toBe(401); expect(reads).toBe(baseline); expect(creates).toBe(0); expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer'); expect(JSON.stringify(await unauthorized.json())).not.toContain('Bearer owner'); assertPublic(unauthorized)
    await create(api)
    const other = await api(request('/api/v1/sessions/session-synthetic', { headers: { authorization: 'Bearer other' } }))
    expect(other.status).toBe(404); expect(await other.json()).toEqual({ error: { code: 'not-found' } })
  })
  it('runs the complete lifecycle and preserves an ETag for duplicate chunks', async () => {
    const api = setup(); await create(api); expect((await start(api)).headers.get('etag')).toBe('"1"')
    const accepted = await api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk()) }))
    expect(accepted.headers.get('etag')).toBe('"2"')
    const duplicate = await api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify(chunk()) }))
    expect(duplicate.headers.get('etag')).toBe('"2"')
    const finalized = await api(request('/api/v1/sessions/session-synthetic/finalize', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify({ protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 0 }) }))
    expect(finalized.headers.get('etag')).toBe('"3"'); expect(await finalized.json()).toMatchObject({ data: { revision: 3, state: 'finalizing' } })
    const deleted = await api(request('/api/v1/sessions/session-synthetic', { method: 'DELETE', headers: { 'if-match': '"3"' } }))
    expect(deleted.headers.get('etag')).toBe('"4"'); expect(await deleted.json()).toMatchObject({ data: { revision: 4, state: 'deleted' } })
  })
  it('rejects every non-exact If-Match form and maps a real CAS race to 409', async () => {
    const api = setup(); await create(api)
    const missing = await api(request('/api/v1/sessions/session-synthetic/start', { method: 'POST' }))
    expect(missing.status).toBe(428); expect(await missing.json()).toEqual({ error: { code: 'precondition-required' } })
    for (const value of ['*', 'W/"0"', '"0", "1"', '0', '"00"', '"-1"', '"9007199254740992"']) {
      const response = await api(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': value } }))
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: { code: 'invalid-precondition' } })
    }
    await start(api); const [left, right] = await Promise.all([api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk()) })), api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify({ ...chunk(), chunkId: 'other', sequence: 1 }) }))])
    expect([left.status, right.status].sort()).toEqual([200, 409])
  })
  it('enforces JSON UTF-8/media type, strict routes, session-id bounds, and the 64 KiB boundary', async () => {
    const api = setup()
    expect((await api(request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))).status).toBe(415)
    expect((await api(request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json; charset=latin1' }, body: '{}' }))).status).toBe(415)
    const malformed = await api(request('/api/v1/sessions', { method: 'POST', body: '{' })); expect(malformed.status).toBe(400); assertPublic(malformed)
    expect((await api(request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: '{' }))).status).toBe(400)
    expect((await api(request('/api/v1/sessions?x=1', { method: 'POST', body: '{}' }))).status).toBe(404)
    expect((await api(request('/api/v1/sessions/%73', { method: 'GET' }))).status).toBe(404)
    expect((await api(request(`/api/v1/sessions/${'a'.repeat(129)}`, { method: 'GET' }))).status).toBe(404)
    const invalidUtf8 = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0xc3, 0x28])); c.close() } })
    expect((await api(request('/api/v1/sessions', { method: 'POST', body: invalidUtf8, duplex: 'half' } as RequestInit))).status).toBe(400)
    const tooBig = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_SESSION_REQUEST_BODY_BYTES + 1)); c.close() } })
    const tooLarge = await api(request('/api/v1/sessions', { method: 'POST', body: tooBig, duplex: 'half' } as RequestInit)); expect(tooLarge.status).toBe(413); assertPublic(tooLarge)
    const exact = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_SESSION_REQUEST_BODY_BYTES)); c.close() } })
    expect((await api(request('/api/v1/sessions', { method: 'POST', body: exact, duplex: 'half' } as RequestInit))).status).toBe(400)
  })
  it('sanitizes unexpected failures', async () => {
    const api = createSessionApi(new SessionService(new InMemorySessionRepository()), { async verify() { throw new Error('credential-secret') } })
    const response = await api(request('/api/v1/sessions')); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: { code: 'internal-error' } })
  })
  it('returns exact conflict bodies and does not disclose successful chunk metadata', async () => {
    const api = setup(); await create(api); await start(api)
    const added = await api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk({ mimeType: 'audio/sentinel', captureStartMs: 7777, captureEndMs: 8888, sha256: 'b'.repeat(64) })) }))
    expect(added.status).toBe(200)
    expect(JSON.stringify(await added.json())).not.toMatch(/audio\/sentinel|7777|bbbb/)
    const stale = await api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk({ chunkId: 'stale', sequence: 1 })) })); expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: { code: 'version-conflict' } }); assertPublic(stale)
    const second = await api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify(chunk({ chunkId: 'second', sequence: 1 })) })); expect(second.status).toBe(200)
    const final = await api(request('/api/v1/sessions/session-synthetic/finalize', { method: 'POST', headers: { 'if-match': '"3"' }, body: JSON.stringify({ protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 0 }) })); expect(final.status).toBe(409); expect(await final.json()).toEqual({ error: { code: 'final-sequence-conflict' } }); assertPublic(final)
  })
  it('uses public headers for representative 200, 405, and 428 responses and sanitizes repository errors', async () => {
    const api = setup(); await create(api)
    const read = await api(request('/api/v1/sessions/session-synthetic')); const method = await api(request('/api/v1/sessions/session-synthetic', { method: 'PUT' })); const precondition = await api(request('/api/v1/sessions/session-synthetic/start', { method: 'POST' }))
    for (const response of [read, method, precondition]) assertPublic(response)
    class ThrowingRepository implements SessionRepository { async get(): Promise<StoredSession | undefined> { throw new Error('repository-secret') }; async create(): Promise<boolean> { throw new Error('repository-secret') }; async compareAndSet(): Promise<boolean> { throw new Error('repository-secret') } }
    const response = await create(setup(new ThrowingRepository())); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: { code: 'internal-error' } }); assertPublic(response)
  })
})
