# 프로덕션 릴리스 증거

이 문서는 한 번의 프로덕션 승인을 위한 기록입니다. 빈 항목, `unverified`, 수동 추정은 승인 증거가 아닙니다.

## 변경 식별

- 릴리스 일시(UTC):
- 승인자:
- 배포 Git SHA(40자):
- GitHub Actions 실행 URL:
- `production-readiness-<SHA>` artifact SHA-256:
- production host:
- 대상 Supabase project ref SHA-256(원문 ref 금지):
- production boundary SQL SHA-256:

## 자동 검증 결과

- `ops:verify:production` 상태: `verified` / `unverified`
- `/api/healthz` build와 배포 SHA 일치: 예 / 아니오
- `/api/readyz` 상태: `ready` / 그 외
- readiness version: `202608080005` / 그 외
- scheduler pause confirmation hash (target-bound human attestation, not machine proof; 원문/secret 제외):
- observability: `ready` / 그 외
- teacher account delivery probe: 통과 / 실패
- anon canonical table 직접 읽기: 거부 / 성공
- authenticated canonical table 직접 읽기: 거부 / 성공
- service-role readiness RPC: 통과 / 실패

## 외부 합성 경보 전달 훈련

실제 외부 경보 시스템에 연결된 어댑터로만 실행합니다. 로컬·staging 모의 응답, credential 누락,
`unverified` 종료는 통과나 생략으로 기록할 수 없습니다. 증거는 릴리스 승인 시점 기준 30일 이내여야 합니다.

정확한 실행 명령(출력은 기존에 존재하지 않는 절대 경로이며, 부모 디렉터리는 group/other 권한이 없어야 함):

```sh
npm run ops:alert:verify -- --output /absolute/private/path/operational-alert-evidence.json
```

정확한 환경 계약:

| 이름 | 필수 값과 경계 |
| --- | --- |
| `OMR_BUILD_SHA` | 배포와 일치하는 소문자 40자리 hex Git SHA |
| `OMR_ALERT_SINK_URL` | 합성 이벤트를 받는 최대 2048자 외부 비로컬 HTTPS endpoint |
| `OMR_ALERT_RECEIPT_URL` | 동일 event ID의 sink/alert 수신 시각을 반환하는 최대 2048자 외부 비로컬 HTTPS endpoint |
| `OMR_ALERT_ACK_URL` | 동일 event ID의 acknowledgement 시각을 반환하는 최대 2048자 외부 비로컬 HTTPS endpoint |
| `OMR_ALERT_RESOLVE_URL` | 동일 event ID의 resolution 시각을 반환하는 최대 2048자 외부 비로컬 HTTPS endpoint |
| `OMR_ALERT_SINK_TOKEN` | 공백 없는 32–512자 bearer credential |
| `OMR_ALERT_RECEIPT_TOKEN` | 공백 없는 32–512자 bearer credential |
| `OMR_ALERT_ACK_TOKEN` | 공백 없는 32–512자 bearer credential |
| `OMR_ALERT_RESOLVE_TOKEN` | 공백 없는 32–512자 bearer credential |
| `OMR_ALERT_POLL_INTERVAL_MS` | 정수 250–5000 |
| `OMR_ALERT_DEADLINE_MS` | 정수 1000–120000, poll interval 이상 |
| `OMR_ALERT_REQUEST_TIMEOUT_MS` | 정수 1000–10000 |

네 credential은 권한 분리를 위해 모두 달라야 합니다. URL은 userinfo·fragment, localhost/private IP,
예약된 `.test`/`.invalid`/`.example` 또는 `example.com`/`.net`/`.org` host를 포함할 수 없습니다.
CLI 인자는 위의 `--output <absolute-new-path>` 한 쌍만 허용합니다.

Provider-neutral HTTP 계약:

- emit: sink에 `POST`, bearer와 `x-omr-event-id`; body는 `eventId`, `event`, `severity`, `buildSha`, `emittedAt`, `correlation`만 포함하며 `200`/`201`/`202`/`204`만 성공입니다.
- receipt: receipt endpoint에 `GET`; `200` body는 정확히 `eventId`, `sinkReceivedAt`, `alertReceivedAt`이며 `202`/`204`/`404`만 deadline 전 transient 상태입니다.
- acknowledge: acknowledgement endpoint에 `{ "eventId": "..." }`를 `POST`; `200` body는 정확히 `eventId`, `acknowledgedAt`입니다.
- resolve: resolution endpoint에 `{ "eventId": "..." }`를 `POST`; `200` body는 정확히 `eventId`, `resolvedAt`입니다.
- 모든 응답은 redirect 없이 요청 timeout 안에 32 KiB 이하여야 합니다. 모든 시각은 UTC millisecond ISO-8601이며 emit ≤ sink ≤ alert ≤ acknowledge ≤ resolve 순서여야 합니다.

- `ops:alert:verify` 상태: `verified` / `unverified` (외부 시스템 실행만 `verified` 가능)
- 증거 artifact 절대 경로:
- 증거 `eventId`:
- 증거 `buildSha`와 배포 SHA 일치: 예 / 아니오
- 증거 `resolvedAt`(UTC):
- 승인 시점 기준 freshness 30일 이내: 예 / 아니오
- artifact `integrity` 재계산 일치: 예 / 아니오

성공 artifact는 새 `0600` JSON 파일이며 정확히 `status`, `schemaVersion`, `buildSha`, `eventId`,
`emittedAt`, `sinkReceivedAt`, `alertReceivedAt`, `acknowledgedAt`, `resolvedAt`,
`endpointOriginHashes`, `integrity`만 포함합니다. URL, token, response body, 학생 식별자,
provider 자유 형식 데이터는 artifact나 릴리스 기록에 복사하지 않습니다.
`integrity` 검산은 `integrity` 필드를 제외하고 모든 object key를 재귀적으로 사전순 정렬한 뒤,
공백 없는 UTF-8 JSON으로 직렬화하여 SHA-256을 계산하고 `sha256:<lowercase-hex>`로 표기합니다.

## 변경형 여정과 운영 증거

- 강사 생성→배포→학생 제출→강사 피드백 반환 증거 위치:
- asset cleanup 최근 heartbeat와 dead queue 0 증거:
- 100명 staging 부하 evidence bundle 위치:
- 최근 staging 복원 훈련 evidence 위치:
- 실제 Android/iOS 다중 기기 증거 위치:

## 승인 판정

- 최종 판정: GO / NO-GO
- 남은 예외와 만료 시각:
- 롤백 담당자와 기준:

`verified` JSON에는 토큰, URL query, 학생 정보, row ID, Storage object path를 복사하지 않습니다.
