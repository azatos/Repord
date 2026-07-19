# M1 세션 프로토콜 v1

`src/lib/session-protocol.ts`는 PWA와 향후 클라우드 API가 공유할 녹음 세션 및 청크 **메타데이터** 계약의 순수 TypeScript 기반이다. 이는 M1 기반 프로토콜 구현일 뿐 M1 완료나 실제 오디오 업로드 허용을 뜻하지 않는다.

## 신뢰 경계

클라이언트 청크 payload는 신뢰하지 않으며 `ownerId`를 포함하지 않는다. 서버 인증 계층이 별도의 trusted owner context를 제공하고, 내부 `SessionRecord`에만 owner ID를 저장한다. parser는 알 수 없는 필드를 거부하고 안정적인 비민감 오류 코드만 반환한다.

## 상태와 순서

상태는 `created → recording → finalizing → completed`이며, `created`·`recording`·`finalizing`에서는 `failed`로 갈 수 있다. `deleted`는 다른 모든 삭제되지 않은 상태에서 도달할 수 있는 terminal 상태다.

청크는 sequence 순서로 저장한다. 순서가 바뀐 도착은 허용하지만, 같은 chunk ID의 동일한 재시도만 idempotent duplicate로 취급한다. 같은 ID의 다른 metadata와 같은 sequence의 다른 ID는 거부한다. finalize는 0부터 선언한 마지막 sequence까지 모두 있어야 한다.

## 연속성과 수명주기

`observed-continuous`, `confirmed-gap`, `continuity-unknown`의 M0 의미를 보존한다. `confirmed-gap`에는 하나 이상의 검증된 gap interval이 필요하며 다른 상태에는 gap이 없어야 한다. `continuity-unknown`은 자동으로 연속 상태로 승격되지 않는다.

원시 데이터의 성공 처리 deadline은 `processedAt + min(configured retention, 24시간)`이고 실패·중단 deadline은 `lastActivityAt + min(configured retention, 24시간)`이다. 이 helper는 deadline만 계산하며 timer나 삭제를 실행하지 않는다.

## 아직 구현하지 않은 항목

실제 인증, 데이터베이스, 객체 저장소, signed URL, 업로드 endpoint, 삭제 job, Blob 처리, 오디오, 전사 및 AI 통합은 이 프로토콜에 포함하지 않는다.
