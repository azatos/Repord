# Repord

Repord는 iPhone Safari에서 설치해 사용하는 강의 녹음 및 강의노트 생성 PWA를 위한 저장소다. 수업 중에는 화면을 켜 둔 포그라운드 녹음을 기본으로 하며, 서버에서 전사·화자 필터링·노트 생성을 처리한다.

> M0 iPhone Safari 가능성 검증을 완료했다. 현재 다음 단계는 M1 녹음 세션·청크 업로드와 개인정보·수명주기 게이트 구현이다. FastAPI, 데이터베이스, 실제 오디오 업로드, 음성인식, AI SDK 및 실제 AI API 연동은 아직 포함하지 않는다.

## 제품 원칙

- iPhone Safari에서 설치 가능한 PWA를 우선 검증한다.
- iOS Safari의 백그라운드 마이크 제약을 제품 동작과 안내에 명시한다. 관찰이 중단되면 녹음 연속성을 주장하지 않고 `continuity-unknown`으로 경고한다.
- 확인된 녹음 공백(`confirmed-gap`)에는 경고와 추정 시간 범위를 표시하며, 관찰 가능한 연속 기록만 `observed-continuous`로 표시한다.
- 초기 통합은 실제 AI API 대신 mock adapter로 검증한다.
- 무거운 전사와 화자 분리 처리는 클라우드에서 실행한다.
- 실제 오디오는 인증된 소유자 범위 접근, 비공개 저장소, 만료 및 연쇄 삭제가 구현되기 전에는 업로드하지 않는다. 그 전의 업로드·통합 테스트는 합성 또는 익명화된 테스트 오디오만 사용한다.
- Apple Developer 구독이나 Apple Silicon/macOS 로컬 환경을 요구하지 않는다.

## 문서 안내

- [제품 요구사항](docs/product-requirements.md): 사용자 흐름, 범위, 수용 기준
- [아키텍처](docs/architecture.md): PWA·클라우드 처리 경계와 mock adapter
- [로드맵](docs/roadmap.md): M0–M5 단계와 완료 기준
- [iPhone Safari 테스트 계획](docs/iphone-safari-test-plan.md): 실제 기기 검증 절차와 결과
- [ADR](docs/adr): PWA 우선, 클라우드 AI, iOS 제약 의사결정 기록
- [ADR 0004: 민감 오디오 수명주기](docs/adr/0004-sensitive-audio-lifecycle.md): 실제 오디오 업로드 전 접근 제어·삭제·보존 기준

## 개발 방식

모든 작업은 하나의 GitHub Issue와 하나의 PR로 진행하며 `main`에 직접 커밋하지 않는다. 세부 규칙은 [AGENTS.md](AGENTS.md)를 따른다.

## M0 harness 개발 및 검증

지원되는 Node.js 22 또는 24 LTS를 사용한다. 기본 개발 버전은 [.nvmrc](.nvmrc)의 Node.js 22이며 다음 명령으로 재현한다.

```bash
npm ci
npm run dev
npm run lint
npm run typecheck
npm test
npm run verify:pwa
npm run build
```

로컬 개발 서버는 마이크 보안 컨텍스트를 대체하지 않는다. 실제 iPhone에서는 HTTPS 배포 주소를 사용한다.

GitHub Pages를 사용하려면 저장소의 **Settings → Pages → Build and deployment → Source**를 `GitHub Actions`로 설정한다. `main` push 또는 `Deploy Pages` workflow의 수동 실행은 `VITE_BASE_PATH=/Repord/`로 빌드한 `dist`만 배포한다. 비공개 저장소에서 Pages를 사용할 수 없는 요금제라면 저장소를 공개로 바꾸지 말고 배포를 `blocked`로 기록한다.

2026-07-19에 설치형 iPhone Safari PWA에서 IOS-01부터 IOS-05까지 실행해 모두 `pass`로 판정했다. 자세한 기기 환경과 결과는 [iPhone Safari 테스트 계획](docs/iphone-safari-test-plan.md)에 기록한다. IOS-04와 IOS-05의 통과는 앱 전환·화면 잠금 뒤 관찰 불가능한 구간을 `continuity-unknown`으로 정확히 표시했다는 의미이며, 백그라운드 또는 잠금 화면 녹음을 보장하지 않는다. M1의 IOS-06과 M2의 IOS-07은 아직 `not-run`이다.

이 하네스는 생성된 오디오 Blob을 크기 집계 직후 폐기하며 업로드·저장·재생·다운로드하지 않는다. 실제 음성, 전사문, 사용자 식별정보가 포함된 리포트나 증적은 저장소에 커밋하지 않는다.
