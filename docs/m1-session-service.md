# M1 In-memory Session Service

`SessionService` is a test/development-only asynchronous façade over the M1 session protocol. It reuses the protocol's parsers and transition functions; it does not authenticate requests, receive audio, or persist data outside process memory.

## Contract

- Every read and mutation receives a trusted `OwnerContext`. A missing session and a session owned by another owner both return public `not-found`.
- `create` uses `session-conflict` when the session ID is already occupied. It never replaces the existing record.
- `start`, `addChunk`, `finalize`, and `delete` use a non-negative safe-integer `expectedRevision`. A stale or failed CAS returns `version-conflict` and leaves persisted state unchanged.
- Public session DTOs contain only `protocolVersion`, `sessionId`, `state`, `revision`, `receivedChunkCount`, `receivedSequences`, `confirmedGapCount`, and `continuitySummary`. They exclude owners, digests, raw chunks, and client input payloads.
- A session without chunks reports `not-observed`. Once chunks exist, summary priority is `confirmed-gap`, then `continuity-unknown`, then `observed-continuous`.
- Delete writes a `deleted` tombstone with no chunks. The tombstone remains readable by its owner but rejects later mutations.

## Non-goals

This is not production storage or an M1 completion claim. The separate framework-neutral [M1 session HTTP boundary](m1-session-api.md) reuses this service and accepts a host-provided asynchronous authentication verifier, but it does not provide a real verifier or listener. Raw-audio storage, expiry/deletion workers, and actual iPhone upload validation remain unimplemented. IOS-06 and IOS-07 remain `not-run`.
