import type { ContinuityState } from './continuity'

/** Version one of the metadata contract shared by the PWA and a future API. */
export const SESSION_PROTOCOL_VERSION = 1 as const
export const MAX_RAW_RETENTION_MS = 24 * 60 * 60 * 1000

const MAX_ID_LENGTH = 128
const MAX_MIME_TYPE_LENGTH = 255
const terminalStates = new Set<SessionState>(['completed', 'failed', 'deleted'])

export type OwnerContext = Readonly<{ ownerId: string }>
export type SessionState =
  | 'created'
  | 'recording'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'deleted'

export type ConfirmedGap = Readonly<{ startMs: number; endMs: number }>

/** Untrusted request data. Deliberately contains no owner identifier. */
export type ClientChunkMetadata = Readonly<{
  protocolVersion: typeof SESSION_PROTOCOL_VERSION
  sessionId: string
  chunkId: string
  sequence: number
  captureStartMs: number
  captureEndMs: number
  mimeType: string
  byteLength: number
  sha256: string
  continuityState: ContinuityState
  confirmedGaps: readonly ConfirmedGap[]
}>

export type SessionRecord = Readonly<{
  protocolVersion: typeof SESSION_PROTOCOL_VERSION
  sessionId: string
  ownerId: string
  state: SessionState
  chunks: readonly ClientChunkMetadata[]
}>

export type ProtocolErrorCode =
  | 'invalid-payload'
  | 'unknown-field'
  | 'forbidden'
  | 'not-found'
  | 'invalid-transition'
  | 'invalid-state'
  | 'chunk-id-conflict'
  | 'sequence-conflict'
  | 'missing-chunks'
  | 'invalid-retention'
  | 'overflow'

export type ProtocolFailure = Readonly<{
  ok: false
  code: ProtocolErrorCode
  missingSequences?: readonly number[]
}>
export type ProtocolSuccess<T> = Readonly<{ ok: true; value: T }>
export type ProtocolResult<T> = ProtocolSuccess<T> | ProtocolFailure

function failure(code: ProtocolErrorCode): ProtocolFailure {
  return { ok: false, code }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field))
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  )
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isValidMimeType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MIME_TYPE_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isValidGap(value: unknown): value is ConfirmedGap {
  if (!isRecord(value) || !hasOnlyFields(value, ['startMs', 'endMs'])) return false
  return (
    isSafeInteger(value.startMs) &&
    isSafeInteger(value.endMs) &&
    value.startMs >= 0 &&
    value.endMs >= value.startMs
  )
}

/**
 * Parses untrusted chunk metadata without retaining or echoing its raw content.
 * An ownerId is intentionally an unknown field because ownership is server-side.
 */
export function parseClientChunkMetadata(
  input: unknown,
): ProtocolResult<ClientChunkMetadata> {
  if (!isRecord(input)) return failure('invalid-payload')
  const fields = [
    'protocolVersion',
    'sessionId',
    'chunkId',
    'sequence',
    'captureStartMs',
    'captureEndMs',
    'mimeType',
    'byteLength',
    'sha256',
    'continuityState',
    'confirmedGaps',
  ]
  if (!hasOnlyFields(input, fields)) return failure('unknown-field')
  if (
    input.protocolVersion !== SESSION_PROTOCOL_VERSION ||
    !isOpaqueId(input.sessionId) ||
    !isOpaqueId(input.chunkId) ||
    !isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    !isSafeInteger(input.captureStartMs) ||
    !isSafeInteger(input.captureEndMs) ||
    input.captureStartMs < 0 ||
    input.captureEndMs < input.captureStartMs ||
    !isValidMimeType(input.mimeType) ||
    !isSafeInteger(input.byteLength) ||
    input.byteLength <= 0 ||
    typeof input.sha256 !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(input.sha256) ||
    !['observed-continuous', 'confirmed-gap', 'continuity-unknown'].includes(
      input.continuityState as string,
    ) ||
    !Array.isArray(input.confirmedGaps) ||
    !input.confirmedGaps.every(isValidGap)
  ) {
    return failure('invalid-payload')
  }

  const gaps = input.confirmedGaps as ConfirmedGap[]
  const captureStartMs = input.captureStartMs as number
  const captureEndMs = input.captureEndMs as number
  if (
    gaps.some(
      (gap) => gap.startMs < captureStartMs || gap.endMs > captureEndMs,
    ) ||
    (input.continuityState === 'confirmed-gap' && gaps.length === 0) ||
    (input.continuityState !== 'confirmed-gap' && gaps.length !== 0)
  ) {
    return failure('invalid-payload')
  }

  return {
    ok: true,
    value: {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      chunkId: input.chunkId,
      sequence: input.sequence,
      captureStartMs: input.captureStartMs,
      captureEndMs: input.captureEndMs,
      mimeType: input.mimeType,
      byteLength: input.byteLength,
      sha256: input.sha256,
      continuityState: input.continuityState as ContinuityState,
      confirmedGaps: gaps.map((gap) => ({ ...gap })),
    },
  }
}

export function createSession(
  context: OwnerContext,
  sessionId: string,
): ProtocolResult<SessionRecord> {
  if (!isOpaqueId(context.ownerId) || !isOpaqueId(sessionId)) {
    return failure('invalid-payload')
  }
  return {
    ok: true,
    value: {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      sessionId,
      ownerId: context.ownerId,
      state: 'created',
      chunks: [],
    },
  }
}

function owns(context: OwnerContext, session: SessionRecord): boolean {
  return context.ownerId === session.ownerId
}

export function readSession(
  context: OwnerContext,
  session: SessionRecord,
): ProtocolResult<SessionRecord> {
  return owns(context, session) ? { ok: true, value: session } : failure('forbidden')
}

const allowedTransitions: Readonly<Record<SessionState, readonly SessionState[]>> = {
  created: ['recording', 'failed', 'deleted'],
  recording: ['finalizing', 'failed', 'deleted'],
  finalizing: ['completed', 'failed', 'deleted'],
  completed: ['deleted'],
  failed: ['deleted'],
  deleted: [],
}

export function transitionSession(
  context: OwnerContext,
  session: SessionRecord,
  nextState: SessionState,
): ProtocolResult<SessionRecord> {
  if (!owns(context, session)) return failure('forbidden')
  if (!allowedTransitions[session.state].includes(nextState)) {
    return failure('invalid-transition')
  }
  return { ok: true, value: { ...session, state: nextState } }
}

function chunksMatch(a: ClientChunkMetadata, b: ClientChunkMetadata): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export type AddChunkResult = Readonly<{
  session: SessionRecord
  disposition: 'accepted' | 'duplicate'
}>

export function addChunk(
  context: OwnerContext,
  session: SessionRecord,
  payload: unknown,
): ProtocolResult<AddChunkResult> {
  if (!owns(context, session)) return failure('forbidden')
  if (session.state !== 'recording') return failure('invalid-state')
  const parsed = parseClientChunkMetadata(payload)
  if (!parsed.ok) return parsed
  const chunk = parsed.value
  if (chunk.sessionId !== session.sessionId) return failure('invalid-payload')

  const sameId = session.chunks.find((existing) => existing.chunkId === chunk.chunkId)
  if (sameId) {
    return chunksMatch(sameId, chunk)
      ? { ok: true, value: { session, disposition: 'duplicate' } }
      : failure('chunk-id-conflict')
  }
  if (session.chunks.some((existing) => existing.sequence === chunk.sequence)) {
    return failure('sequence-conflict')
  }
  const chunks = [...session.chunks, chunk].sort(
    (left, right) => left.sequence - right.sequence,
  )
  return { ok: true, value: { session: { ...session, chunks }, disposition: 'accepted' } }
}

export function finalizeSession(
  context: OwnerContext,
  session: SessionRecord,
  declaredFinalSequence: number,
): ProtocolResult<SessionRecord> {
  if (!owns(context, session)) return failure('forbidden')
  if (session.state !== 'recording') return failure('invalid-state')
  if (!isSafeInteger(declaredFinalSequence) || declaredFinalSequence < 0) {
    return failure('invalid-payload')
  }
  const present = new Set(session.chunks.map((chunk) => chunk.sequence))
  const missingSequences = Array.from(
    { length: declaredFinalSequence + 1 },
    (_, sequence) => sequence,
  ).filter((sequence) => !present.has(sequence))
  if (missingSequences.length > 0) {
    return { ok: false, code: 'missing-chunks', missingSequences }
  }
  return { ok: true, value: { ...session, state: 'finalizing' } }
}

export function deleteSession(
  context: OwnerContext,
  session: SessionRecord,
): ProtocolResult<SessionRecord> {
  return transitionSession(context, session, 'deleted')
}

function deadline(
  baseTimeMs: number,
  configuredRetentionMs: number,
): ProtocolResult<number> {
  if (
    !isSafeInteger(baseTimeMs) ||
    baseTimeMs < 0 ||
    !isSafeInteger(configuredRetentionMs) ||
    configuredRetentionMs <= 0
  ) {
    return failure('invalid-retention')
  }
  const value = baseTimeMs + Math.min(configuredRetentionMs, MAX_RAW_RETENTION_MS)
  return Number.isSafeInteger(value) ? { ok: true, value } : failure('overflow')
}

/** Deadline for raw data from a successfully processed session. */
export function successfulRawDeletionDeadline(
  processedAtMs: number,
  configuredRetentionMs: number,
): ProtocolResult<number> {
  return deadline(processedAtMs, configuredRetentionMs)
}

/** Deadline for raw data from a failed or interrupted session. */
export function interruptedRawDeletionDeadline(
  lastActivityAtMs: number,
  configuredRetentionMs: number,
): ProtocolResult<number> {
  return deadline(lastActivityAtMs, configuredRetentionMs)
}

export const isTerminalSessionState = (state: SessionState): boolean =>
  terminalStates.has(state)
