import type { ContinuityState } from './continuity'

export const SESSION_PROTOCOL_VERSION = 1 as const
export const MAX_CHUNKS_PER_SESSION = 86_400
export const MAX_RAW_RETENTION_MS = 24 * 60 * 60 * 1000

const MAX_ID_LENGTH = 128
const MAX_MIME_TYPE_LENGTH = 255

export type OwnerContext = Readonly<{ ownerId: string }>
export type SessionState =
  | 'created'
  | 'recording'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'deleted'
export type ConfirmedGap = Readonly<{ startMs: number; endMs: number }>

export type ClientCreateSessionCommand = Readonly<{
  protocolVersion: typeof SESSION_PROTOCOL_VERSION
  sessionId: string
}>
export type ClientFinalizeSessionCommand = Readonly<{
  protocolVersion: typeof SESSION_PROTOCOL_VERSION
  sessionId: string
  declaredFinalSequence: number
}>
/** Untrusted client metadata. Ownership is never part of this payload. */
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
  | 'invalid-transition'
  | 'invalid-state'
  | 'chunk-id-conflict'
  | 'sequence-conflict'
  | 'final-sequence-conflict'
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
export type AddChunkResult = Readonly<{
  session: SessionRecord
  disposition: 'accepted' | 'duplicate'
}>

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
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && /^[A-Za-z0-9._~-]+$/.test(value)
}
function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
function isSequence(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0 && value < MAX_CHUNKS_PER_SESSION
}
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0 || code <= 31 || code === 127) return true
  }
  return false
}
function isValidMimeType(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MIME_TYPE_LENGTH && !hasControlCharacter(value)
}
function isValidGap(value: unknown): value is ConfirmedGap {
  return isRecord(value) && hasOnlyFields(value, ['startMs', 'endMs']) && isSafeInteger(value.startMs) && isSafeInteger(value.endMs) && value.startMs >= 0 && value.endMs >= value.startMs
}
function canonicalizeGaps(gaps: readonly ConfirmedGap[]): ConfirmedGap[] | undefined {
  const canonical = gaps.map(({ startMs, endMs }) => ({ startMs, endMs })).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  return canonical.some((gap, index) => index > 0 && gap.startMs <= canonical[index - 1]!.endMs) ? undefined : canonical
}

export function parseClientCreateSessionCommand(input: unknown): ProtocolResult<ClientCreateSessionCommand> {
  if (!isRecord(input)) return failure('invalid-payload')
  if (!hasOnlyFields(input, ['protocolVersion', 'sessionId'])) return failure('unknown-field')
  if (input.protocolVersion !== SESSION_PROTOCOL_VERSION || !isOpaqueId(input.sessionId)) return failure('invalid-payload')
  return { ok: true, value: { protocolVersion: SESSION_PROTOCOL_VERSION, sessionId: input.sessionId } }
}
export function parseClientFinalizeSessionCommand(input: unknown): ProtocolResult<ClientFinalizeSessionCommand> {
  if (!isRecord(input)) return failure('invalid-payload')
  if (!hasOnlyFields(input, ['protocolVersion', 'sessionId', 'declaredFinalSequence'])) return failure('unknown-field')
  if (input.protocolVersion !== SESSION_PROTOCOL_VERSION || !isOpaqueId(input.sessionId) || !isSequence(input.declaredFinalSequence)) return failure('invalid-payload')
  return { ok: true, value: { protocolVersion: SESSION_PROTOCOL_VERSION, sessionId: input.sessionId, declaredFinalSequence: input.declaredFinalSequence } }
}
export function parseClientChunkMetadata(input: unknown): ProtocolResult<ClientChunkMetadata> {
  if (!isRecord(input)) return failure('invalid-payload')
  const fields = ['protocolVersion', 'sessionId', 'chunkId', 'sequence', 'captureStartMs', 'captureEndMs', 'mimeType', 'byteLength', 'sha256', 'continuityState', 'confirmedGaps']
  if (!hasOnlyFields(input, fields)) return failure('unknown-field')
  if (input.protocolVersion !== SESSION_PROTOCOL_VERSION || !isOpaqueId(input.sessionId) || !isOpaqueId(input.chunkId) || !isSequence(input.sequence) || !isSafeInteger(input.captureStartMs) || !isSafeInteger(input.captureEndMs) || input.captureStartMs < 0 || input.captureEndMs < input.captureStartMs || !isValidMimeType(input.mimeType) || !isSafeInteger(input.byteLength) || input.byteLength <= 0 || typeof input.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(input.sha256) || !['observed-continuous', 'confirmed-gap', 'continuity-unknown'].includes(input.continuityState as string) || !Array.isArray(input.confirmedGaps) || !input.confirmedGaps.every(isValidGap)) return failure('invalid-payload')
  const gaps = canonicalizeGaps(input.confirmedGaps as ConfirmedGap[])
  const captureStartMs = input.captureStartMs as number
  const captureEndMs = input.captureEndMs as number
  if (!gaps || gaps.some((gap) => gap.startMs < captureStartMs || gap.endMs > captureEndMs) || (input.continuityState === 'confirmed-gap' && gaps.length === 0) || (input.continuityState !== 'confirmed-gap' && gaps.length !== 0)) return failure('invalid-payload')
  return { ok: true, value: { protocolVersion: SESSION_PROTOCOL_VERSION, sessionId: input.sessionId, chunkId: input.chunkId, sequence: input.sequence, captureStartMs: input.captureStartMs, captureEndMs: input.captureEndMs, mimeType: input.mimeType, byteLength: input.byteLength, sha256: input.sha256.toLowerCase(), continuityState: input.continuityState as ContinuityState, confirmedGaps: gaps } }
}

export function createSession(context: OwnerContext, input: unknown): ProtocolResult<SessionRecord> {
  const command = parseClientCreateSessionCommand(input)
  if (!command.ok) return command
  if (!isOpaqueId(context.ownerId)) return failure('invalid-payload')
  return { ok: true, value: { protocolVersion: SESSION_PROTOCOL_VERSION, sessionId: command.value.sessionId, ownerId: context.ownerId, state: 'created', chunks: [] } }
}
function owns(context: OwnerContext, session: SessionRecord): boolean { return context.ownerId === session.ownerId }
export function readSession(context: OwnerContext, session: SessionRecord): ProtocolResult<SessionRecord> { return owns(context, session) ? { ok: true, value: session } : failure('forbidden') }
const allowedTransitions: Readonly<Record<SessionState, readonly SessionState[]>> = { created: ['recording', 'failed', 'deleted'], recording: ['finalizing', 'failed', 'deleted'], finalizing: ['completed', 'failed', 'deleted'], completed: ['deleted'], failed: ['deleted'], deleted: [] }
export function transitionSession(context: OwnerContext, session: SessionRecord, nextState: SessionState): ProtocolResult<SessionRecord> {
  if (!owns(context, session)) return failure('forbidden')
  if (!allowedTransitions[session.state].includes(nextState)) return failure('invalid-transition')
  return { ok: true, value: nextState === 'deleted' ? { ...session, state: 'deleted', chunks: [] } : { ...session, state: nextState } }
}
function chunksMatch(left: ClientChunkMetadata, right: ClientChunkMetadata): boolean {
  return left.protocolVersion === right.protocolVersion && left.sessionId === right.sessionId && left.chunkId === right.chunkId && left.sequence === right.sequence && left.captureStartMs === right.captureStartMs && left.captureEndMs === right.captureEndMs && left.mimeType === right.mimeType && left.byteLength === right.byteLength && left.sha256 === right.sha256 && left.continuityState === right.continuityState && left.confirmedGaps.length === right.confirmedGaps.length && left.confirmedGaps.every((gap, index) => gap.startMs === right.confirmedGaps[index]?.startMs && gap.endMs === right.confirmedGaps[index]?.endMs)
}
export function addChunk(context: OwnerContext, session: SessionRecord, input: unknown): ProtocolResult<AddChunkResult> {
  if (!owns(context, session)) return failure('forbidden')
  if (session.state !== 'recording') return failure('invalid-state')
  const parsed = parseClientChunkMetadata(input)
  if (!parsed.ok) return parsed
  const chunk = parsed.value
  if (chunk.sessionId !== session.sessionId) return failure('invalid-payload')
  const sameId = session.chunks.find((existing) => existing.chunkId === chunk.chunkId)
  if (sameId) return chunksMatch(sameId, chunk) ? { ok: true, value: { session, disposition: 'duplicate' } } : failure('chunk-id-conflict')
  if (session.chunks.some((existing) => existing.sequence === chunk.sequence)) return failure('sequence-conflict')
  const chunks = [...session.chunks, chunk].sort((left, right) => left.sequence - right.sequence)
  return { ok: true, value: { session: { ...session, chunks }, disposition: 'accepted' } }
}
export function finalizeSession(context: OwnerContext, session: SessionRecord, input: unknown): ProtocolResult<SessionRecord> {
  if (!owns(context, session)) return failure('forbidden')
  if (session.state !== 'recording') return failure('invalid-state')
  const command = parseClientFinalizeSessionCommand(input)
  if (!command.ok) return command
  if (command.value.sessionId !== session.sessionId) return failure('invalid-payload')
  if (session.chunks.some((chunk) => chunk.sequence > command.value.declaredFinalSequence)) return failure('final-sequence-conflict')
  const present = new Set(session.chunks.map((chunk) => chunk.sequence))
  const missingSequences = Array.from({ length: command.value.declaredFinalSequence + 1 }, (_, sequence) => sequence).filter((sequence) => !present.has(sequence))
  return missingSequences.length > 0 ? { ok: false, code: 'missing-chunks', missingSequences } : { ok: true, value: { ...session, state: 'finalizing' } }
}
export function deleteSession(context: OwnerContext, session: SessionRecord): ProtocolResult<SessionRecord> { return transitionSession(context, session, 'deleted') }
function deadline(baseTimeMs: number, configuredRetentionMs: number): ProtocolResult<number> {
  if (!isSafeInteger(baseTimeMs) || baseTimeMs < 0 || !isSafeInteger(configuredRetentionMs) || configuredRetentionMs <= 0) return failure('invalid-retention')
  const value = baseTimeMs + Math.min(configuredRetentionMs, MAX_RAW_RETENTION_MS)
  return Number.isSafeInteger(value) ? { ok: true, value } : failure('overflow')
}
export function successfulRawDeletionDeadline(processedAtMs: number, configuredRetentionMs: number): ProtocolResult<number> { return deadline(processedAtMs, configuredRetentionMs) }
export function interruptedRawDeletionDeadline(lastActivityAtMs: number, configuredRetentionMs: number): ProtocolResult<number> { return deadline(lastActivityAtMs, configuredRetentionMs) }
export const isTerminalSessionState = (state: SessionState): boolean => state === 'deleted'
