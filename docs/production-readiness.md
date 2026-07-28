# 프로덕션 준비 체크리스트 (Go-Live Gate)

이 문서는 실제 학생 데이터를 받기 전에 반드시 통과해야 하는 항목을 한곳에 모은 것입니다.
개별 절차의 상세는 각 원본 문서를 참조하고, 이 문서는 "무엇을 언제 확인하는가"의 단일 진입점 역할을 합니다.

> ⚠️ **현재 상태**: 프로덕션 배포는 되어 있으나, `schema.sql`의 업무 데이터 RLS 정책은
> 알파/로컬 테스트용으로 열려 있습니다. 아래 **1. Supabase 서버 전용 핸드오프**를 완료하기 전까지는
> 실제(민감) 학생 데이터를 저장하지 마세요.

## 1. Supabase 서버 전용 핸드오프 (실제 학생 데이터 전 필수)

`supabase/production-server-boundary.sql`은 canonical/PII 데이터 평면을
서버 전용으로 전환합니다. `public`, `anon`, `authenticated`의 테이블·시퀀스·함수 권한과
alpha/기존 브라우저 정책을 제거하고, 모든 `public.omr_*` 테이블에 RLS를 강제하면서
service-role RPC만 유지합니다. 기존 `production-rls.sql`은 직접 authenticated 브라우저
접근을 허용하는 이전 프로필이므로 새 컷오버에 적용하지 않습니다.

### 적용 순서

1. 쓰기를 유지보수 모드로 전환하고 복구 가능한 DB 스냅샷을 생성합니다.
2. 동일한 커밋의 `schema.sql`과 모든 `migrations`를 파일명 순으로 적용합니다.
3. 신뢰된 DB 소유자/service role로
   `select public.omr_assert_production_boundary_preflight_v1();`을 실행합니다.
   조직 null·고아·교차 조직·학생 credential 누락 중 하나라도 0이 아니면 중단합니다.
4. DB 소유자 권한으로 `supabase/production-server-boundary.sql`을 적용합니다. service-role
   API key만으로는 grant나 RLS를 바꿀 수 없습니다. 이 트랜잭션도 가장 먼저 같은 preflight
   assertion을 실행하므로 검사와 권한 회수 사이의 잘못된 수동 순서를 막습니다.
5. `schema.sql` → sorted `migrations` → `production-server-boundary.sql` →
   `live-test-assertions.sql` 순서를 실행하는 `npm run test:supabase:live`와
   CI의 blocking `supabase-live-contract` 작업을 통과시킵니다.
6. 릴리스 증거에 커밋 SHA, 정책 해시(SHA-256), CI 실행 URL, 대상 DB 프로젝트,
   실행자·시각, preflight 결과, anon/authenticated 공격 거부 결과를 기록합니다.
7. 같은 커밋의 서버 빌드를 배포하고 교사·학생 server action 여정을 확인한 뒤 쓰기를 재개합니다.

현재 public 앱 테이블은 `public.omr_*` 27개입니다. 로컬 verifier의 28번째 관계인
`storage.buckets`는 Supabase 관리 `storage` 스키마 카탈로그이므로 이 프로필이 FORCE RLS를
재작성하지 않습니다. 대신 라이브 검증에서 `omr-private-assets` bucket의 `public = false`를
별도로 확인하며, 새 public OMR 테이블이 생기면 동적 catalog assertion이 누락을 차단합니다.

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

## 4. 배포 참고

- 프리뷰 배포: `vercel deploy` (기본).
- 프로덕션: 검증한 프리뷰 빌드를 `vercel promote <preview-url>`로 승격하거나 `vercel deploy --prod`.
  승격은 재빌드 없이 동일 빌드를 올리므로 프리뷰에서 확인한 코드와 100% 동일합니다.
