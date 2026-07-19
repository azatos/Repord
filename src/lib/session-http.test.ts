import { describe, expect, it } from 'vitest'
import { createSessionHttpHandler, MAX_SESSION_REQUEST_BODY_BYTES, type AuthVerifier } from './session-http'
import { InMemorySessionRepository, SessionService } from './session-service'

const verifier: AuthVerifier = { async verify(request) { return request.headers.get('authorization') === 'Bearer synthetic' ? { ownerId: 'owner-synthetic' } : undefined } }
const handler = () => createSessionHttpHandler(new SessionService(new InMemorySessionRepository()), verifier)
const request = (path: string, init: RequestInit = {}) => new Request(`https://example.test${path}`, { ...init, headers: { authorization: 'Bearer synthetic', ...init.headers } })
const create = async (route: (request: Request) => Promise<Response>, id = 'session-synthetic') => route(request('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ protocolVersion: 1, sessionId: id }) }))
const chunk = (sessionId = 'session-synthetic') => ({ protocolVersion: 1, sessionId, chunkId: 'chunk-synthetic', sequence: 0, captureStartMs: 0, captureEndMs: 1, mimeType: 'audio/mp4', byteLength: 1, sha256: 'a'.repeat(64), continuityState: 'observed-continuous', confirmedGaps: [] })

describe('session HTTP boundary', () => {
  it('uses stable JSON envelopes, strong ETags, and public session data', async () => {
    const route = handler(); const response = await create(route)
    expect(response.status).toBe(201); expect(response.headers.get('etag')).toBe('"0"'); expect(response.headers.get('location')).toBe('/api/v1/sessions/session-synthetic')
    const payload = await response.json() as { ok: boolean; data: Record<string, unknown> }
    expect(payload).toMatchObject({ ok: true, data: { sessionId: 'session-synthetic', revision: 0 } })
    expect(JSON.stringify(payload)).not.toMatch(/owner|sha256|raw|token|digest/i)
    const read = await route(request('/api/v1/sessions/session-synthetic'))
    expect(read.status).toBe(200); expect(read.headers.get('etag')).toBe('"0"'); expect(read.headers.get('cache-control')).toBe('no-store'); expect(read.headers.get('x-content-type-options')).toBe('nosniff')
  })
  it('authenticates before consuming or routing a request', async () => {
    let reads = 0
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads += 1; controller.enqueue(new TextEncoder().encode('{')); controller.close() } })
    const response = await handler()(new Request('https://example.test/not-a-route', { method: 'POST', body: stream, duplex: 'half' } as RequestInit))
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ ok: false, error: { code: 'unauthorized' } }); expect(reads).toBe(0)
  })
  it('requires an exact strong If-Match revision for mutations', async () => {
    const route = handler(); await create(route)
    expect((await route(request('/api/v1/sessions/session-synthetic/start', { method: 'POST' }))).status).toBe(428)
    expect((await route(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': 'W/"0"' } }))).status).toBe(400)
    const started = await route(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"0"' } }))
    expect(started.status).toBe(200); expect(started.headers.get('etag')).toBe('"1"')
  })
  it('turns a real concurrent revision race into one 200 and one 412', async () => {
    const route = handler(); await create(route)
    await route(request('/api/v1/sessions/session-synthetic/start', { method: 'POST', headers: { 'if-match': '"0"' } }))
    const [left, right] = await Promise.all([route(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk()) })), route(request('/api/v1/sessions/session-synthetic/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify({ ...chunk(), chunkId: 'chunk-other', sequence: 1 }) }))])
    expect([left.status, right.status].sort()).toEqual([200, 412])
  })
  it('rejects oversized streaming JSON without exposing input and accepts boundary-sized data', async () => {
    const route = handler(); const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_SESSION_REQUEST_BODY_BYTES + 1)); controller.close() } })
    const tooLarge = await route(request('/api/v1/sessions', { method: 'POST', body: oversized, duplex: 'half' } as RequestInit))
    expect(tooLarge.status).toBe(413); expect(await tooLarge.json()).toEqual({ ok: false, error: { code: 'body-too-large' } })
    const id = 'x'.repeat(MAX_SESSION_REQUEST_BODY_BYTES - 36)
    const response = await create(route, id)
    expect(response.status).toBe(400) // protocol ID validation remains stricter than the transport limit.
  })
  it('maps service errors to non-sensitive statuses and rejects malformed JSON', async () => {
    const route = handler(); const malformed = await route(request('/api/v1/sessions', { method: 'POST', body: '{ownerId:"secret"}' }))
    expect(malformed.status).toBe(400); expect(JSON.stringify(await malformed.json())).not.toContain('secret')
    await create(route); const foreign = createSessionHttpHandler(new SessionService(new InMemorySessionRepository()), { async verify() { return { ownerId: 'different-owner' } } })
    expect((await foreign(request('/api/v1/sessions/session-synthetic'))).status).toBe(404)
  })
})
