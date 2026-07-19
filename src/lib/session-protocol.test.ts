import { describe, expect, it } from 'vitest'
import {
  addChunk,
  createSession,
  deleteSession,
  finalizeSession,
  interruptedRawDeletionDeadline,
  MAX_RAW_RETENTION_MS,
  parseClientChunkMetadata,
  readSession,
  SESSION_PROTOCOL_VERSION,
  successfulRawDeletionDeadline,
  transitionSession,
  type ClientChunkMetadata,
  type OwnerContext,
  type SessionRecord,
} from './session-protocol'

const owner: OwnerContext = { ownerId: 'owner-synthetic' }
const otherOwner: OwnerContext = { ownerId: 'other-synthetic' }

function chunk(overrides: Partial<ClientChunkMetadata> = {}): ClientChunkMetadata {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    sessionId: 'session-synthetic',
    chunkId: 'chunk-0',
    sequence: 0,
    captureStartMs: 1_000,
    captureEndMs: 2_000,
    mimeType: 'audio/mp4',
    byteLength: 128,
    sha256: 'a'.repeat(64),
    continuityState: 'observed-continuous',
    confirmedGaps: [],
    ...overrides,
  }
}

function recordingSession(): SessionRecord {
  const created = createSession(owner, 'session-synthetic')
  if (!created.ok) throw new Error('test setup failed')
  const recording = transitionSession(owner, created.value, 'recording')
  if (!recording.ok) throw new Error('test setup failed')
  return recording.value
}

const invalidPayloads: Array<[string, Record<string, unknown>]> = [
  ['protocol version', { protocolVersion: 2 }],
  ['unknown field', { extra: true }],
  ['client owner injection', { ownerId: 'forged' }],
  ['negative sequence', { sequence: -1 }],
  ['fractional sequence', { sequence: 0.5 }],
  ['overflow sequence', { sequence: Number.MAX_SAFE_INTEGER + 1 }],
  ['reversed timestamps', { captureEndMs: 999 }],
  ['invalid byte length', { byteLength: 0 }],
  ['invalid digest', { sha256: 'not-a-digest' }],
  ['control-character MIME', { mimeType: 'audio\nmp4' }],
]

describe('session protocol parser', () => {
  it('creates a session and follows its valid lifecycle', () => {
    const created = createSession(owner, 'session-synthetic')
    expect(created).toMatchObject({ ok: true, value: { state: 'created' } })
    if (!created.ok) return
    const recording = transitionSession(owner, created.value, 'recording')
    if (!recording.ok) return
    const finalizing = transitionSession(owner, recording.value, 'finalizing')
    if (!finalizing.ok) return
    expect(transitionSession(owner, finalizing.value, 'completed')).toMatchObject({
      ok: true,
      value: { state: 'completed' },
    })
  })

  it.each(invalidPayloads)('rejects %s without echoing input', (_label, overrides) => {
    const result = parseClientChunkMetadata({ ...chunk(), ...overrides })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['invalid-payload', 'unknown-field']).toContain(result.code)
  })

  it('preserves all three continuity states and validates gap combinations', () => {
    expect(parseClientChunkMetadata(chunk()).ok).toBe(true)
    expect(
      parseClientChunkMetadata(
        chunk({ continuityState: 'continuity-unknown', confirmedGaps: [] }),
      ).ok,
    ).toBe(true)
    expect(
      parseClientChunkMetadata(
        chunk({
          continuityState: 'confirmed-gap',
          confirmedGaps: [{ startMs: 1_100, endMs: 1_200 }],
        }),
      ).ok,
    ).toBe(true)
    expect(
      parseClientChunkMetadata(
        chunk({ continuityState: 'confirmed-gap', confirmedGaps: [] }),
      ).ok,
    ).toBe(false)
    expect(
      parseClientChunkMetadata(
        chunk({
          continuityState: 'observed-continuous',
          confirmedGaps: [{ startMs: 1_100, endMs: 1_200 }],
        }),
      ).ok,
    ).toBe(false)
    expect(
      parseClientChunkMetadata(
        chunk({
          continuityState: 'confirmed-gap',
          confirmedGaps: [{ startMs: 900, endMs: 1_200 }],
        }),
      ).ok,
    ).toBe(false)
  })
})

describe('owner-scoped session mutations', () => {
  it('rejects every cross-owner operation without mutating the session', () => {
    const session = recordingSession()
    expect(readSession(otherOwner, session)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(addChunk(otherOwner, session, chunk())).toMatchObject({ ok: false, code: 'forbidden' })
    expect(finalizeSession(otherOwner, session, 0)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(deleteSession(otherOwner, session)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(session).toMatchObject({ state: 'recording', chunks: [] })
  })

  it('accepts a new chunk, treats an exact retry as duplicate, and detects conflicts', () => {
    const session = recordingSession()
    const accepted = addChunk(owner, session, chunk())
    expect(accepted).toMatchObject({ ok: true, value: { disposition: 'accepted' } })
    if (!accepted.ok) return
    expect(addChunk(owner, accepted.value.session, chunk())).toMatchObject({
      ok: true,
      value: { disposition: 'duplicate' },
    })
    expect(addChunk(owner, accepted.value.session, chunk({ byteLength: 129 }))).toMatchObject({
      ok: false,
      code: 'chunk-id-conflict',
    })
    expect(
      addChunk(owner, accepted.value.session, chunk({ chunkId: 'chunk-other' })),
    ).toMatchObject({ ok: false, code: 'sequence-conflict' })
  })

  it('allows out-of-order chunks but stores them in sequence order', () => {
    const second = addChunk(owner, recordingSession(), chunk({ chunkId: 'chunk-1', sequence: 1 }))
    if (!second.ok) return
    const first = addChunk(owner, second.value.session, chunk())
    expect(first).toMatchObject({ ok: true, value: { disposition: 'accepted' } })
    if (first.ok) expect(first.value.session.chunks.map((value) => value.sequence)).toEqual([0, 1])
  })

  it('requires complete sequences before finalization and then finalizes', () => {
    const onlyOne = addChunk(owner, recordingSession(), chunk({ chunkId: 'chunk-1', sequence: 1 }))
    if (!onlyOne.ok) return
    expect(finalizeSession(owner, onlyOne.value.session, 1)).toEqual({
      ok: false,
      code: 'missing-chunks',
      missingSequences: [0],
    })
    const both = addChunk(owner, onlyOne.value.session, chunk())
    if (!both.ok) return
    expect(finalizeSession(owner, both.value.session, 1)).toMatchObject({
      ok: true,
      value: { state: 'finalizing' },
    })
  })

  it('rejects invalid transitions and makes deletion terminal', () => {
    const session = recordingSession()
    expect(transitionSession(owner, session, 'completed')).toMatchObject({
      ok: false,
      code: 'invalid-transition',
    })
    const deleted = deleteSession(owner, session)
    if (!deleted.ok) return
    expect(transitionSession(owner, deleted.value, 'recording')).toMatchObject({
      ok: false,
      code: 'invalid-transition',
    })
    expect(addChunk(owner, deleted.value, chunk())).toMatchObject({
      ok: false,
      code: 'invalid-state',
    })
  })
})

describe('raw retention deadlines', () => {
  it('caps raw retention at 24 hours and keeps shorter configured retention', () => {
    expect(successfulRawDeletionDeadline(100, MAX_RAW_RETENTION_MS * 2)).toEqual({
      ok: true,
      value: 100 + MAX_RAW_RETENTION_MS,
    })
    expect(interruptedRawDeletionDeadline(100, 500)).toEqual({ ok: true, value: 600 })
  })

  it('rejects invalid retention and unsafe deadline arithmetic', () => {
    expect(successfulRawDeletionDeadline(100, 0)).toMatchObject({
      ok: false,
      code: 'invalid-retention',
    })
    expect(interruptedRawDeletionDeadline(Number.MAX_SAFE_INTEGER, 1)).toMatchObject({
      ok: false,
      code: 'overflow',
    })
  })
})
