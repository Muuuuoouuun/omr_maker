# 프로덕션 준비 체크리스트 (Go-Live Gate)

이 문서는 실제 학생 데이터를 받기 전에 반드시 통과해야 하는 항목을 한곳에 모은 것입니다.
개별 절차의 상세는 각 원본 문서를 참조하고, 이 문서는 "무엇을 언제 확인하는가"의 단일 진입점 역할을 합니다.

> ⚠️ **현재 상태**: 프로덕션 배포는 되어 있으나, `schema.sql`의 업무 데이터 RLS 정책은
> 알파/로컬 테스트용으로 열려 있습니다. 아래 **1. Supabase RLS 핸드오프**를 완료하기 전까지는
> 실제(민감) 학생 데이터를 저장하지 마세요.

## 1. Supabase RLS 핸드오프 (실제 학생 데이터 전 필수)

`supabase/production-rls.sql`은 알파 공개 정책을 제거하고, 익명 테이블 접근을 회수하며,
RLS를 강제하고 Supabase Auth + `omr_organization_members`로 데이터를 게이트합니다.

- **선행 조건과 적용 순서**: [supabase/README.md](../supabase/README.md)의 `Production RLS Handoff` 7단계.
  (Auth 활성화 → `organization_id` 백필 → 멤버 행 생성 → 조직 생성/부트스트랩/감사로그를 서버·서비스롤로 이전 →
  `production-rls.sql` 실행 → Pro/Academy 서버측 권한 검사 → 보관 필기 데이터 보존 규칙.)
- **자동 적용을 하지 않는 이유**: 위 선행 조건(특히 Auth·org 백필)이 충족되지 않은 상태에서
  정책만 강제하면 정상 트래픽이 차단됩니다. 그래서 프로비저닝 스크립트는 이 파일을 자동 실행하지 않습니다.
- **자동 검증(회귀)**: `npm run test:supabase:live` 는 로컬 Postgres 컨테이너에
  `schema.sql` → 마이그레이션 → `production-rls.sql` → `live-test-assertions.sql`을 순서대로 적용해
  정책이 의도대로 동작하는지 검증합니다. 스키마/정책을 바꾸면 이 명령으로 먼저 회귀를 확인하세요.
- **적용 후**: 익명 quick-entry 학생은 publishable 키로 직접 쓸 수 없습니다.
  학생 Auth 계정 또는 서명된 과제 토큰이 준비될 때까지 학생 제출은 서버 경유로 유지하세요.

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
