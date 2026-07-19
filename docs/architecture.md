# 아키텍처

## 개요

Repord는 iPhone Safari PWA와 클라우드 처리 서비스의 분리된 구조를 지향한다. 브라우저는 녹음·상태 표시·청크 업로드를 담당하고, 클라우드는 CPU/GPU 집약적인 음성 처리와 노트 생성을 담당한다.

```text
iPhone Safari PWA
  ├─ 녹음 세션 / foreground 상태 감시
  ├─ 오디오 청크 / 공백 메타데이터
  └─ 업로드 및 진행 상태 UI
             │
             ▼
Cloud API / job orchestration
  ├─ chunk storage + session metadata
  ├─ transcription adapter (initially mock)
  ├─ speaker filtering / noise suppression
  └─ lecture-note generator
             │
             ▼
structured lecture note + processing status
```

## 책임 경계

| 계층 | 책임 | 하지 않는 일 |
| --- | --- | --- |
| PWA | 권한 요청, 포그라운드 녹음, 청크화, 중단/공백 감지, 상태·결과 표시 | 무거운 ASR/화자 분리 실행, 비밀 키 보관 |
| 클라우드 API | 인증/세션 조정, 청크 수신, 처리 상태 제공 | iOS 백그라운드 녹음 보장 |
| 처리 워커 | 전사, 화자 분리, 허용 화자 우선순위, 노이즈 억제, 노트 생성 | 클라이언트 마이크 제어 |
| 저장소 | 최소한의 세션 메타데이터·업로드 청크·결과 보관 | Git에 실제 음성/개인정보 포함 |

## 녹음 세션과 공백 모델

클라이언트는 세션 ID, 순번, 녹음 시작/종료 시각을 가진 청크를 만든다. 페이지 가시성 변화, MediaStream 종료, 청크 타이머 지연 또는 연속 청크 시간 범위의 단절은 `recording_gap` 이벤트 후보가 된다. 후보에는 원인과 추정 시간 범위를 보관하고 UI에 경고한다. 이 표시는 중단을 완벽히 방지하는 장치가 아니라 데이터 품질을 투명하게 알리는 장치다.

## AI adapter 경계

처리 파이프라인은 전사·화자 필터·노트 생성 adapter 인터페이스 뒤에 둔다. 초기 구현은 결정적 mock adapter를 사용하여 네트워크 흐름, 상태 전이, 오류 처리와 UI를 검증한다. 실제 공급자 adapter는 이후 키 관리, 개인정보 정책, 비용·품질 평가를 충족한 뒤 추가한다.

## 보안과 운영 원칙

- API 키는 서버 측 비밀 관리에만 보관한다.
- 음성 원본과 전사문은 민감 데이터로 취급하고, 보관 기간·접근 통제·삭제 정책을 M5에서 확정한다.
- Linux에서 개발·검증할 수 있는 도구와 컨테이너 친화적 워크플로를 우선한다.
- 실제 iPhone Safari 권한·PWA 설치·백그라운드 동작은 자동 브라우저 테스트의 성공으로 대체하지 않는다.
