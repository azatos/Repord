# M1 Session HTTP API boundary

`src/server/session-api.ts` provides a framework-neutral handler `(Request) => Promise<Response>` for metadata-only M1 session coordination. A host application supplies the asynchronous `AuthVerifier`; this repository deliberately supplies neither an authentication SDK nor a production verifier, server listener, database, or object storage.

## Routes and response contract

All routes are under `/api/v1/sessions`. Every response is JSON with either `{ "data": ... }` or `{ "error": { "code": ... } }`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.

| Method | Route | Result |
| --- | --- | --- |
| `POST` | `/api/v1/sessions` | Creates a session (`201`, `Location`, ETag). |
| `GET` | `/api/v1/sessions/{sessionId}` | Reads the owner-scoped public DTO (`200`, ETag). |
| `POST` | `/api/v1/sessions/{sessionId}/start` | Starts a session. |
| `POST` | `/api/v1/sessions/{sessionId}/chunks` | Stores validated **metadata only**; it never receives audio bytes. |
| `POST` | `/api/v1/sessions/{sessionId}/finalize` | Begins finalization after sequence validation. |
| `DELETE` | `/api/v1/sessions/{sessionId}` | Writes the service's deletion tombstone. |

Authentication is evaluated before route selection, header validation, or body reads. An unavailable or rejected identity receives `401` with `WWW-Authenticate: Bearer`; another owner's session remains indistinguishable from absent (`404`). The handler does not log request inputs.

## Revision preconditions and request limits

`GET` and successful mutations emit a strong ETag in the exact form `"{revision}"`. `start`, `chunks`, `finalize`, and `DELETE` require an exact matching `If-Match` value: a missing header is `428 precondition-required`; weak, list, wildcard, malformed, or unsafe values are `400 invalid-precondition`; and a stale/losing CAS is `409 version-conflict`.

JSON bodies must use `application/json`, optionally with `charset=utf-8`, are decoded as fatal UTF-8, and are read from the Web Standard stream with a 64 KiB (`65,536` byte) maximum, including when `Content-Length` is absent. Unsupported media types or charsets return `415 unsupported-media-type`; larger bodies return `413 body-too-large`; malformed, absent, or invalid UTF-8 JSON returns `400 invalid-payload`. Query strings and percent-encoded route forms are rejected. Protocol and service errors use stable non-sensitive codes only, and unexpected failures return sanitized `500 internal-error`. Public success/error responses never include owner IDs, bearer tokens, SHA-256 digests, raw chunk content, or unvalidated input.

## Scope

This boundary reuses `SessionService` and the protocol—it does not reimplement their state machine or parsers. It is not a production deployment and does not make M1 complete. Real authentication, production persistence, raw audio, upload processing, and deletion/retention workers remain unimplemented. IOS-06 and IOS-07 remain `not-run`; HTTP tests do not replace actual iPhone validation.
