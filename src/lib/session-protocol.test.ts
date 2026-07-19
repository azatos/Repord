import { describe, expect, it } from 'vitest'
import {
  addChunk,
  createSession,
  deleteSession,
  finalizeSession,
  interruptedRawDeletionDeadline,
  isTerminalSessionState,
  MAX_CHUNKS_PER_SESSION,
  MAX_RAW_RETENTION_MS,
  parseClientChunkMetadata,
  parseClientCreateSessionCommand,
  parseClientFinalizeSessionCommand,
  readSession,
  SESSION_PROTOCOL_VERSION,
  successfulRawDeletionDeadline,
  transitionSession,
  type ClientChunkMetadata,
  type OwnerContext,
  type ProtocolResult,
  type SessionRecord,
} from './session-protocol'

const owner: OwnerContext = { ownerId: 'owner-synthetic' }
const otherOwner: OwnerContext = { ownerId: 'other-synthetic' }

function unwrap<T>(result: ProtocolResult<T>): T {
  if (!result.ok) throw new Error(`expected success, received ${result.code}`)
  return result.value
}
function chunk(overrides: Partial<ClientChunkMetadata> = {}): ClientChunkMetadata {
  return { protocolVersion: SESSION_PROTOCOL_VERSION, sessionId: 'session-synthetic', chunkId: 'chunk-0', sequence: 0, captureStartMs: 1_000, captureEndMs: 2_000, mimeType: 'audio/mp4', byteLength: 128, sha256: 'a'.repeat(64), continuityState: 'observed-continuous', confirmedGaps: [], ...overrides }
}
function recordingSession(): SessionRecord {
  return unwrap(transitionSession(owner, unwrap(createSession(owner, { protocolVersion: 1, sessionId: 'session-synthetic' })), 'recording'))
}
const commandFailures: Array<[string, unknown]> = [
  ['create unknown field', { protocolVersion: 1, sessionId: 'session-synthetic', extra: true }],
  ['create owner injection', { protocolVersion: 1, sessionId: 'session-synthetic', ownerId: 'forged' }],
  ['finalize unknown field', { protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 0, extra: true }],
  ['finalize owner injection', { protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 0, ownerId: 'forged' }],
]

describe('client command parsers', () => {
  it.each(commandFailures)('rejects %s', (_label, command) => {
    const result = 'declaredFinalSequence' in (command as object) ? parseClientFinalizeSessionCommand(command) : parseClientCreateSessionCommand(command)
    expect(result).toMatchObject({ ok: false, code: 'unknown-field' })
  })
  it('uses validated create and finalize command boundaries', () => {
    const session = recordingSession()
    expect(createSession(owner, { protocolVersion: 2, sessionId: 'session-synthetic' })).toMatchObject({ ok: false, code: 'invalid-payload' })
    expect(finalizeSession(owner, session, { protocolVersion: 2, sessionId: 'session-synthetic', declaredFinalSequence: 0 })).toMatchObject({ ok: false, code: 'invalid-payload' })
  })
})

describe('chunk parser', () => {
  it.each([
    ['unknown field', { extra: true }], ['owner injection', { ownerId: 'forged' }], ['negative sequence', { sequence: -1 }], ['fractional sequence', { sequence: 0.5 }], ['overflow sequence', { sequence: MAX_CHUNKS_PER_SESSION }], ['reversed timestamps', { captureEndMs: 999 }], ['invalid byte length', { byteLength: 0 }], ['invalid digest', { sha256: 'bad' }], ['control MIME', { mimeType: 'audio\nmp4' }],
  ] as Array<[string, Record<string, unknown>]>)('rejects %s', (_label, overrides) => {
    expect(parseClientChunkMetadata({ ...chunk(), ...overrides }).ok).toBe(false)
  })
  it('preserves all continuity meanings and rejects invalid gap combinations', () => {
    expect(parseClientChunkMetadata(chunk()).ok).toBe(true)
    expect(parseClientChunkMetadata(chunk({ continuityState: 'continuity-unknown' })).ok).toBe(true)
    expect(parseClientChunkMetadata(chunk({ continuityState: 'confirmed-gap', confirmedGaps: [{ startMs: 1_100, endMs: 1_200 }] })).ok).toBe(true)
    expect(parseClientChunkMetadata(chunk({ continuityState: 'confirmed-gap' })).ok).toBe(false)
    expect(parseClientChunkMetadata(chunk({ confirmedGaps: [{ startMs: 1_100, endMs: 1_200 }] })).ok).toBe(false)
  })
  it('canonicalizes gaps and rejects overlaps', () => {
    const parsed = unwrap(parseClientChunkMetadata(chunk({ continuityState: 'confirmed-gap', confirmedGaps: [{ startMs: 1_500, endMs: 1_600 }, { startMs: 1_100, endMs: 1_200 }] })))
    expect(parsed.confirmedGaps).toEqual([{ startMs: 1_100, endMs: 1_200 }, { startMs: 1_500, endMs: 1_600 }])
    expect(parseClientChunkMetadata(chunk({ continuityState: 'confirmed-gap', confirmedGaps: [{ startMs: 1_100, endMs: 1_300 }, { startMs: 1_200, endMs: 1_400 }] })).ok).toBe(false)
  })
})

describe('owner-scoped session operations', () => {
  it('follows valid transitions and rejects cross-owner reads and mutations', () => {
    const session = recordingSession()
    expect(readSession(otherOwner, session)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(addChunk(otherOwner, session, chunk())).toMatchObject({ ok: false, code: 'forbidden' })
    expect(finalizeSession(otherOwner, session, { protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 0 })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(deleteSession(otherOwner, session)).toMatchObject({ ok: false, code: 'forbidden' })
  })
  it('implements semantic idempotency independent of gap key order and digest case', () => {
    const accepted = unwrap(addChunk(owner, recordingSession(), chunk({ continuityState: 'confirmed-gap', sha256: 'A'.repeat(64), confirmedGaps: [{ startMs: 1_500, endMs: 1_600 }, { startMs: 1_100, endMs: 1_200 }] })))
    const retry = chunk({ continuityState: 'confirmed-gap', sha256: 'a'.repeat(64), confirmedGaps: [{ endMs: 1_200, startMs: 1_100 }, { endMs: 1_600, startMs: 1_500 }] })
    expect(unwrap(addChunk(owner, accepted.session, retry)).disposition).toBe('duplicate')
    expect(addChunk(owner, accepted.session, chunk({ byteLength: 129, continuityState: 'confirmed-gap', confirmedGaps: [{ startMs: 1_100, endMs: 1_200 }] }))).toMatchObject({ ok: false, code: 'chunk-id-conflict' })
  })
  it('sorts out-of-order chunks and detects sequence conflicts', () => {
    const second = unwrap(addChunk(owner, recordingSession(), chunk({ chunkId: 'chunk-1', sequence: 1 })))
    const first = unwrap(addChunk(owner, second.session, chunk()))
    expect(first.session.chunks.map((value) => value.sequence)).toEqual([0, 1])
    expect(addChunk(owner, first.session, chunk({ chunkId: 'chunk-other' }))).toMatchObject({ ok: false, code: 'sequence-conflict' })
  })
  it('checks bounded and complete final sequences', () => {
    const second = unwrap(addChunk(owner, recordingSession(), chunk({ chunkId: 'chunk-1', sequence: 1 })))
    expect(finalizeSession(owner, second.session, { protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 1 })).toEqual({ ok: false, code: 'missing-chunks', missingSequences: [0] })
    expect(finalizeSession(owner, second.session, { protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: MAX_CHUNKS_PER_SESSION })).toMatchObject({ ok: false, code: 'invalid-payload' })
    const complete = unwrap(addChunk(owner, second.session, chunk()))
    expect(unwrap(finalizeSession(owner, complete.session, { protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 1 })).state).toBe('finalizing')
  })
  it('rejects chunks after the declared final sequence', () => {
    const session = unwrap(addChunk(owner, recordingSession(), chunk({ chunkId: 'chunk-1', sequence: 1 }))).session
    expect(finalizeSession(owner, session, { protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 0 })).toMatchObject({ ok: false, code: 'final-sequence-conflict' })
  })
  it('produces an empty deletion tombstone and treats only it as terminal', () => {
    const session = unwrap(addChunk(owner, recordingSession(), chunk())).session
    const deleted = unwrap(deleteSession(owner, session))
    expect(deleted).toMatchObject({ state: 'deleted', chunks: [] })
    expect(readSession(owner, deleted)).toMatchObject({ ok: true, value: { chunks: [] } })
    expect(addChunk(owner, deleted, chunk())).toMatchObject({ ok: false, code: 'invalid-state' })
    expect(finalizeSession(owner, deleted, { protocolVersion: 1, sessionId: 'session-synthetic', declaredFinalSequence: 0 })).toMatchObject({ ok: false, code: 'invalid-state' })
    expect(transitionSession(owner, deleted, 'recording')).toMatchObject({ ok: false, code: 'invalid-transition' })
    expect(isTerminalSessionState('completed')).toBe(false)
    expect(isTerminalSessionState('failed')).toBe(false)
    expect(isTerminalSessionState('deleted')).toBe(true)
  })
})

describe('raw retention deadlines', () => {
  it('caps retention at 24 hours and keeps shorter retention', () => {
    expect(successfulRawDeletionDeadline(100, MAX_RAW_RETENTION_MS * 2)).toEqual({ ok: true, value: 100 + MAX_RAW_RETENTION_MS })
    expect(interruptedRawDeletionDeadline(100, 500)).toEqual({ ok: true, value: 600 })
  })
  it('rejects invalid retention and overflow', () => {
    expect(successfulRawDeletionDeadline(100, 0)).toMatchObject({ ok: false, code: 'invalid-retention' })
    expect(interruptedRawDeletionDeadline(Number.MAX_SAFE_INTEGER, 1)).toMatchObject({ ok: false, code: 'overflow' })
  })
})
