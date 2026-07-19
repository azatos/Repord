import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  beginContinuity,
  createContinuityEvent,
  observe,
  type Continuity,
  type ContinuityEvent,
  type ContinuityEventType,
} from './lib/continuity'
import {
  mapMediaError,
  RecordingSession,
  type MediaErrorCode,
  type RecordingStats,
  type TrackEventType,
} from './lib/media'
import {
  readMicrophonePermission,
  type MicrophonePermissionState,
} from './lib/permissions'
import './style.css'

const BUILD = import.meta.env.VITE_COMMIT_SHA || 'local-dev'
const VERSION = '0.1.0'

type Result = 'not-run' | 'pass' | 'fail' | 'blocked'
type AppStatus = 'idle' | 'starting' | 'recording' | 'stopping'

type DeviceMetadata = {
  model: string
  iosVersion: string
  safariVersion: string
  tester: string
  network: string
  externalInput: 'no' | 'yes'
  notes: string
}

const EMPTY_STATS: RecordingStats = { chunks: 0, bytes: 0 }
const ERROR_MESSAGES: Record<MediaErrorCode, string> = {
  'permission-denied': '마이크 권한이 거부되었습니다. Safari 설정을 확인한 뒤 다시 시도하세요.',
  'device-unavailable': '사용 가능한 마이크를 열 수 없습니다. 다른 앱의 사용 여부와 장치 상태를 확인하세요.',
  unsupported: '이 브라우저는 필요한 마이크 또는 MediaRecorder API를 지원하지 않습니다.',
  unknown: '예상하지 못한 마이크 오류가 발생했습니다.',
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function App() {
  const session = useRef(new RecordingSession())
  const mounted = useRef(true)
  const recordingActive = useRef(false)
  const startedAt = useRef<number | undefined>(undefined)
  const [status, setStatus] = useState<AppStatus>('idle')
  const [clockNow, setClockNow] = useState(Date.now())
  const [stats, setStats] = useState<RecordingStats>(EMPTY_STATS)
  const [continuity, setContinuity] = useState<Continuity | null>(null)
  const [events, setEvents] = useState<ContinuityEvent[]>([])
  const [error, setError] = useState<MediaErrorCode | null>(null)
  const [permission, setPermission] =
    useState<MicrophonePermissionState>('unknown')
  const [serviceWorker, setServiceWorker] = useState<
    'checking' | 'registered' | 'unsupported' | 'error'
  >('checking')
  const [device, setDevice] = useState<DeviceMetadata>({
    model: '',
    iosVersion: '',
    safariVersion: '',
    tester: '',
    network: '',
    externalInput: 'no',
    notes: '',
  })
  const [scenario, setScenario] = useState('IOS-01')
  const [result, setResult] = useState<Result>('not-run')
  const [reportError, setReportError] = useState('')

  const standalone = useMemo(isStandalone, [])
  const secureContext = window.isSecureContext
  const mediaDevicesSupported = Boolean(navigator.mediaDevices?.getUserMedia)
  const mediaRecorderSupported = typeof MediaRecorder !== 'undefined'
  const snapshot = session.current.getSnapshot()
  const elapsed = startedAt.current
    ? Math.max(0, Math.floor((clockNow - startedAt.current) / 1000))
    : 0

  const appendEvent = useCallback(
    (
      type: ContinuityEventType,
      detail: string,
      affectsContinuity = recordingActive.current,
    ) => {
      const event = createContinuityEvent(type, detail)
      setEvents((current) => [...current, event])
      if (affectsContinuity) {
        setContinuity((current) =>
          current ? observe(current, event) : beginContinuity(event),
        )
      }
      return event
    },
    [],
  )

  useEffect(() => {
    mounted.current = true
    void readMicrophonePermission().then((state) => {
      if (mounted.current) setPermission(state)
    })

    if (!('serviceWorker' in navigator)) {
      setServiceWorker('unsupported')
    } else {
      const serviceWorkerUrl = `${import.meta.env.BASE_URL}sw.js`
      void navigator.serviceWorker
        .register(serviceWorkerUrl, { scope: import.meta.env.BASE_URL })
        .then(() => {
          if (mounted.current) setServiceWorker('registered')
        })
        .catch(() => {
          if (mounted.current) setServiceWorker('error')
        })
    }

    const onVisibilityChange = () => {
      if (!recordingActive.current) return
      appendEvent(
        document.hidden ? 'visibility-hidden' : 'visibility-visible',
        document.hidden
          ? '페이지가 숨겨져 해당 구간의 녹음 연속성을 관찰할 수 없습니다.'
          : '페이지가 다시 보이지만 숨겨진 구간의 완전성은 자동으로 복구되지 않습니다.',
      )
    }
    const onPageHide = () => {
      if (recordingActive.current) {
        appendEvent('pagehide', '페이지 수명주기가 관찰 가능한 상태를 벗어났습니다.')
      }
    }
    const onPageShow = () => {
      if (recordingActive.current) {
        appendEvent('pageshow', '페이지 수명주기가 다시 관찰 가능한 상태가 되었습니다.')
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)

    return () => {
      mounted.current = false
      recordingActive.current = false
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      session.current.stop()
    }
  }, [appendEvent])

  useEffect(() => {
    if (status !== 'recording') return
    setClockNow(Date.now())
    const interval = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [status])

  const start = async () => {
    if (status !== 'idle') return

    setStatus('starting')
    setError(null)
    setReportError('')
    setStats(EMPTY_STATS)
    setEvents([])
    setContinuity(null)
    startedAt.current = undefined

    try {
      await session.current.start({
        onChunk: (nextStats) => {
          if (!mounted.current) return
          setStats(nextStats)
          appendEvent('chunk-observed', '오디오 Blob을 집계한 뒤 즉시 폐기했습니다.')
        },
        onChunkTimingUncertain: (intervalMs) => {
          if (!mounted.current) return
          appendEvent(
            'chunk-timing-uncertain',
            `청크 관찰 간격 ${Math.round(intervalMs)}ms 동안 녹음 완전성을 확인할 수 없습니다.`,
          )
        },
        onError: (recordingError) => {
          if (!mounted.current) return
          const code = mapMediaError(recordingError)
          setError(code)
          appendEvent('recorder-error', `녹음 중 MediaRecorder 오류: ${code}`)
        },
        onStop: (reason) => {
          if (!mounted.current) return
          appendEvent(
            'recording-stopped',
            reason === 'requested'
              ? '사용자 요청으로 녹음을 종료했습니다.'
              : 'MediaRecorder가 사용자 요청 없이 종료되었습니다.',
          )
          recordingActive.current = false
          setStatus('idle')
          setStats(session.current.getSnapshot())
          setClockNow(Date.now())
        },
        onTrackEvent: (trackEvent: TrackEventType) => {
          if (!mounted.current) return
          const detail = {
            'track-muted': '오디오 트랙이 muted 상태가 되어 연속성을 확인할 수 없습니다.',
            'track-unmuted': '오디오 트랙이 muted 상태에서 복귀했습니다.',
            'track-ended': '오디오 트랙이 종료되어 녹음 공백이 확인되었습니다.',
          }[trackEvent]
          appendEvent(trackEvent, detail)
        },
      })

      if (!mounted.current) {
        session.current.stop()
        return
      }

      const startEvent = createContinuityEvent(
        'recording-started',
        '포그라운드 녹음을 시작했습니다.',
      )
      recordingActive.current = true
      startedAt.current = startEvent.wallTimeMs
      setClockNow(startEvent.wallTimeMs)
      setEvents([startEvent])
      setContinuity(beginContinuity(startEvent))
      setStats(session.current.getSnapshot())
      setStatus('recording')
      setPermission('granted')
    } catch (startError) {
      if (!mounted.current) return
      const code = mapMediaError(startError)
      setError(code)
      if (code === 'permission-denied') setPermission('denied')
      setStatus('idle')
      const event = createContinuityEvent(
        'start-error',
        `녹음을 시작하지 못했습니다: ${code}`,
      )
      setEvents([event])
    }
  }

  const stop = () => {
    if (status !== 'recording') return
    appendEvent('stop-requested', '사용자가 녹음 종료를 요청했습니다.')
    setStatus('stopping')
    session.current.stop()
  }

  const clearLog = () => {
    if (status !== 'idle') return
    setEvents([])
    setContinuity(null)
    setError(null)
    setStats(EMPTY_STATS)
    startedAt.current = undefined
    setClockNow(Date.now())
  }

  const downloadReport = () => {
    setReportError('')
    if (
      result !== 'not-run' &&
      (!device.model.trim() ||
        !device.iosVersion.trim() ||
        !device.safariVersion.trim() ||
        !device.tester.trim())
    ) {
      setReportError(
        'pass/fail/blocked 결과에는 iPhone 모델, iOS, Safari 버전과 실행자 식별자가 필요합니다.',
      )
      return
    }

    const report = {
      schemaVersion: 1,
      commitSha: BUILD,
      appVersion: VERSION,
      executedAt: new Date().toISOString(),
      device: {
        iphoneModel: device.model.trim(),
        iosVersion: device.iosVersion.trim(),
        safariVersion: device.safariVersion.trim(),
        tester: device.tester.trim(),
        networkCondition: device.network.trim(),
        externalAudioInput: device.externalInput === 'yes',
      },
      pwa: { standalone, serviceWorker },
      scenario: { id: scenario, result },
      continuity: {
        state: continuity?.state ?? 'not-observed',
        gaps: continuity?.gaps ?? [],
        events,
      },
      errorCode: error ?? undefined,
      deidentifiedNotes: device.notes.trim(),
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], {
        type: 'application/json',
      }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `repord-${scenario.toLowerCase()}-${result}.json`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <main>
      <header>
        <p className="eyebrow">iPhone Safari feasibility harness</p>
        <h1>Repord M0</h1>
        <p>
          Build <code>{BUILD}</code> · v{VERSION} ·{' '}
          {standalone ? 'standalone PWA' : 'Safari browser tab'}
        </p>
        <p className="notice">
          이 하네스는 백그라운드 녹음을 보장하지 않습니다. 화면이 숨겨진 구간은
          증거가 없는 한 <code>continuity-unknown</code>으로 기록합니다.
        </p>
      </header>

      <section>
        <h2>환경</h2>
        <dl className="status-grid">
          <div><dt>getUserMedia</dt><dd>{mediaDevicesSupported ? 'supported' : 'unsupported'}</dd></div>
          <div><dt>MediaRecorder</dt><dd>{mediaRecorderSupported ? 'supported' : 'unsupported'}</dd></div>
          <div><dt>보안 컨텍스트</dt><dd>{secureContext ? 'HTTPS/localhost' : 'required'}</dd></div>
          <div><dt>마이크 권한</dt><dd>{permission}</dd></div>
          <div><dt>Service Worker</dt><dd>{serviceWorker}</dd></div>
        </dl>
        <details>
          <summary>브라우저 환경 문자열</summary>
          <code className="user-agent">{navigator.userAgent}</code>
        </details>
        <div className="form-grid">
          <label>iPhone 모델<input value={device.model} onChange={(event) => setDevice({ ...device, model: event.target.value })} placeholder="예: iPhone 13" /></label>
          <label>iOS 버전<input value={device.iosVersion} onChange={(event) => setDevice({ ...device, iosVersion: event.target.value })} placeholder="예: 18.5" /></label>
          <label>Safari 버전<input value={device.safariVersion} onChange={(event) => setDevice({ ...device, safariVersion: event.target.value })} /></label>
          <label>실행자 식별자<input value={device.tester} onChange={(event) => setDevice({ ...device, tester: event.target.value })} placeholder="실명 대신 별칭 가능" /></label>
          <label>네트워크 조건<input value={device.network} onChange={(event) => setDevice({ ...device, network: event.target.value })} placeholder="예: Wi-Fi" /></label>
          <label>외부 오디오 입력<select value={device.externalInput} onChange={(event) => setDevice({ ...device, externalInput: event.target.value as 'no' | 'yes' })}><option value="no">사용 안 함</option><option value="yes">사용함</option></select></label>
        </div>
      </section>

      <section>
        <h2>포그라운드 녹음</h2>
        <div className="actions">
          <button type="button" onClick={() => void start()} disabled={status !== 'idle' || !secureContext || !mediaDevicesSupported || !mediaRecorderSupported}>마이크 시작</button>
          <button type="button" className="secondary" onClick={stop} disabled={status !== 'recording'}>종료하고 마이크 해제</button>
        </div>
        <dl className="status-grid">
          <div><dt>상태</dt><dd>{status}</dd></div>
          <div><dt>경과 시간</dt><dd>{formatDuration(elapsed)}</dd></div>
          <div><dt>청크</dt><dd>{stats.chunks}</dd></div>
          <div><dt>집계 크기</dt><dd>{formatBytes(stats.bytes)}</dd></div>
          <div><dt>MIME</dt><dd>{snapshot.mimeType || 'not selected'}</dd></div>
          <div><dt>오디오 트랙</dt><dd>{snapshot.trackReadyState ?? 'none'} / muted {String(snapshot.trackMuted ?? false)}</dd></div>
        </dl>
        <p>오디오 Blob은 크기 집계 직후 폐기하며 저장·업로드·재생·다운로드하지 않습니다.</p>
        {error && <p role="alert" className="error">{ERROR_MESSAGES[error]} <code>{error}</code></p>}
      </section>

      <section>
        <h2>연속성: <strong>{continuity?.state ?? 'not-observed'}</strong></h2>
        {continuity?.state === 'continuity-unknown' && <p role="alert" className="warning">Safari가 관찰 불가능했던 구간의 녹음 완전성을 확인할 수 없습니다.</p>}
        {continuity?.gaps.map((gap, index) => <p role="alert" className="error" key={`${gap.startWallTimeMs}-${index}`}>확인된 공백 {new Date(gap.startWallTimeMs).toLocaleTimeString()}–{new Date(gap.endWallTimeMs).toLocaleTimeString()}: {gap.reason}</p>)}
        {events.length === 0 ? <p>녹음을 시작하면 관찰 이벤트가 여기에 기록됩니다.</p> : <ol className="event-log">{events.map((event, index) => <li key={`${event.monotonicTimeMs}-${index}`}><time>{new Date(event.wallTimeMs).toLocaleTimeString()}</time><span><code>{event.type}</code> {event.detail}</span></li>)}</ol>}
        <button type="button" className="secondary" onClick={clearLog} disabled={status !== 'idle'}>로그와 세션 통계 초기화</button>
      </section>

      <section>
        <h2>개인정보 없는 M0 리포트</h2>
        <div className="form-grid">
          <label>시나리오<select value={scenario} onChange={(event) => setScenario(event.target.value)}>{['IOS-01', 'IOS-02', 'IOS-03', 'IOS-04', 'IOS-05'].map((id) => <option key={id}>{id}</option>)}</select></label>
          <label>결과<select value={result} onChange={(event) => setResult(event.target.value as Result)}>{(['not-run', 'pass', 'fail', 'blocked'] as Result[]).map((value) => <option key={value}>{value}</option>)}</select></label>
        </div>
        <label>비식별 메모<textarea value={device.notes} onChange={(event) => setDevice({ ...device, notes: event.target.value })} rows={3} placeholder="음성 내용, 전사문, 이름이나 개인정보를 입력하지 마세요." /></label>
        {reportError && <p role="alert" className="error">{reportError}</p>}
        <button type="button" onClick={downloadReport}>JSON 리포트 다운로드</button>
      </section>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(<App />)
