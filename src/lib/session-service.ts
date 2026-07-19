import {
  addChunk,
  createSession,
  deleteSession,
  finalizeSession,
  readSession,
  transitionSession,
  type OwnerContext,
  type ProtocolErrorCode,
  type SessionRecord,
} from './session-protocol'
import type { ContinuityState } from './continuity'

/** Private persistence shape. It intentionally contains protocol metadata, never chunk bytes. */
export type StoredSession = Readonly<{ record: SessionRecord; revision: number }>

export interface SessionRepository {
  get(sessionId: string): Promise<StoredSession | undefined>
  create(session: StoredSession): Promise<boolean>
  compareAndSet(sessionId: string, expectedRevision: number, next: StoredSession): Promise<boolean>
}

function clone<T>(value: T): T { return structuredClone(value) }

/** Test/development-only repository; do not use it for real audio storage. */
export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, StoredSession>()

  async get(sessionId: string): Promise<StoredSession | undefined> {
    const found = this.sessions.get(sessionId)
    return found === undefined ? undefined : clone(found)
  }
  async create(session: StoredSession): Promise<boolean> {
    if (this.sessions.has(session.record.sessionId)) return false
    this.sessions.set(session.record.sessionId, clone(session))
    return true
  }
  async compareAndSet(sessionId: string, expectedRevision: number, next: StoredSession): Promise<boolean> {
    const current = this.sessions.get(sessionId)
    if (current === undefined || current.revision !== expectedRevision) return false
    this.sessions.set(sessionId, clone(next))
    return true
  }
}

export type PublicSessionDto = Readonly<{
  protocolVersion: 1
  sessionId: string
  state: SessionRecord['state']
  revision: number
  receivedChunkCount: number
  receivedSequences: readonly number[]
  confirmedGapCount: number
  continuitySummary: ContinuityState | 'not-observed'
}>
export type SessionServiceErrorCode = ProtocolErrorCode | 'not-found' | 'version-conflict' | 'session-conflict'
export type SessionServiceFailure = Readonly<{ ok: false; code: SessionServiceErrorCode; missingSequences?: readonly number[] }>
export type SessionServiceSuccess<T> = Readonly<{ ok: true; value: T }>
export type SessionServiceResult<T> = SessionServiceSuccess<T> | SessionServiceFailure
export type AddChunkServiceResult = Readonly<{ session: PublicSessionDto; disposition: 'accepted' | 'duplicate' }>

function dto(session: StoredSession): PublicSessionDto {
  const chunks = session.record.chunks
  const states = chunks.map((chunk) => chunk.continuityState)
  const continuitySummary: ContinuityState | 'not-observed' = states.length === 0
    ? 'not-observed'
    : states.includes('confirmed-gap')
      ? 'confirmed-gap'
      : states.includes('continuity-unknown')
        ? 'continuity-unknown'
        : 'observed-continuous'
  return {
    protocolVersion: 1,
    sessionId: session.record.sessionId,
    state: session.record.state,
    revision: session.revision,
    receivedChunkCount: chunks.length,
    receivedSequences: chunks.map((chunk) => chunk.sequence),
    confirmedGapCount: chunks.reduce((count, chunk) => count + chunk.confirmedGaps.length, 0),
    continuitySummary,
  }
}
function protocolFailure<T>(result: { ok: false; code: ProtocolErrorCode; missingSequences?: readonly number[] }): SessionServiceResult<T> {
  return result.missingSequences === undefined ? { ok: false, code: result.code } : { ok: false, code: result.code, missingSequences: result.missingSequences }
}
function hasExpectedRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export class SessionService {
  constructor(private readonly repository: SessionRepository) {}

  async create(context: OwnerContext, input: unknown): Promise<SessionServiceResult<PublicSessionDto>> {
    const created = createSession(context, input)
    if (!created.ok) return protocolFailure(created)
    const stored = { record: created.value, revision: 0 }
    return await this.repository.create(stored)
      ? { ok: true, value: dto(stored) }
      : { ok: false, code: 'session-conflict' }
  }
  async get(context: OwnerContext, sessionId: string): Promise<SessionServiceResult<PublicSessionDto>> {
    const stored = await this.repository.get(sessionId)
    if (stored === undefined || !readSession(context, stored.record).ok) return { ok: false, code: 'not-found' }
    return { ok: true, value: dto(stored) }
  }
  async start(context: OwnerContext, sessionId: string, expectedRevision: number): Promise<SessionServiceResult<PublicSessionDto>> {
    return this.mutate(context, sessionId, expectedRevision, (record) => transitionSession(context, record, 'recording'))
  }
  async addChunk(context: OwnerContext, sessionId: string, expectedRevision: number, input: unknown): Promise<SessionServiceResult<AddChunkServiceResult>> {
    if (!hasExpectedRevision(expectedRevision)) return { ok: false, code: 'invalid-payload' }
    const stored = await this.owned(context, sessionId)
    if (!stored.ok) return stored
    if (stored.value.revision !== expectedRevision) return { ok: false, code: 'version-conflict' }
    const added = addChunk(context, stored.value.record, input)
    if (!added.ok) return protocolFailure(added)
    if (added.value.disposition === 'duplicate') {
      if (!await this.repository.compareAndSet(sessionId, expectedRevision, stored.value)) return { ok: false, code: 'version-conflict' }
      return { ok: true, value: { session: dto(stored.value), disposition: 'duplicate' } }
    }
    const next = { record: added.value.session, revision: stored.value.revision + 1 }
    if (!await this.repository.compareAndSet(sessionId, expectedRevision, next)) return { ok: false, code: 'version-conflict' }
    return { ok: true, value: { session: dto(next), disposition: 'accepted' } }
  }
  async finalize(context: OwnerContext, sessionId: string, expectedRevision: number, input: unknown): Promise<SessionServiceResult<PublicSessionDto>> {
    return this.mutate(context, sessionId, expectedRevision, (record) => finalizeSession(context, record, input))
  }
  async delete(context: OwnerContext, sessionId: string, expectedRevision: number): Promise<SessionServiceResult<PublicSessionDto>> {
    return this.mutate(context, sessionId, expectedRevision, (record) => deleteSession(context, record))
  }

  private async owned(context: OwnerContext, sessionId: string): Promise<SessionServiceResult<StoredSession>> {
    const stored = await this.repository.get(sessionId)
    if (stored === undefined || !readSession(context, stored.record).ok) return { ok: false, code: 'not-found' }
    return { ok: true, value: stored }
  }
  private async mutate(context: OwnerContext, sessionId: string, expectedRevision: number, operation: (record: SessionRecord) => ReturnType<typeof transitionSession>): Promise<SessionServiceResult<PublicSessionDto>> {
    if (!hasExpectedRevision(expectedRevision)) return { ok: false, code: 'invalid-payload' }
    const stored = await this.owned(context, sessionId)
    if (!stored.ok) return stored
    if (stored.value.revision !== expectedRevision) return { ok: false, code: 'version-conflict' }
    const changed = operation(stored.value.record)
    if (!changed.ok) return protocolFailure(changed)
    const next = { record: changed.value, revision: stored.value.revision + 1 }
    if (!await this.repository.compareAndSet(sessionId, expectedRevision, next)) return { ok: false, code: 'version-conflict' }
    return { ok: true, value: dto(next) }
  }
}
