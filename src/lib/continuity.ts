export type ContinuityState =
  | 'observed-continuous'
  | 'confirmed-gap'
  | 'continuity-unknown'

export type ContinuityEventType =
  | 'start-error'
  | 'recording-started'
  | 'chunk-observed'
  | 'chunk-timing-uncertain'
  | 'visibility-hidden'
  | 'visibility-visible'
  | 'pagehide'
  | 'pageshow'
  | 'track-muted'
  | 'track-unmuted'
  | 'track-ended'
  | 'recorder-error'
  | 'stop-requested'
  | 'recording-stopped'

export type ContinuityEvent = {
  wallTimeMs: number
  monotonicTimeMs: number
  type: ContinuityEventType
  detail: string
}

export type GapInterval = {
  startWallTimeMs: number
  endWallTimeMs: number
  reason: string
}

export type Continuity = {
  state: ContinuityState
  events: ContinuityEvent[]
  startedAtWallTimeMs: number
  lastObservedWallTimeMs: number
  unknownSinceWallTimeMs?: number
  gaps: GapInterval[]
}

const confirmedGapEvents = new Set<ContinuityEventType>([
  'track-ended',
  'recorder-error',
])

const unknownEvents = new Set<ContinuityEventType>([
  'chunk-timing-uncertain',
  'visibility-hidden',
  'pagehide',
  'track-muted',
])

export function createContinuityEvent(
  type: ContinuityEventType,
  detail: string,
  clock: Pick<typeof globalThis, 'performance'> = globalThis,
): ContinuityEvent {
  return {
    wallTimeMs: Date.now(),
    monotonicTimeMs: clock.performance.now(),
    type,
    detail,
  }
}

export function beginContinuity(start: ContinuityEvent): Continuity {
  return {
    state: 'observed-continuous',
    events: [start],
    startedAtWallTimeMs: start.wallTimeMs,
    lastObservedWallTimeMs: start.wallTimeMs,
    gaps: [],
  }
}

export function observe(
  continuity: Continuity,
  event: ContinuityEvent,
): Continuity {
  const events = [...continuity.events, event]

  if (confirmedGapEvents.has(event.type)) {
    const startWallTimeMs = Math.min(
      continuity.lastObservedWallTimeMs,
      event.wallTimeMs,
    )
    return {
      ...continuity,
      state: 'confirmed-gap',
      events,
      lastObservedWallTimeMs: event.wallTimeMs,
      gaps: [
        ...continuity.gaps,
        {
          startWallTimeMs,
          endWallTimeMs: Math.max(startWallTimeMs, event.wallTimeMs),
          reason: event.detail,
        },
      ],
    }
  }

  if (unknownEvents.has(event.type)) {
    return {
      ...continuity,
      state:
        continuity.state === 'confirmed-gap'
          ? 'confirmed-gap'
          : 'continuity-unknown',
      events,
      unknownSinceWallTimeMs:
        continuity.unknownSinceWallTimeMs ?? event.wallTimeMs,
    }
  }

  return {
    ...continuity,
    events,
    lastObservedWallTimeMs: event.wallTimeMs,
  }
}
