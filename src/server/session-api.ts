import type { OwnerContext } from '../lib/session-protocol'
import { type AddChunkServiceResult, type PublicSessionDto, type SessionService } from '../lib/session-service'

export interface AuthVerifier {
  verify(request: Request): Promise<OwnerContext | undefined>
}

export const MAX_SESSION_REQUEST_BODY_BYTES = 64 * 1024

type PublicValue = PublicSessionDto | AddChunkServiceResult
type ErrorCode = 'unauthorized' | 'not-found' | 'method-not-allowed' | 'invalid-payload' | 'unsupported-media-type' | 'body-too-large' | 'invalid-precondition' | 'version-conflict' | 'session-conflict' | 'invalid-transition' | 'invalid-state' | 'chunk-id-conflict' | 'sequence-conflict' | 'final-sequence-conflict' | 'missing-chunks' | 'internal-error'

function response(status: number, payload: object, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('referrer-policy', 'no-referrer')
  return new Response(JSON.stringify(payload), { status, headers })
}
function failure(status: number, code: ErrorCode, details: object = {}, extra: HeadersInit = {}): Response {
  return response(status, { error: { code, ...details } }, extra)
}
function etag(revision: number): string { return `"${revision}"` }
function success(status: number, value: PublicValue, extra: HeadersInit = {}): Response {
  const session = 'session' in value ? value.session : value
  const headers = new Headers(extra)
  headers.set('etag', etag(session.revision))
  return response(status, { data: value }, headers)
}
function ifMatch(request: Request): number | undefined {
  const value = request.headers.get('if-match')
  const match = value === null ? undefined : /^"(0|[1-9][0-9]*)"$/.exec(value)
  if (!match) return undefined
  const revision = Number(match[1])
  return Number.isSafeInteger(revision) ? revision : undefined
}
function jsonContentType(request: Request): boolean {
  const value = request.headers.get('content-type')
  return value !== null && value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json'
}
async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; code: 'body-too-large' | 'invalid-payload' }> {
  const length = request.headers.get('content-length')
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_SESSION_REQUEST_BODY_BYTES)) return { ok: false, code: 'body-too-large' }
  if (request.body === null) return { ok: false, code: 'invalid-payload' }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let lengthRead = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      lengthRead += item.value.byteLength
      if (lengthRead > MAX_SESSION_REQUEST_BODY_BYTES) { await reader.cancel(); return { ok: false, code: 'body-too-large' } }
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(lengthRead)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  } catch { return { ok: false, code: 'invalid-payload' } }
}
function serviceFailure(result: { readonly code: string; readonly missingSequences?: readonly number[] }): Response {
  const mapped: Record<string, readonly [number, ErrorCode]> = {
    'not-found': [404, 'not-found'], 'version-conflict': [409, 'version-conflict'], 'session-conflict': [409, 'session-conflict'],
    'invalid-transition': [409, 'invalid-transition'], 'invalid-state': [409, 'invalid-state'], 'chunk-id-conflict': [409, 'chunk-id-conflict'],
    'sequence-conflict': [409, 'sequence-conflict'], 'final-sequence-conflict': [409, 'final-sequence-conflict'], 'missing-chunks': [409, 'missing-chunks'],
  }
  const [status, code] = mapped[result.code] ?? [400, 'invalid-payload']
  return failure(status, code, result.code === 'missing-chunks' ? { missingSequences: result.missingSequences } : {})
}
function route(request: Request): readonly [string | undefined, 'start' | 'chunks' | 'finalize' | undefined] | undefined {
  const url = new URL(request.url)
  if (url.search || url.pathname.includes('%')) return undefined
  const match = /^\/api\/v1\/sessions(?:\/([A-Za-z0-9._~-]{1,128})(?:\/(start|chunks|finalize))?)?$/.exec(url.pathname)
  return match === null ? undefined : [match[1], match[2] as 'start' | 'chunks' | 'finalize' | undefined]
}

/** Framework-neutral, metadata-only HTTP boundary. The host owns authentication and hosting. */
export function createSessionApi(service: SessionService, auth: AuthVerifier): (request: Request) => Promise<Response> {
  return async (request) => {
    let owner: OwnerContext | undefined
    try { owner = await auth.verify(request) } catch { return failure(500, 'internal-error') }
    if (!owner) return failure(401, 'unauthorized', {}, { 'www-authenticate': 'Bearer' })
    try {
      const matched = route(request)
      if (!matched) return failure(404, 'not-found')
      const [sessionId, action] = matched
      if (!sessionId) {
        if (request.method !== 'POST') return failure(405, 'method-not-allowed', {}, { allow: 'POST' })
        if (!jsonContentType(request)) return failure(415, 'unsupported-media-type')
        const input = await readJson(request)
        if (!input.ok) return failure(input.code === 'body-too-large' ? 413 : 400, input.code)
        const result = await service.create(owner, input.value)
        return result.ok ? success(201, result.value, { location: `/api/v1/sessions/${result.value.sessionId}` }) : serviceFailure(result)
      }
      if (!action && request.method === 'GET') {
        const result = await service.get(owner, sessionId)
        return result.ok ? success(200, result.value) : serviceFailure(result)
      }
      if ((!action && request.method !== 'DELETE') || (action && request.method !== 'POST')) return failure(405, 'method-not-allowed', {}, { allow: action ? 'POST' : 'GET, DELETE' })
      const revision = ifMatch(request)
      if (revision === undefined) return failure(428, 'invalid-precondition')
      if (!action) {
        const result = await service.delete(owner, sessionId, revision)
        return result.ok ? success(200, result.value) : serviceFailure(result)
      }
      if (action !== 'start' && !jsonContentType(request)) return failure(415, 'unsupported-media-type')
      if (action === 'start') {
        const result = await service.start(owner, sessionId, revision)
        return result.ok ? success(200, result.value) : serviceFailure(result)
      }
      const input = await readJson(request)
      if (!input.ok) return failure(input.code === 'body-too-large' ? 413 : 400, input.code)
      const result = action === 'chunks' ? await service.addChunk(owner, sessionId, revision, input.value) : await service.finalize(owner, sessionId, revision, input.value)
      return result.ok ? success(200, result.value) : serviceFailure(result)
    } catch { return failure(500, 'internal-error') }
  }
}
