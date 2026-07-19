import type { OwnerContext } from './session-protocol'
import { type AddChunkServiceResult, type PublicSessionDto, type SessionService } from './session-service'

/** The host supplies authentication; this boundary never parses credentials itself. */
export interface AuthVerifier {
  verify(request: Request): Promise<OwnerContext | undefined>
}

export const MAX_SESSION_REQUEST_BODY_BYTES = 64 * 1024

type PublicErrorCode = 'unauthorized' | 'not-found' | 'method-not-allowed' | 'invalid-payload' | 'body-too-large' | 'precondition-required' | 'invalid-etag' | 'version-conflict' | 'session-conflict' | 'invalid-transition' | 'invalid-state' | 'chunk-id-conflict' | 'sequence-conflict' | 'final-sequence-conflict' | 'missing-chunks'
type SessionValue = PublicSessionDto | AddChunkServiceResult

function headers(extra: HeadersInit = {}): Headers {
  const result = new Headers(extra)
  result.set('content-type', 'application/json; charset=utf-8')
  result.set('cache-control', 'no-store')
  result.set('x-content-type-options', 'nosniff')
  result.set('referrer-policy', 'no-referrer')
  return result
}
function json(status: number, body: unknown, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: headers(extra) })
}
function error(status: number, code: PublicErrorCode, extra: HeadersInit = {}): Response {
  return json(status, { ok: false, error: { code } }, extra)
}
function success(status: number, value: SessionValue, extra: HeadersInit = {}): Response {
  const session = 'session' in value ? value.session : value
  return json(status, { ok: true, data: value }, { ...Object.fromEntries(new Headers(extra)), etag: etag(session.revision) })
}
function etag(revision: number): string { return `"${revision}"` }
function expectedRevision(request: Request): number | undefined {
  const value = request.headers.get('if-match')
  if (value === null) return undefined
  const match = /^"(0|[1-9][0-9]*)"$/.exec(value)
  if (!match) return Number.NaN
  const revision = Number(match[1])
  return Number.isSafeInteger(revision) ? revision : Number.NaN
}
async function body(request: Request): Promise<unknown | 'too-large' | 'invalid'> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_SESSION_REQUEST_BODY_BYTES)) return 'too-large'
  if (request.body === null) return 'invalid'
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_SESSION_REQUEST_BODY_BYTES) { await reader.cancel(); return 'too-large' }
      parts.push(next.value)
    }
  } catch { return 'invalid' }
  try { return JSON.parse(new TextDecoder().decode(parts.length === 1 ? parts[0] : concat(parts, size))) as unknown } catch { return 'invalid' }
}
function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size); let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.byteLength }
  return result
}
function serviceFailure(result: { readonly ok: false; readonly code: string; readonly missingSequences?: readonly number[] }): Response {
  const status: Record<string, number> = { 'not-found': 404, 'version-conflict': 412, 'session-conflict': 409, 'invalid-payload': 400, 'unknown-field': 400, forbidden: 404, 'invalid-transition': 409, 'invalid-state': 409, 'chunk-id-conflict': 409, 'sequence-conflict': 409, 'final-sequence-conflict': 409, 'missing-chunks': 409 }
  const code = result.code === 'unknown-field' || result.code === 'forbidden' || result.code === 'invalid-retention' || result.code === 'overflow' ? 'invalid-payload' : result.code
  const permitted: PublicErrorCode = ['not-found', 'version-conflict', 'session-conflict', 'invalid-payload', 'invalid-transition', 'invalid-state', 'chunk-id-conflict', 'sequence-conflict', 'final-sequence-conflict', 'missing-chunks'].includes(code) ? code as PublicErrorCode : 'invalid-payload'
  const errorBody = result.code === 'missing-chunks' ? { ok: false, error: { code: permitted, missingSequences: result.missingSequences } } : { ok: false, error: { code: permitted } }
  return json(status[result.code] ?? 400, errorBody)
}

/** Framework-neutral handler for the metadata-only `/api/v1/sessions` boundary. */
export function createSessionHttpHandler(service: SessionService, auth: AuthVerifier): (request: Request) => Promise<Response> {
  return async (request) => {
    // Authenticate before route matching, header validation, or consuming a body.
    let owner: OwnerContext | undefined
    try { owner = await auth.verify(request) } catch { owner = undefined }
    if (!owner) return error(401, 'unauthorized', { 'www-authenticate': 'Bearer' })
    const path = new URL(request.url).pathname
    const match = /^\/api\/v1\/sessions(?:\/([A-Za-z0-9._~-]+)(?:\/(start|chunks|finalize))?)?$/.exec(path)
    if (!match) return error(404, 'not-found')
    const [, sessionId, action] = match
    if (!sessionId) {
      if (request.method !== 'POST') return error(405, 'method-not-allowed', { allow: 'POST' })
      const input = await body(request)
      if (input === 'too-large') return error(413, 'body-too-large')
      if (input === 'invalid') return error(400, 'invalid-payload')
      const result = await service.create(owner, input)
      return result.ok ? success(201, result.value, { location: `/api/v1/sessions/${result.value.sessionId}` }) : serviceFailure(result)
    }
    if (!action && request.method === 'GET') {
      const result = await service.get(owner, sessionId)
      return result.ok ? success(200, result.value) : serviceFailure(result)
    }
    const allowed = action === undefined ? 'GET, DELETE' : 'POST'
    if ((!action && request.method !== 'DELETE') || (action && request.method !== 'POST')) return error(405, 'method-not-allowed', { allow: allowed })
    const revision = expectedRevision(request)
    if (revision === undefined) return error(428, 'precondition-required')
    if (Number.isNaN(revision)) return error(400, 'invalid-etag')
    if (!action) {
      const result = await service.delete(owner, sessionId, revision)
      return result.ok ? success(200, result.value) : serviceFailure(result)
    }
    const input = action === 'start' ? undefined : await body(request)
    if (input === 'too-large') return error(413, 'body-too-large')
    if (input === 'invalid') return error(400, 'invalid-payload')
    const result = action === 'start' ? await service.start(owner, sessionId, revision) : action === 'chunks' ? await service.addChunk(owner, sessionId, revision, input) : await service.finalize(owner, sessionId, revision, input)
    return result.ok ? success(200, result.value) : serviceFailure(result)
  }
}
