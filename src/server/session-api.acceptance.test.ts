import { describe, expect, it } from 'vitest'
import { createSessionApi } from './session-api'
import { InMemorySessionRepository, SessionService } from '../lib/session-service'

const request = (path: string, init: RequestInit = {}) => new Request(`https://example.test${path}`, { ...init, headers: { authorization: 'Bearer owner', 'content-type': 'application/json', ...init.headers } })
const api = () => createSessionApi(new SessionService(new InMemorySessionRepository()), { async verify(r) { return r.headers.get('authorization') === 'Bearer owner' ? { ownerId: 'owner' } : undefined } })
const create = (handler: ReturnType<typeof api>) => handler(request('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ protocolVersion: 1, sessionId: 'acceptance' }) }))

describe('session API acceptance', () => {
  it('implements create/read/start/chunk/finalize/delete with strong revisions', async () => {
    const handler = api()
    expect((await create(handler)).headers.get('etag')).toBe('"0"')
    expect((await handler(request('/api/v1/sessions/acceptance'))).status).toBe(200)
    expect((await handler(request('/api/v1/sessions/acceptance/start', { method: 'POST', headers: { 'if-match': '"0"' } }))).headers.get('etag')).toBe('"1"')
    const chunk = { protocolVersion: 1, sessionId: 'acceptance', chunkId: 'accepted', sequence: 0, captureStartMs: 0, captureEndMs: 1, mimeType: 'audio/mp4', byteLength: 1, sha256: 'a'.repeat(64), continuityState: 'observed-continuous', confirmedGaps: [] }
    expect((await handler(request('/api/v1/sessions/acceptance/chunks', { method: 'POST', headers: { 'if-match': '"1"' }, body: JSON.stringify(chunk) }))).headers.get('etag')).toBe('"2"')
    expect((await handler(request('/api/v1/sessions/acceptance/finalize', { method: 'POST', headers: { 'if-match': '"2"' }, body: JSON.stringify({ protocolVersion: 1, sessionId: 'acceptance', declaredFinalSequence: 0 }) }))).headers.get('etag')).toBe('"3"')
    expect((await handler(request('/api/v1/sessions/acceptance', { method: 'DELETE', headers: { 'if-match': '"3"' } }))).headers.get('etag')).toBe('"4"')
  })
  it('keeps public failures non-sensitive and uses required status categories', async () => {
    const handler = api()
    const unsupported = await handler(request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'secret' }))
    expect(unsupported.status).toBe(415); expect(await unsupported.json()).toEqual({ error: { code: 'unsupported-media-type' } })
    const unauthorized = await handler(new Request('https://example.test/api/v1/sessions', { method: 'POST', body: 'secret' }))
    expect(unauthorized.status).toBe(401); expect(JSON.stringify(await unauthorized.json())).not.toContain('secret')
  })
})
