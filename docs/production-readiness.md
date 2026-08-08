# 프로덕션 준비 체크리스트 (Go-Live Gate)

이 문서는 실제 학생 데이터를 받기 전에 반드시 통과해야 하는 항목을 한곳에 모은 것입니다.
개별 절차의 상세는 각 원본 문서를 참조하고, 이 문서는 "무엇을 언제 확인하는가"의 단일 진입점 역할을 합니다.

> ⚠️ **현재 상태**: 프로덕션 배포는 되어 있으나, `schema.sql`의 업무 데이터 RLS 정책은
> 알파/로컬 테스트용으로 열려 있습니다. 아래 **1. Supabase 서버 전용 핸드오프**를 완료하기 전까지는
> 실제(민감) 학생 데이터를 저장하지 마세요. readiness 오류에는 고정된 검사 이름만 기록하고
> preflight sample, 학생 이름, row id를 포함하지 않습니다.

## 1. Supabase 서버 전용 핸드오프 (실제 학생 데이터 전 필수)

`supabase/production-server-boundary.sql`은 canonical/PII 데이터 평면을
서버 전용으로 전환합니다. `public`, `anon`, `authenticated`의 테이블·시퀀스·함수 권한과
alpha/기존 브라우저 정책을 제거하고, 모든 `public.omr_*` 테이블에 RLS를 강제하면서
service-role RPC만 유지합니다. 기존 `production-rls.sql`은 직접 authenticated 브라우저
접근을 허용하는 이전 프로필이므로 새 컷오버에 적용하지 않습니다.

### 적용 순서

1. 쓰기를 유지보수 모드로 전환하고 복구 가능한 DB 스냅샷을 생성합니다.
2. 단일 migration owner인 `postgres`로 접속해 동일한 커밋의 `schema.sql`과 모든
   `migrations`를 파일명 순으로 적용합니다. PostgreSQL default privilege는 소유자별이므로
   실행자를 섞지 않습니다. canonical 테이블 manifest는
   `schema.sql baseline + sorted migrations = final schema` 규칙으로 계산합니다.
3. 같은 `postgres` 세션에서
   `select public.omr_assert_production_boundary_preflight_v1();`을 실행합니다.
   조직 null·고아·교차 조직·학생 credential 누락 중 하나라도 0이 아니면 중단합니다.
4. 계속 `postgres`로 `supabase/production-server-boundary.sql`을 적용합니다. 다른
   `current_user`는 프로필이 거부하며, service-role API key만으로는 grant·RLS·`postgres`
   default ACL을 바꿀 수 없습니다. 이 트랜잭션도 가장 먼저 같은 preflight assertion을
   실행하므로 검사와 권한 회수 사이의 잘못된 수동 순서를 막습니다.
5. `schema.sql` → sorted `migrations` → `production-server-boundary.sql` →
   `live-test-assertions.sql` 순서를 실행하는 `npm run test:supabase:live`와
   CI의 blocking `supabase-live-contract` 작업을 통과시킵니다.
   service-role 전용 readiness probe 버전은 `202608080005`이어야 합니다.
   브라우저 schema/table/column/sequence/function 실효 권한과 PostgreSQL 17
   `MAINTAIN` 차단, 정확한 canonical 39개 allowlist의 ENABLE+FORCE RLS, public
   정책 0개, 조직 preflight 4개 count 0, 정확한 목적별 교사 RPC signature,
   추가 overload 없는 정확한 서버 gateway 17개 signature, 직접 업로드 intent와
   lease 기반 Storage 정리 outbox
   수명주기, 모든 legacy
   broad-RPC overload 제거, service-role 권한, private Storage owner·제한
   정책과 명단 원자 조회·revision CAS(`rosterSnapshotCasReady`), 학생 세션
   변경 CAS(`attemptMutationCasReady`), 제출 세션 안전 시험 삭제
   (`examDeleteSessionSafe`), 학생 질문 원자 저장
   (`studentQuestionAtomicReady`), 브라우저·service-role 직접 테이블 접근 없이
   해시만 저장하는 교사 가입·이메일 확인·비밀번호 복구 RPC
   (`teacherAccountLifecycleReady`)와 service-role 전용 초기 운영 부하 제어
   (`initialOperationsLoadControlReady`), secure submission replay marker와 브라우저가
   조직 ID를 받지 않는 시험별 opaque 초대 경계(`examEntryInvitesReady`)를 모두
   `true`로 반환해야 합니다. 키 누락·이전 또는 공백이
   붙은 버전·`false`·배열 응답은 모두 배포 불가입니다. 교사 설정 화면의
   readiness Server Action은 동일 출처와 유효한 서명 세션을 먼저 확인하고
   공개 쇼케이스 identity를 차단한 뒤에만 service-role probe를 호출합니다.
   속도 제한은 서명된 actor를 기준으로 하며 만료 엔트리를 정리하고 저장소
   최대 크기를 고정합니다. 이 제한은 process-local 방어 심층 계층이므로
   다중 instance 운영에서는 upstream 공유 rate limit도 함께 적용합니다.
   교사 계정 이메일은 HTTPS delivery webhook URL과 공백 없는 32~512바이트
   HMAC secret을 모두 설정해야 합니다. 수신기는 `x-omr-delivery-timestamp`와
   `<timestamp>.<raw JSON body>`의 HMAC-SHA256을 검증한 뒤 메일을 보내야 하며,
   응답이 제한 시간 안에 JSON `{ "accepted": true }`를 반환하지 않으면 요청은
   실패합니다. 실제 전달 실패·재시도 증거를 확인하기 전에는 가입 확인과
   비밀번호 복구가 준비됐다고 표시하지 않습니다.
6. 릴리스 증거에 커밋 SHA, 정책 해시(SHA-256), CI 실행 URL, 대상 DB 프로젝트,
   실행자·시각, preflight 결과, anon/authenticated 공격 거부 결과를 기록합니다.
7. 같은 커밋의 서버 빌드를 배포하고 교사·학생 server action 여정을 확인한 뒤 쓰기를 재개합니다.

호스팅 상태는 수동 `curl`만으로 승인하지 않습니다. GitHub의 `Production readiness` workflow를
production environment 승인 뒤 실행하고, 배포 SHA를 입력합니다. 이 작업은 `/healthz` build,
`/readyz`의 exact version·DB·관측성·전달 설정, 대상 Supabase service-role readiness RPC,
anon/authenticated canonical table 직접 접근 거부를 함께 검사합니다. credential이 비어 있거나
하나라도 추정할 수 없으면 `unverified`와 exit 1로 끝납니다. 생성된 artifact는
[`operations/release-evidence-template.md`](./operations/release-evidence-template.md)에 연결합니다.

DB와 private Storage 복원 승인은 [`operations/backup-restore-runbook.md`](./operations/backup-restore-runbook.md)를
따릅니다. source와 production을 모두 피한 격리 staging에서 exact table count와 모든 object 본문
SHA-256을 비교하고, 선언한 RPO/RTO 안에서 `verified` 증거가 생성되기 전에는 복구 가능성을 통과로
기록하지 않습니다.

교사 PDF는 파일 본문을 Next Server Action에 싣지 않습니다. 6 MiB 이하는 signed
upload, 초과분은 6 MiB chunk의 signed TUS로 브라우저에서 private Storage에 직접
전송합니다. finalize는 Storage `info`의 크기·content type·업로드 metadata와
`Range: bytes=0-4`의 `%PDF-` magic을 확인하며 전체 파일을 서버로 다시 받지
않습니다. 이때 SHA-256은 브라우저 선언과 Storage metadata의 일치성 검사이지,
서버가 파일 전체를 다시 해시한 독립적인 무결성 증명은 아닙니다. 업로드 admission은
24시간 기준 actor 20개/1 GiB, 조직 100개/5 GiB와 전역 100개/5 GiB를 트랜잭션 잠금으로
직렬화합니다. 만료 `pending`/`uploaded` intent, canonical 시험에서 참조되지 않은 만료
`finalized` intent와 교체·삭제된 원격 자산 경로는 service-role 전용
정리 outbox에 먼저 보존됩니다. claim은 호출당 1~100개, lease는 15~900초로 제한되고
실패는 최대 10회까지 지수 backoff 후 `dead`로 격리됩니다. 작업자는 Storage object
삭제가 성공한 뒤에만 ack해야 합니다. readiness는 이 테이블·인덱스·RPC 권한을
검증하고 아직 outbox에 materialize되지 않은 정리 대상까지 합산해 100개 이하이며
`dead`가 0개인지 확인합니다. canonical 저장은 intent 행을 정리 sweep과 같은 순서로
잠가 이미 만료·queue된 자산의 부활을 거부합니다. 운영 환경의 cron 등록 여부는
readiness가 주장하지 않으므로, 별도 스케줄러를 반드시 구성하고 `dead` 항목을 알림
대상으로 삼아야 합니다.

현재 public 앱 테이블은 canonical 39개 `public.omr_*` 테이블입니다. 별도의 Supabase 관리 관계인
`storage.objects`와 `storage.buckets`는
[Supabase 플랫폼 권한 문서](https://supabase.com/docs/guides/platform/permissions)의
요구대로 `supabase_storage_admin` 소유권을 유지합니다. 프로필은 managed table ACL이나
소유권을 변경하지 않습니다. 대신 `postgres`가 해당 역할을 `SET ROLE`할 수 있는지
fail-closed로 검사하고, Storage 정책 단계에서만 그 owner로 전환했다가 public 프로필을
계속하기 전에 `RESET ROLE`합니다.

`omr-private-assets`에는 `anon`/`authenticated`의 target row만 거부하는
`AS RESTRICTIVE` 제한 정책을 `storage.objects`와 `storage.buckets`에 설치합니다.
다른 bucket에서는 조건이 true이므로 기존 permissive 정책이 그대로 작동하며 전역 브라우저
Storage API를 중단하지 않습니다. service role은 RLS를 우회하는 서버 전용 경로입니다.
이는 Supabase가 안내하는
[Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
경로입니다. 정책 외 managed Storage metadata는
[Storage schema 가이드](https://supabase.com/docs/guides/storage/schema/design)처럼
read-only로 취급합니다. 프로필은 exact repository-owned 정책 이름만 교체하고 unrelated
정책을 삭제하지 않습니다. 라이브 검증은 owner/policy catalog, actual
anon/authenticated target CRUD 거부, unrelated bucket 접근 유지, service-role target
CRUD 성공을 모두 확인합니다.

### 롤백

브라우저 canonical CRUD를 다시 열어 롤백하지 않습니다. 먼저 앱 쓰기를 중단하고 서버 배포를
되돌립니다. DB 권한 완화는 보안 책임자의 별도 승인, 명시적 검토 SQL, 새 라이브 검증 로그가
있을 때만 허용하며 alpha 정책이나 `production-rls.sql`을 긴급 롤백으로 사용하지 않습니다.

## 2. Vercel 프리뷰 배포 보호(SSO)와 QA 우회

프리뷰 배포(`vercel deploy`)는 기본적으로 Deployment Protection(SSO)이 걸려 있어,
링크를 열면 Vercel 로그인으로 리다이렉트됩니다. 이는 정상 동작입니다.

- **사람이 확인**: 본인 Vercel 계정으로 로그인하면 프리뷰를 볼 수 있습니다.
- **자동화(e2e/QA)가 프리뷰에 접근**해야 하면, 프로젝트 설정에서
  Protection Bypass for Automation 시크릿을 발급하고, 요청 헤더
  `x-vercel-protection-bypass: <secret>` (또는 쿼리 `?x-vercel-protection-bypass=<secret>`)로 우회합니다.
  시크릿은 CI 환경변수로만 주입하고 저장소에 커밋하지 마세요.
- **프로덕션 도메인**(`omr-maker-eight.vercel.app` 등)은 SSO 보호 없이 바로 접근됩니다.

## 3. 환경 변수 위생

- 앱 코드가 사용하는 Supabase 변수: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`(또는 `NEXT_PUBLIC_SUPABASE_ANON_KEY`),
  `SUPABASE_SERVICE_ROLE_KEY`(또는 `OMR_SUPABASE_SERVICE_ROLE_KEY`).
  서비스 롤 키는 서버 전용이며 절대 `NEXT_PUBLIC_` 접두사를 붙이지 마세요.
- `.env.local`의 `SUPABSE_ACCESS_TOKEN`(SUPABASE 오타)은 앱 코드가 읽지 않는 미사용 변수입니다.
  Supabase CLI 로그인용으로 두려면 정식 이름 `SUPABASE_ACCESS_TOKEN`으로 정정하고, 아니면 삭제하세요.
- 배포 권한이 있는 액세스 토큰이 로그·명령 출력에 노출됐다면 즉시 폐기·재발급하세요.

### 운영 상태 확인

- `OMR_READINESS_TOKEN`에는 외부에 공개하지 않는 충분히 긴 임의 값을 설정합니다.
  `GET /api/healthz`는 로드밸런서용 공개 생존 확인이며 빌드 식별자와 시각만 반환합니다.
- `GET /api/readyz`는 `Authorization: Bearer <OMR_READINESS_TOKEN>`이 정확히 일치할 때만
  service-role DB readiness와 중앙 운영 이벤트 sink의 부작용 없는 인증 `HEAD` probe를 실행합니다.
  토큰이 없거나 틀리면 `401`, Supabase 설정 누락·제한 시간 초과·DB 경계 검사 실패는 `503`입니다.
  DB는 준비됐지만 sink가 누락되거나 도달 불가하면 앱을 함께 내리지 않고 `200`과
  `status=degraded`, `observability=<원인>`을 반환합니다. 배포 승인은 반드시
  `status=ready`, `observability=ready`를 모두 확인하고, 운영 모니터는 degraded를 경보로 처리합니다.
- 중앙 수집기는 `OMR_OPERATIONAL_SINK_URL`의 HTTPS endpoint와 공백 없는 32~512자
  `OMR_OPERATIONAL_SINK_TOKEN`으로 설정합니다. endpoint는 `Authorization: Bearer ...`가 포함된
  요청을 받고 `x-omr-event-id`를 멱등 키로 중복 제거해야 합니다. 애플리케이션은 일시적인
  408/425/429/5xx 또는 전송 오류에 동일 이벤트 ID로 한 번 재시도합니다.
  readiness용 `HEAD`와 `application/json` 이벤트 `POST`를 받고 2xx를 반환해야 합니다. 앱은
  redirect를 따라가지 않으며 원본 오류, 학생 식별자, 쿠키, 토큰과 payload를 보내지 않습니다.
- 자산 GC cron은 매 실행 결과를 `omr.job_heartbeat`로 중앙 수집기에 전달합니다. 실제 정리 실패가
  하나라도 있으면 `503`이고, 정리는 깨끗하지만 heartbeat 전달만 실패하면 작업 결과는 `200`을
  유지하되 `observability=degraded`를 반환합니다. 운영 수집기에서는 heartbeat 부재와
  degraded 응답을 별도 경보 조건으로 설정합니다.
- 두 응답 모두 `Cache-Control: no-store`입니다. 준비 상태 응답과 오류 로그에는 원본 DB 오류,
  학생 이름·이메일, 쿠키, 토큰, 답안/PDF payload를 넣지 않습니다. `OMR_READINESS_TIMEOUT_MS`는
  별도 probe 제한 시간이며 100~10,000ms 범위로 제한됩니다(기본 5,000ms).
- Before backup and cutover, pause Vercel asset-GC cron/scheduler triggers. 이어서
  target-bound `asset-gc-paused:<production-host>` 확인값을 protected workflow에 입력합니다.
  애플리케이션 writes는 계속 paused 상태로 둘 수 있으며, qualification 중에는 verifier의
  one-shot 요청만 cleanup claim을 실행할 수 있도록 해당 요청의 GC claims만 resumed 상태로
  전환합니다. Only the verifier one-shot may claim cleanup work during qualification, and operators
  resume cron/scheduler only after the deployment is ready. 검증된 SHA/attestation과 공개 health를
  먼저 확인하고, protected `OMR_ASSET_GC_CRON_SECRET`으로 자산 GC를 한 번 실행한 뒤에만
  `/api/readyz`를 확인합니다. 정리 실패, durable dead backlog, 상태 저장 실패는 즉시 배포를
  중단합니다. one-shot 응답은 positive `runSequence`, 최소 한 번의 `claimAttempts`,
  `claimed=deleted+failed`, batch capacity 일치, `applied=true`, `superseded=false`,
  `durableStatus=healthy`, `deadCount=0`를 모두 증명해야 합니다. GC가 durable healthy이고
  중앙 sink 전달만 실패한 `200 observability=degraded`는
  이 단계에서 허용하지만, 이어지는 `/api/readyz`는 반드시 `observability=ready`여야 합니다.
  성공한 readiness 이후에만 정상 Vercel cron/scheduler를 resume합니다. 결과에는 커밋 SHA,
  시각, target-bound pause 확인값의 hash만 남깁니다. 확인 원문과 cron secret은 로그나 evidence
  artifact에 기록하지 않습니다.

```sh
curl -i https://<deployment>/api/healthz
curl -i -H "Authorization: Bearer $OMR_ASSET_GC_CRON_SECRET" https://<deployment>/api/internal/asset-gc
curl -i -H "Authorization: Bearer $OMR_READINESS_TOKEN" https://<deployment>/api/readyz
```

## 4. 배포 참고

- 프리뷰 배포: `vercel deploy` (기본).
- 프로덕션: 검증한 프리뷰 빌드를 `vercel promote <preview-url>`로 승격하거나 `vercel deploy --prod`.
  승격은 재빌드 없이 동일 빌드를 올리므로 프리뷰에서 확인한 코드와 100% 동일합니다.
- production build의 `postbuild`는 홈, 학생 대시보드·응시·리뷰, 시험 생성,
  강사 대시보드·라이브·명단 라우트의 first-load JS raw/gzip 예산을 검사합니다.
  초기 운영 검증은 배포 URL의 immutable 정적 JS가 실제 `Content-Encoding`으로 압축되는지도 확인합니다.

### 초기 100명 부하의 RSS 증거

Vercel에서는 라우트가 서로 다른 함수 번들/프로세스로 실행될 수 있으므로 별도 RSS API의
`process.memoryUsage()`를 workload 함수의 메모리로 간주하지 않습니다. 부하 드라이버는 실제
`operations/[operation]` 응답의 boot-instance ID, RSS, 서버 시각을 원시 요청과 함께 수집하고,
주기 probe도 같은 dynamic operations route의 `instance-rss-read`로 보냅니다. 이 probe는 DB
gateway와 workload request 목록을 거치지 않으므로 RPC 호출 수와 latency percentile을 오염시키지
않습니다. 실제 workload를 처리한 모든 instance에 대해 ramp 전 baseline, steady-window 표본,
cooldown 종료 표본이 같은 boot ID로 연결될 때만 RSS gate를 평가합니다. Vercel은 특정 warm
instance로의 affinity를 보장하지 않으므로 bounded probe가 모든 instance를 다시 만나지 못하면
성공으로 추정하지 않고 `memory_instrumentation`/`unverified`로 종료합니다. 안정적인 반복 통과가
필요하면 provider-level instance/container memory telemetry를 연결해야 합니다.
