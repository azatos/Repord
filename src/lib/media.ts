export type MediaErrorCode =
  | 'permission-denied'
  | 'device-unavailable'
  | 'unsupported'
  | 'unknown'

export type RecordingPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'

export type RecordingStats = {
  chunks: number
  bytes: number
}

export type TrackEventType = 'track-muted' | 'track-unmuted' | 'track-ended'

export type RecordingHandlers = {
  onChunk: (stats: RecordingStats) => void
  onChunkTimingUncertain: (intervalMs: number) => void
  onError: (error: unknown) => void
  onStop: (reason: 'requested' | 'recorder-ended') => void
  onTrackEvent: (type: TrackEventType) => void
}

export type RecordingDependencies = {
  getUserMedia: () => Promise<MediaStream>
  createRecorder: (stream: MediaStream, mimeType?: string) => MediaRecorder
  isTypeSupported: (mimeType: string) => boolean
  monotonicNow: () => number
}

const MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
]

function namedDomError(message: string, name: string): DOMException {
  return new DOMException(message, name)
}

function browserDependencies(): RecordingDependencies {
  return {
    getUserMedia: async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw namedDomError('getUserMedia is unavailable', 'NotSupportedError')
      }
      return navigator.mediaDevices.getUserMedia({ audio: true })
    },
    createRecorder: (stream, mimeType) => {
      if (typeof MediaRecorder === 'undefined') {
        throw namedDomError('MediaRecorder is unavailable', 'NotSupportedError')
      }
      return mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
    },
    isTypeSupported: (mimeType) =>
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported(mimeType),
    monotonicNow: () => performance.now(),
  }
}

function errorName(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  ) {
    return error.name
  }
  return ''
}

export function mapMediaError(error: unknown): MediaErrorCode {
  const name = errorName(error)
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'permission-denied'
  }
  if (
    name === 'NotFoundError' ||
    name === 'NotReadableError' ||
    name === 'OverconstrainedError' ||
    name === 'AbortError'
  ) {
    return 'device-unavailable'
  }
  if (name === 'NotSupportedError') return 'unsupported'
  return 'unknown'
}

export function preferredMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string | undefined {
  return MIME_CANDIDATES.find((type) => isTypeSupported(type))
}

export class RecordingSession {
  private dependencies: RecordingDependencies
  private handlers?: RecordingHandlers
  private stream?: MediaStream
  private recorder?: MediaRecorder
  private phase: RecordingPhase = 'idle'
  private stats: RecordingStats = { chunks: 0, bytes: 0 }
  private lastChunkAt?: number
  private cancelPendingStart = false
  private requestedStop = false
  private tracksReleased = false
  private stopNotified = false
  private trackListeners: Array<{
    track: MediaStreamTrack
    type: 'mute' | 'unmute' | 'ended'
    listener: EventListener
  }> = []

  constructor(dependencies: RecordingDependencies = browserDependencies()) {
    this.dependencies = dependencies
  }

  getSnapshot(): RecordingStats & {
    phase: RecordingPhase
    mimeType: string
    trackReadyState?: MediaStreamTrackState
    trackMuted?: boolean
  } {
    const track = this.stream?.getAudioTracks()[0]
    return {
      ...this.stats,
      phase: this.phase,
      mimeType: this.recorder?.mimeType ?? '',
      trackReadyState: track?.readyState,
      trackMuted: track?.muted,
    }
  }

  async start(handlers: RecordingHandlers): Promise<void> {
    if (this.phase !== 'idle') {
      throw namedDomError('Recording session is already active', 'InvalidStateError')
    }

    this.phase = 'starting'
    this.handlers = handlers
    this.stats = { chunks: 0, bytes: 0 }
    this.lastChunkAt = undefined
    this.cancelPendingStart = false
    this.requestedStop = false
    this.tracksReleased = false
    this.stopNotified = false

    try {
      this.stream = await this.dependencies.getUserMedia()

      if (this.cancelPendingStart) {
        this.releaseTracks()
        this.resetRuntimeState()
        throw namedDomError('Recording start was cancelled', 'AbortError')
      }

      const mimeType = preferredMimeType(this.dependencies.isTypeSupported)
      this.recorder = this.dependencies.createRecorder(this.stream, mimeType)
      this.attachTrackListeners()
      this.attachRecorderListeners()
      this.recorder.start(1000)
      this.phase = 'recording'
    } catch (error) {
      this.releaseTracks()
      this.detachTrackListeners()
      this.resetRuntimeState()
      throw error
    }
  }

  stop(): void {
    if (this.phase === 'idle' || this.phase === 'stopping') return

    if (this.phase === 'starting') {
      this.cancelPendingStart = true
      this.phase = 'stopping'
      return
    }

    this.requestedStop = true
    this.phase = 'stopping'
    const recorder = this.recorder
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    } else {
      this.finishStop('requested')
    }
    this.releaseTracks()
  }

  private attachRecorderListeners(): void {
    if (!this.recorder) return

    this.recorder.ondataavailable = (event) => {
      const now = this.dependencies.monotonicNow()
      if (this.lastChunkAt !== undefined) {
        const interval = now - this.lastChunkAt
        if (interval > 3000) this.handlers?.onChunkTimingUncertain(interval)
      }
      this.lastChunkAt = now

      if (event.data.size > 0) {
        this.stats = {
          chunks: this.stats.chunks + 1,
          bytes: this.stats.bytes + event.data.size,
        }
        this.handlers?.onChunk({ ...this.stats })
      }
    }

    this.recorder.onerror = (event) => {
      const error = 'error' in event ? event.error : event
      this.handlers?.onError(error)
      if (this.phase === 'recording') {
        this.phase = 'stopping'
        this.requestedStop = false
        if (this.recorder?.state !== 'inactive') this.recorder?.stop()
        this.releaseTracks()
      }
    }

    this.recorder.onstop = () => {
      this.finishStop(this.requestedStop ? 'requested' : 'recorder-ended')
    }
  }

  private attachTrackListeners(): void {
    const track = this.stream?.getAudioTracks()[0]
    if (!track) return

    const listeners: Array<{
      type: 'mute' | 'unmute' | 'ended'
      output: TrackEventType
    }> = [
      { type: 'mute', output: 'track-muted' },
      { type: 'unmute', output: 'track-unmuted' },
      { type: 'ended', output: 'track-ended' },
    ]

    for (const { type, output } of listeners) {
      const listener: EventListener = () => {
        if (this.phase !== 'recording') return
        this.handlers?.onTrackEvent(output)
        if (output === 'track-ended') {
          this.phase = 'stopping'
          this.requestedStop = false
          if (this.recorder?.state !== 'inactive') {
            this.recorder?.stop()
          } else {
            this.finishStop('recorder-ended')
          }
          this.releaseTracks()
        }
      }
      track.addEventListener(type, listener)
      this.trackListeners.push({ track, type, listener })
    }
  }

  private detachTrackListeners(): void {
    for (const { track, type, listener } of this.trackListeners) {
      track.removeEventListener(type, listener)
    }
    this.trackListeners = []
  }

  private releaseTracks(): void {
    if (this.tracksReleased) return
    this.tracksReleased = true
    this.stream?.getTracks().forEach((track) => track.stop())
  }

  private finishStop(reason: 'requested' | 'recorder-ended'): void {
    if (this.stopNotified) return
    this.stopNotified = true
    const handlers = this.handlers
    this.releaseTracks()
    this.detachTrackListeners()
    this.resetRuntimeState()
    handlers?.onStop(reason)
  }

  private resetRuntimeState(): void {
    this.phase = 'idle'
    this.stream = undefined
    this.recorder = undefined
    this.handlers = undefined
    this.lastChunkAt = undefined
  }
}
