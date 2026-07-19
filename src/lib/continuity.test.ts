import { describe, expect, it } from 'vitest'
import {
  beginContinuity,
  observe,
  type ContinuityEvent,
  type ContinuityEventType,
} from './continuity'

function event(
  type: ContinuityEventType,
  wallTimeMs: number,
  detail: string = type,
): ContinuityEvent {
  return { type, wallTimeMs, monotonicTimeMs: wallTimeMs, detail }
}

describe('continuity reducer', () => {
  it('starts as observed only when recording begins', () => {
    const continuity = beginContinuity(event('recording-started', 100))
    expect(continuity.state).toBe('observed-continuous')
    expect(continuity.events).toHaveLength(1)
  })

  it('marks an unobservable hidden interval as unknown', () => {
    const continuity = observe(
      beginContinuity(event('recording-started', 100)),
      event('visibility-hidden', 200),
    )
    expect(continuity.state).toBe('continuity-unknown')
    expect(continuity.unknownSinceWallTimeMs).toBe(200)
  })

  it('does not restore an unknown interval to continuous after pageshow', () => {
    const hidden = observe(
      beginContinuity(event('recording-started', 100)),
      event('pagehide', 200),
    )
    const visible = observe(hidden, event('pageshow', 300))
    expect(visible.state).toBe('continuity-unknown')
  })

  it('records an estimated interval only for concrete gap evidence', () => {
    const started = beginContinuity(event('recording-started', 100))
    const chunk = observe(started, event('chunk-observed', 180))
    const ended = observe(chunk, event('track-ended', 220, 'track ended'))

    expect(ended.state).toBe('confirmed-gap')
    expect(ended.gaps).toEqual([
      {
        startWallTimeMs: 180,
        endWallTimeMs: 220,
        reason: 'track ended',
      },
    ])
  })

  it('never downgrades a confirmed gap to unknown', () => {
    const ended = observe(
      beginContinuity(event('recording-started', 100)),
      event('recorder-error', 200),
    )
    const hidden = observe(ended, event('visibility-hidden', 210))
    expect(hidden.state).toBe('confirmed-gap')
  })

  it('estimates a later confirmed gap from the latest observable event', () => {
    const started = beginContinuity(event('recording-started', 100))
    const hidden = observe(started, event('visibility-hidden', 150))
    const visible = observe(hidden, event('visibility-visible', 300))
    const chunk = observe(visible, event('chunk-observed', 350))
    const ended = observe(chunk, event('track-ended', 400))

    expect(ended.gaps[0]?.startWallTimeMs).toBe(350)
    expect(ended.state).toBe('confirmed-gap')
  })
})
