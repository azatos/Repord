import { describe, expect, it, vi } from 'vitest'
import {
  mapMediaError,
  preferredMimeType,
  RecordingSession,
  type RecordingDependencies,
  type RecordingHandlers,
} from './media'

function errorWithName(name: string): Error {
  return Object.assign(new Error(name), { name })
}

function testHarness() {
  const listeners = new Map<string, EventListener>()
  const track = {
    readyState: 'live',
    muted: false,
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener)
    }),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream
  const recorder = {
    state: 'inactive' as RecordingState,
    mimeType: 'audio/mp4',
    ondataavailable: null,
    onerror: null,
    onstop: null,
    start: vi.fn(function (this: { state: RecordingState }) {
      this.state = 'recording'
    }),
    stop: vi.fn(function (this: {
      state: RecordingState
      onstop: (() => void) | null
    }) {
      this.state = 'inactive'
      this.onstop?.()
    }),
  } as unknown as MediaRecorder
  const dependencies: RecordingDependencies = {
    getUserMedia: vi.fn(async () => stream),
    createRecorder: vi.fn(() => recorder),
    isTypeSupported: vi.fn((type) => type === 'audio/mp4'),
    monotonicNow: vi.fn(() => 1000),
  }
  const handlers: RecordingHandlers = {
    onChunk: vi.fn(),
    onChunkTimingUncertain: vi.fn(),
    onError: vi.fn(),
    onStop: vi.fn(),
    onTrackEvent: vi.fn(),
  }
  return { dependencies, handlers, listeners, recorder, stream, track }
}

describe('media errors', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'device-unavailable'],
    ['NotReadableError', 'device-unavailable'],
    ['OverconstrainedError', 'device-unavailable'],
    ['NotSupportedError', 'unsupported'],
    ['UnexpectedError', 'unknown'],
  ])('maps %s to %s', (name, code) => {
    expect(mapMediaError(errorWithName(name))).toBe(code)
  })

  it('selects the first supported Safari-compatible MIME type', () => {
    expect(preferredMimeType((type) => type === 'audio/webm')).toBe(
      'audio/webm',
    )
    expect(preferredMimeType(() => false)).toBeUndefined()
  })
})

describe('RecordingSession', () => {
  it('starts, stops, releases tracks, and ignores duplicate stop calls', async () => {
    const harness = testHarness()
    const session = new RecordingSession(harness.dependencies)

    await session.start(harness.handlers)
    expect(session.getSnapshot().phase).toBe('recording')

    session.stop()
    session.stop()

    expect(harness.recorder.stop).toHaveBeenCalledOnce()
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.handlers.onStop).toHaveBeenCalledOnce()
    expect(session.getSnapshot().phase).toBe('idle')
  })

  it('rejects a duplicate start while already recording', async () => {
    const harness = testHarness()
    const session = new RecordingSession(harness.dependencies)
    await session.start(harness.handlers)

    await expect(session.start(harness.handlers)).rejects.toMatchObject({
      name: 'InvalidStateError',
    })
    session.stop()
  })

  it('releases a stream when recorder construction fails', async () => {
    const harness = testHarness()
    harness.dependencies.createRecorder = vi.fn(() => {
      throw errorWithName('NotSupportedError')
    })
    const session = new RecordingSession(harness.dependencies)

    await expect(session.start(harness.handlers)).rejects.toMatchObject({
      name: 'NotSupportedError',
    })
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(session.getSnapshot().phase).toBe('idle')
  })

  it('reports a track-ended event and stops an interrupted recorder', async () => {
    const harness = testHarness()
    const session = new RecordingSession(harness.dependencies)
    await session.start(harness.handlers)

    harness.listeners.get('ended')?.({} as Event)

    expect(harness.handlers.onTrackEvent).toHaveBeenCalledWith('track-ended')
    expect(harness.recorder.stop).toHaveBeenCalledOnce()
    expect(harness.handlers.onStop).toHaveBeenCalledWith('recorder-ended')
    expect(harness.track.stop).toHaveBeenCalledOnce()
  })
})
