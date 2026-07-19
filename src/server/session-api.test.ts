import { describe, expect, it } from 'vitest'
import { createSessionApi, MAX_SESSION_REQUEST_BODY_BYTES, type AuthVerifier } from './session-api'
import { InMemorySessionRepository, SessionService } from '../lib/session-service'

const baseHeaders = { authorization: 'Bearer owner', 'content-type': 'application/json' }
const req = (path: string, init: RequestInit = {}) => new Request(`https://example.test${path}`, { ...init, headers: { ...baseHeaders, ...init.headers } })
const verifier: AuthVerifier = { async verify(request) { return request.headers.get('authorization') === 'Bearer owner' ? { ownerId: 'owner-synthetic' } : request.headers.get('authorization') === 'Bearer other' ? { ownerId: 'other-synthetic' } : undefined } }
const command = (sessionId = 'session-synthetic') => ({ protocolVersion: 1, sessionId })
const metadata = (overrides = {}) => ({ protocolVersion: 1, sessionId: 'session-synthetic', chunkId: 'chunk-sentinel', sequence: 0, captureStartMs: 7_777, captureEndMs: 8_888, mimeType: 'audio/sentinel', byteLength: 1, sha256: 'a'.repeat(64), continuityState: 'observed-continuous', confirmedGaps: [], ...overrides })
const handler = () => createSessionApi(new SessionService(new InMemorySessionRepository()), verifier)
const create = (api: ReturnType<typeof handler>, body = command()) => api(req('/api/v1/sessions', { method: 'POST', body: JSON.stringify(body) }))
function assertPublic(response: Response) {
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('referrer-policy')).toBe('no-referrer'); expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
}

describe('session API', () => {
  it('does not consume unauthenticated POST bodies and returns the exact 401 contract', async () => {
    let pulls = 0; const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; c.enqueue(new Uint8Array([123])); c.close() } }, { highWaterMark: 0 })
    const request = new Request('https://example.test/api/v1/sessions', { method: 'POST', body: stream, duplex: 'half' } as RequestInit); const baseline = pulls
    const response = await handler()(request)
    expect(response.status).toBe(401); expect(pulls).toBe(baseline); expect(response.headers.get('www-authenticate')).toBe('Bearer'); expect(await response.json()).toEqual({ error: { code: 'unauthorized' } }); assertPublic(response)
  })
  it('uses the create envelope/location and complete lifecycle statuses, bodies, revisions, and ETags', async () => {
    const api = handler(); const created = await create(api); expect(created.status).toBe(201); expect(created.headers.get('location')).toBe('/api/v1/sessions/session-synthetic'); expect(created.headers.get('etag')).toBe('"0"'); expect(await created.json()).toMatchObject({ data: { revision: 0, state: 'created' } })
    const get = await api(req('/api/v1/sessions/session-synthetic')); expect(get.status).toBe(200); expect(get.headers.get('etag')).toBe('"0"'); expect(await get.json()).toMatchObject({ data: { revision: 0 } })
    const start = await api(req('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"0"' } })); expect(start.status).toBe(200); expect(start.headers.get('etag')).toBe('"1"'); expect(await start.json()).toMatchObject({ data: { revision: 1, state: 'recording' } })
    const added = await api(req('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(metadata()) })); expect(added.status).toBe(200); expect(added.headers.get('etag')).toBe('"2"'); expect(await added.json()).toMatchObject({ data: { disposition: 'accepted', session: { revision: 2 } } })
    const finalized = await api(req('/api/v1/sessions/session-synthetic/finalize', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify({ ...command(), declaredFinalSequence: 0 }) })); expect(finalized.status).toBe(200); expect(finalized.headers.get('etag')).toBe('"3"')
    const deleted = await api(req('/api/v1/sessions/session-synthetic', { method: 'DELETE', headers: { 'if-match': '"3"' } })); expect(deleted.status).toBe(200); expect(deleted.headers.get('etag')).toBe('"4"')
  })
  it('preserves duplicate disposition/revision/ETag and exposes only missing sequence numbers', async () => {
    const api = handler(); await create(api); await api(req('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"0"' } }))
    await api(req('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(metadata()) }))
    const duplicate = await api(req('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify(metadata()) })); expect(duplicate.headers.get('etag')).toBe('"2"'); expect(await duplicate.json()).toMatchObject({ data: { disposition: 'duplicate', session: { revision: 2 } } })
    const missing = await api(req('/api/v1/sessions/session-synthetic/finalize', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify({ ...command(), declaredFinalSequence: 1 }) })); expect(missing.status).toBe(409); expect(await missing.json()).toEqual({ error: { code: 'missing-chunks', missingSequences: [1] } })
  })
  it('makes cross-owner and nonexistent responses exact, while owner inputs cannot alter verification', async () => {
    const api = handler(); await create(api)
    const other = await api(req('/api/v1/sessions/session-synthetic', { headers: { authorization: 'Bearer other' } })); const absent = await api(req('/api/v1/sessions/absent', { headers: { authorization: 'Bearer other' } }))
    expect(other.status).toBe(404); expect(absent.status).toBe(404); expect(await other.json()).toEqual({ error: { code: 'not-found' } }); expect(await absent.json()).toEqual({ error: { code: 'not-found' } })
    expect((await create(api, { ...command(), ownerId: 'other-synthetic' })).status).toBe(400); expect((await api(req('/api/v1/sessions?ownerId=other-synthetic'))).status).toBe(404); expect((await api(req('/api/v1/sessions/session-synthetic', { headers: { ownerid: 'other-synthetic' } }))).status).toBe(200)
  })
  it('rejects strict paths/methods and distinguishes every malformed If-Match form', async () => {
    const api = handler(); await create(api)
    for (const path of ['/api/v1/sessions/%73', '/api/v1/sessions/session-synthetic/extra', `/api/v1/sessions/${'a'.repeat(129)}`]) expect((await api(req(path))).status).toBe(404)
    const root = await api(req('/api/v1/sessions')); expect(root.status).toBe(405); expect(root.headers.get('allow')).toBe('POST'); const member = await api(req('/api/v1/sessions/session-synthetic', { method: 'PUT' })); expect(member.status).toBe(405); expect(member.headers.get('allow')).toBe('GET, DELETE')
    const missing = await api(req('/api/v1/sessions/session-synthetic/start', { method: 'POST' })); expect(missing.status).toBe(428); expect(await missing.json()).toEqual({ error: { code: 'precondition-required' } })
    for (const value of ['*', 'W/"0"', '"0", "1"', '0', '"00"', '"-1"', '"9007199254740992"']) { const response = await api(req('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': value } })); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: { code: 'invalid-precondition' } }) }
  })
  it('enforces early Content-Length limits, accepts valid exact 64 KiB JSON, and survives cancel rejection', async () => {
    const api = handler(); let pulls = 0; const early = new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; c.close() } }, { highWaterMark: 0 }); const body = new Request('https://example.test/api/v1/sessions', { method: 'POST', headers: { ...baseHeaders, 'content-length': '65537' }, body: early, duplex: 'half' } as RequestInit); const baseline = pulls
    expect((await api(body)).status).toBe(413); expect(pulls).toBe(baseline)
    const source = JSON.stringify(command('exact-boundary')); const exact = `${source}${' '.repeat(MAX_SESSION_REQUEST_BODY_BYTES - new TextEncoder().encode(source).byteLength)}`; expect((await api(req('/api/v1/sessions', { method: 'POST', body: exact }))).status).toBe(201)
    const oversized = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(MAX_SESSION_REQUEST_BODY_BYTES + 1)) }, cancel() { return Promise.reject(new Error('cancel-sentinel')) } }); const response = await api(req('/api/v1/sessions', { method: 'POST', body: oversized, duplex: 'half' } as RequestInit)); expect(response.status).toBe(413)
  })
  it('maps all conflicts exactly and never exposes MIME/timestamp/digest sentinels', async () => {
    const api = handler(); await create(api); const sessionConflict = await create(api); expect(sessionConflict.status).toBe(409); expect(await sessionConflict.json()).toEqual({ error: { code: 'session-conflict' } }); await api(req('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"0"' } })); const transition = await api(req('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"1"' } })); expect(transition.status).toBe(409); expect(await transition.json()).toEqual({ error: { code: 'invalid-transition' } })
    await api(req('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(metadata()) })); for (const [input, code] of [[metadata({ sha256: 'b'.repeat(64) }), 'chunk-id-conflict'], [metadata({ chunkId: 'other' }), 'sequence-conflict']] as const) { const response = await api(req('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify(input) })); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: { code } }) }
    const invalid = await api(req('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify(metadata({ sessionId: 'wrong' })) })); expect(invalid.status).toBe(400); expect(JSON.stringify(await invalid.json())).not.toMatch(/audio\/sentinel|7777|aaaa/)
    const invalidState = await api(req('/api/v1/sessions/session-synthetic/finalize', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify({ ...command(), declaredFinalSequence: 0 }) })); expect(invalidState.status).toBe(200); const later = await api(req('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"3"' }, body: JSON.stringify(metadata({ chunkId: 'late' })) })); expect(later.status).toBe(409); expect(await later.json()).toEqual({ error: { code: 'invalid-state' } })
  })
  it('applies public headers to representative success/error responses and sanitizes 500', async () => {
    const api = handler(); const responses = [await create(api), await api(req('/api/v1/nope')), await api(req('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))]; for (const response of responses) assertPublic(response)
    const failed = createSessionApi(new SessionService({ async get() { throw new Error('secret') }, async create() { throw new Error('secret') }, async compareAndSet() { throw new Error('secret') } }), verifier); const error = await create(failed); expect(error.status).toBe(500); assertPublic(error); expect(await error.json()).toEqual({ error: { code: 'internal-error' } })
  })
})
