import { describe, expect, it } from 'vitest'
import {
  InMemorySessionRepository,
  SessionService,
  type StoredSession,
} from './session-service'
import { SESSION_PROTOCOL_VERSION, type ClientChunkMetadata, type OwnerContext } from './session-protocol'

const owner: OwnerContext = { ownerId: 'owner-synthetic' }
const other: OwnerContext = { ownerId: 'other-synthetic' }
function chunk(overrides: Partial<ClientChunkMetadata> = {}): ClientChunkMetadata {
  return { protocolVersion: SESSION_PROTOCOL_VERSION, sessionId: 'session-synthetic', chunkId: 'chunk-0', sequence: 0, captureStartMs: 1_000, captureEndMs: 2_000, mimeType: 'audio/mp4', byteLength: 128, sha256: 'a'.repeat(64), continuityState: 'observed-continuous', confirmedGaps: [], ...overrides }
}
async function recording() {
  const service = new SessionService(new InMemorySessionRepository())
  const created = await service.create(owner, { protocolVersion: 1, sessionId: 'session-synthetic' })
  if (!created.ok) throw new Error('create failed')
  const started = await service.start(owner, created.value.sessionId, created.value.revision)
  if (!started.ok) throw new Error('start failed')
  return { service, session: started.value }
}
function success<T>(result: { ok: boolean; value?: T }): T { if (!result.ok) throw new Error('expected success'); return result.value as T }

describe('InMemorySessionRepository', () => {
  it('isolates repository reads and writes with clones', async () => {
    const repository = new InMemorySessionRepository()
    const stored: StoredSession = { revision: 0, record: { protocolVersion: 1, sessionId: 'clone-test', ownerId: 'owner-synthetic', state: 'created', chunks: [] } }
    await repository.create(stored)
    ;(stored.record.chunks as ClientChunkMetadata[]).push(chunk({ sessionId: 'clone-test' }))
    const read = await repository.get('clone-test')
    expect(read?.record.chunks).toEqual([])
    ;(read?.record.chunks as ClientChunkMetadata[]).push(chunk({ sessionId: 'clone-test' }))
    expect((await repository.get('clone-test'))?.record.chunks).toEqual([])
  })
})

describe('owner-scoped session service', () => {
  it('rejects a session ID collision', async () => {
    const service = new SessionService(new InMemorySessionRepository())
    expect((await service.create(owner, { protocolVersion: 1, sessionId: 'collision' })).ok).toBe(true)
    expect(await service.create(other, { protocolVersion: 1, sessionId: 'collision' })).toEqual({ ok: false, code: 'session-id-conflict' })
  })
  it('returns only non-sensitive public session fields', async () => {
    const { service, session } = await recording()
    const added = success(await service.addChunk(owner, session.sessionId, session.revision, chunk()))
    const serialized = JSON.stringify(added.session)
    expect(Object.keys(added.session).sort()).toEqual(['chunkCount', 'continuitySummary', 'protocolVersion', 'revision', 'sessionId', 'state'])
    for (const sensitive of ['ownerId', 'sha256', 'mimeType', 'captureStartMs', 'confirmedGaps', 'audio', 'raw-input']) expect(serialized).not.toContain(sensitive)
  })
  it('makes all operations return not-found to another owner', async () => {
    const { service, session } = await recording()
    await expect(service.get(other, session.sessionId)).resolves.toEqual({ ok: false, code: 'not-found' })
    await expect(service.start(other, session.sessionId, session.revision)).resolves.toEqual({ ok: false, code: 'not-found' })
    await expect(service.addChunk(other, session.sessionId, session.revision, chunk())).resolves.toEqual({ ok: false, code: 'not-found' })
    await expect(service.finalize(other, session.sessionId, session.revision, { protocolVersion: 1, sessionId: session.sessionId, declaredFinalSequence: 0 })).resolves.toEqual({ ok: false, code: 'not-found' })
    await expect(service.delete(other, session.sessionId, session.revision)).resolves.toEqual({ ok: false, code: 'not-found' })
  })
  it('moves through normal states with revisions', async () => {
    const { service, session } = await recording()
    const added = success(await service.addChunk(owner, session.sessionId, session.revision, chunk()))
    const finalizing = success(await service.finalize(owner, session.sessionId, added.session.revision, { protocolVersion: 1, sessionId: session.sessionId, declaredFinalSequence: 0 }))
    expect(finalizing).toMatchObject({ state: 'finalizing', revision: 3, chunkCount: 1 })
  })
  it('reports accepted then duplicate chunks without incrementing duplicate revision', async () => {
    const { service, session } = await recording()
    const accepted = success(await service.addChunk(owner, session.sessionId, session.revision, chunk()))
    const duplicate = success(await service.addChunk(owner, session.sessionId, accepted.session.revision, chunk()))
    expect(accepted).toMatchObject({ disposition: 'accepted', session: { revision: 2 } })
    expect(duplicate).toMatchObject({ disposition: 'duplicate', session: { revision: 2 } })
  })
  it('accepts out-of-order chunks and summarizes continuity conservatively', async () => {
    const { service, session } = await recording()
    const second = success(await service.addChunk(owner, session.sessionId, session.revision, chunk({ chunkId: 'chunk-1', sequence: 1, continuityState: 'continuity-unknown' })))
    const first = success(await service.addChunk(owner, session.sessionId, second.session.revision, chunk({ continuityState: 'confirmed-gap', confirmedGaps: [{ startMs: 1_100, endMs: 1_200 }] })))
    expect(first.session).toMatchObject({ chunkCount: 2, continuitySummary: 'confirmed-gap' })
  })
  it('rejects stale revisions without changing state', async () => {
    const { service, session } = await recording()
    const startedRevision = session.revision
    const accepted = success(await service.addChunk(owner, session.sessionId, startedRevision, chunk()))
    expect(await service.finalize(owner, session.sessionId, startedRevision, { protocolVersion: 1, sessionId: session.sessionId, declaredFinalSequence: 0 })).toEqual({ ok: false, code: 'stale-revision' })
    expect(success(await service.get(owner, session.sessionId))).toMatchObject({ state: 'recording', revision: accepted.session.revision })
  })
  it('does not finalize when chunks are missing and exposes only sequence numbers', async () => {
    const { service, session } = await recording()
    const added = success(await service.addChunk(owner, session.sessionId, session.revision, chunk({ chunkId: 'chunk-1', sequence: 1 })))
    expect(await service.finalize(owner, session.sessionId, added.session.revision, { protocolVersion: 1, sessionId: session.sessionId, declaredFinalSequence: 1 })).toEqual({ ok: false, code: 'missing-chunks', missingSequences: [0] })
  })
  it('keeps a deletion tombstone while removing chunks', async () => {
    const { service, session } = await recording()
    const added = success(await service.addChunk(owner, session.sessionId, session.revision, chunk()))
    const deleted = success(await service.delete(owner, session.sessionId, added.session.revision))
    expect(deleted).toMatchObject({ state: 'deleted', chunkCount: 0 })
    expect(success(await service.get(owner, session.sessionId))).toMatchObject({ state: 'deleted', chunkCount: 0 })
  })
  it('uses non-sensitive errors for invalid input', async () => {
    const { service, session } = await recording()
    const input = { protocolVersion: 1, sessionId: session.sessionId, chunkId: 'raw-input', sequence: 0, captureStartMs: 0, captureEndMs: 1, mimeType: 'audio/mp4', byteLength: 1, sha256: 'a'.repeat(64), continuityState: 'observed-continuous', confirmedGaps: [], extra: 'secret' }
    const result = await service.addChunk(owner, session.sessionId, session.revision, input)
    expect(result).toEqual({ ok: false, code: 'unknown-field' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
