import { describe, expect, it } from 'vitest'
import { createSessionApi, MAX_SESSION_REQUEST_BODY_BYTES, type AuthVerifier } from './session-api'
import { InMemorySessionRepository, SessionService, type SessionRepository, type StoredSession } from '../lib/session-service'

const json = { 'content-type': 'application/json', authorization: 'Bearer owner' }
const request = (path: string, init: RequestInit = {}) => new Request(`https://example.test${path}`, { ...init, headers: { ...json, ...init.headers } })
const auth: AuthVerifier = { async verify(request) { return request.headers.get('authorization') === 'Bearer owner' ? { ownerId: 'owner-synthetic' } : request.headers.get('authorization') === 'Bearer other' ? { ownerId: 'other-synthetic' } : undefined } }
const session = (id = 'session-synthetic') => ({ protocolVersion: 1, sessionId: id })
const chunk = (id = 'session-synthetic') => ({ protocolVersion: 1, sessionId: id, chunkId: 'chunk-synthetic', sequence: 0, captureStartMs: 0, captureEndMs: 1, mimeType: 'audio/mp4', byteLength: 1, sha256: 'a'.repeat(64), continuityState: 'observed-continuous', confirmedGaps: [] })
function setup() { return createSessionApi(new SessionService(new InMemorySessionRepository()), auth) }
async function create(api: ReturnType<typeof setup>) { return api(request('/api/v1/sessions', { method: 'POST', body: JSON.stringify(session()) })) }
async function start(api: ReturnType<typeof setup>, tag = '"0"') { return api(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': tag } })) }

describe('session API', () => {
  it('uses exact public envelopes, security headers, ETags, and no sensitive fields', async () => {
    const response = await create(setup())
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ data: { protocolVersion: 1, sessionId: 'session-synthetic', state: 'created', revision: 0, receivedChunkCount: 0, receivedSequences: [], confirmedGapCount: 0, continuitySummary: 'not-observed' } })
    expect(response.headers.get('etag')).toBe('"0"'); expect(response.headers.get('location')).toBe('/api/v1/sessions/session-synthetic')
    for (const name of ['cache-control', 'x-content-type-options', 'referrer-policy']) expect(response.headers.get(name)).toBeTruthy()
    expect(JSON.stringify(await (await create(setup())).json())).not.toMatch(/owner|token|sha256|digest|raw/i)
  })
  it('authenticates before route and body handling, and hides cross-owner sessions using one service', async () => {
    let pulls = 0; const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array([123])); controller.close() } }, { highWaterMark: 0 })
    const api = setup(); const unauthenticated = new Request('https://example.test/nope', { method: 'POST', body: stream, duplex: 'half' } as RequestInit); const baseline = pulls
    expect((await api(unauthenticated)).status).toBe(401); expect(pulls).toBe(baseline)
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
    expect(finalized.headers.get('etag')).toBe('"3"')
    const deleted = await api(request('/api/v1/sessions/session-synthetic', { method: 'DELETE', headers: { 'if-match': '"3"' } }))
    expect(deleted.headers.get('etag')).toBe('"4"')
  })
  it('rejects every non-exact If-Match form and maps a real CAS race to 409', async () => {
    const api = setup(); await create(api)
    const missing = await api(request('/api/v1/sessions/session-synthetic/start', { method: 'POST' }))
    expect(missing.status).toBe(428); expect(await missing.json()).toEqual({ error: { code: 'precondition-required' } })
    for (const value of ['*', 'W/"0"', '"0", "1"', '0', '"00"', '"-1"', '"9007199254740992"']) {
      const response = await api(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: value === undefined ? {} : { 'if-match': value } }))
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: { code: 'invalid-precondition' } })
    }
    await start(api); const [left, right] = await Promise.all([api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk()) })), api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify({ ...chunk(), chunkId: 'other', sequence: 1 }) }))])
    expect([left.status, right.status].sort()).toEqual([200, 409])
  })
  it('enforces JSON UTF-8/media type, strict routes, session-id bounds, and the 64 KiB boundary', async () => {
    const api = setup()
    expect((await api(request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))).status).toBe(415)
    expect((await api(request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json; charset=iso-8859-1' }, body: '{}' }))).status).toBe(415)
    expect((await api(request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: '{}' }))).status).toBe(400)
    expect((await api(request('/api/v1/sessions?x=1', { method: 'POST', body: '{}' }))).status).toBe(404)
    expect((await api(request('/api/v1/sessions/%73', { method: 'GET' }))).status).toBe(404)
    expect((await api(request(`/api/v1/sessions/${'a'.repeat(129)}`, { method: 'GET' }))).status).toBe(404)
    const invalidUtf8 = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0xc3, 0x28])); c.close() } })
    expect((await api(request('/api/v1/sessions', { method: 'POST', body: invalidUtf8, duplex: 'half' } as RequestInit))).status).toBe(400)
    const tooBig = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_SESSION_REQUEST_BODY_BYTES + 1)); c.close() } })
    expect((await api(request('/api/v1/sessions', { method: 'POST', body: tooBig, duplex: 'half' } as RequestInit))).status).toBe(413)
    const exact = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_SESSION_REQUEST_BODY_BYTES)); c.close() } })
    expect((await api(request('/api/v1/sessions', { method: 'POST', body: exact, duplex: 'half' } as RequestInit))).status).toBe(400)
  })
  it('maps protocol conflicts and missing chunks without returning client input or owner IDs', async () => {
    const api = setup()
    const ownerField = await api(request('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ ...session(), ownerId: 'secret-owner' }) }))
    expect(ownerField.status).toBe(400); expect(JSON.stringify(await ownerField.json())).not.toContain('secret-owner')
    await create(api)
    const collision = await create(api); expect(collision.status).toBe(409); expect(await collision.json()).toEqual({ error: { code: 'session-conflict' } })
    await start(api)
    const missing = await api(request('/api/v1/sessions/session-synthetic/finalize', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify({ protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 1 }) }))
    expect(missing.status).toBe(409); expect(await missing.json()).toEqual({ error: { code: 'missing-chunks', missingSequences: [0, 1] } })
    const conflict = await api(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify({ ...chunk(), sessionId: 'other-session' }) }))
    expect(conflict.status).toBe(400); expect(JSON.stringify(await conflict.json())).not.toMatch(/other-session|sha256|owner/i)
  })
  it('returns correct route and method errors and omits ETags from failures', async () => {
    const api = setup()
    const root = await api(request('/api/v1/sessions', { method: 'GET' })); expect(root.status).toBe(405); expect(root.headers.get('allow')).toBe('POST'); expect(root.headers.get('etag')).toBeNull()
    const member = await api(request('/api/v1/sessions/session-synthetic', { method: 'PUT' })); expect(member.status).toBe(405); expect(member.headers.get('allow')).toBe('GET, DELETE')
    expect((await api(request('/api/v1/sessions/session-synthetic/unknown', { method: 'POST' }))).status).toBe(404)
  })
  it('sanitizes unexpected failures', async () => {
    const api = createSessionApi(new SessionService(new InMemorySessionRepository()), { async verify() { throw new Error('credential-secret') } })
    const response = await api(request('/api/v1/sessions')); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: { code: 'internal-error' } })
  })
  it('sanitizes dependency exceptions from the session repository', async () => {
    class ThrowingRepository implements SessionRepository {
      async get(): Promise<StoredSession | undefined> { throw new Error('repository-secret') }
      async create(): Promise<boolean> { throw new Error('repository-secret') }
      async compareAndSet(): Promise<boolean> { throw new Error('repository-secret') }
    }
    const api = createSessionApi(new SessionService(new ThrowingRepository()), auth)
    const response = await create(api); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: { code: 'internal-error' } })
  })
})
