# 플랜별 영구 QA 데모 — 로컬 구현 및 실행 전 검토

기준 main: `92dda5dbaf711896bc29e63475b50782b4607696`.
격리 개발 환경에서 구현·검증했다. 원격 migration, 계정 생성, 학생 코드 발급,
권한 부여, 결제, push, 배포는 실행하지 않았다. 첨부 비밀번호는 사용하지 않았다.

## 영구 데모 권한

`202610030002_permanent_demo_organizations.sql`은 명시적인
`entitlementMode: permanent_demo`와 `demo_org_` 전용 namespace를 사용한다.
신규 조직만 등록할 수 있고 기존 조직이나 계정을 자동 승격하거나 덮어쓰지 않는다.
Free/Pro/Academy 플랜은 `omr_demo_organizations` registry의 active 상태와 정확한
owner/member provenance를 검증한 뒤 해석한다. 일반 조직의 nominal plan은 Free로 유지하고
데모 조직에서만 전용 registry 플랜을 적용한다. 유료 pilot grant나 결제 상태를 만들지 않는다.

권한에는 만료일이 없다. NULL 만료는 명시적 데모 namespace와 mode가 모두 검증된 경우만
허용한다. 일반 유료 grant의 미래 만료일 검사는 그대로다. 교사 세션의 12시간 TTL,
학생 세션 정책, 재인증, generation 검사와 rate limit은 유지된다.
업로드 예약의 15분 TTL도 유지된다. 영구 세션/token을 발급하지 않는다.

운영자 전용 등록 RPC는 새 owner 또는 등록된 데모 조직의 teacher를 생성한다.
정확한 replay는 허용하며 이메일/조직 충돌, 일반 조직 편입, mode/role/plan 불일치는 거부한다.
등록·철회는 actor/reason 감사 기록을 남긴다. 철회 후 다음 보호 요청에서 로그인,
세션 검증, 유효 플랜과 mutation proof를 거부한다. 자동 재활성화나 데이터 삭제는 없다.

두 전용 테이블은 FORCE RLS이고 public/anon/authenticated/service_role 직접 CRUD를
모두 차단한다. operator 등록/철회 RPC만 service_role 실행을 허용하고 identity/plan helper는
private다. readiness와 boundary/rollback이 정확한 함수 해시·ACL을 다시 검증한다.

## 운영 적용 전 대상 검토

운영자는 별도 비공개 요청서에서 정확한 신규 조직명, owner/teacher 이메일과 표시 이름,
역할, 조직별 플랜을 검토한다. 교사 멤버는 등록된 조직 플랜을 상속한다.
학생 명단·반·초대 링크와 시작코드 발급은 별도 운영 절차다.
실제 계정 목록과 credential은 이 공개 문서에 포함하지 않는다.
무만료 데모 모드에는 expiresAt을 입력하지 않는다.

## 검토용 CLI와 실행 경계

owner 요청은 기존 필드에서 expiresAt을 제거하고 mode를 추가한다.
필드: organizationName, email, displayName, plan, actor, reason,
idempotencyKey, credentialStatePath, entitlementMode.
member 필드: organizationId, email, displayName, actor, reason,
idempotencyKey, credentialStatePath, memberRole, entitlementMode. memberRole은 teacher이고 member plan은 조직에서 상속한다.
mode는 `permanent_demo`, reason은 `qa_permanent_demo`다.
추가 credential/verifier 필드와 expiry/9999년 입력은 거부한다.

```sh
npm run ops:teacher:provision -- --request=/absolute/private/request.json --dry-run
```

dry-run은 credential 파일을 읽거나 생성하지 않고 비밀번호, lock, receipt, DB 연결을
만들지 않는다. 정규화한 대상과 credential 출력 경로에 묶인 reviewDigest만 반환한다.
apply에는 동일 요청의 `--approve-qa-demo=<reviewDigest>`가 필요하다.
이 확인값은 권한 인증을 대신하지 않는다. 실제 요청·권한 효과와 생성 credential의
보관·사용자 전달 방법을 검토하고 액션 시점 승인을 받은 뒤에만 적용한다.
현재는 합성 테스트에서만 apply 경로를 실행했다.

철회 요청은 organizationId, entitlementMode, actor, reason만 받는다.
mode permanent_demo, reason qa_demo_retired로 검토한 뒤 동일 digest를 승인한다.

```sh
node scripts/revoke-demo-organization.mjs --request=/absolute/private/revoke.json --dry-run
```

로그인 비밀번호 입력, OAuth/scope grant 승인은 사용자가 직접 한다.
학생 코드 발급과 원격 migration/계정 생성은 별도 구체적 승인 단계다.
배포 권한과 운영 적용은 별도 검토한다.

## Migration 및 rollback 효과

두 migration 적용 자체는 계정/조직/권한을 자동 생성하지 않는다.
첫 migration은 유한 추적 기간의 QA Free provenance 지원이다.
이번 무만료 구성은 두 번째 migration의 별도 registry/RPC 경로를 사용한다.
두 번째는 전용 테이블 두 개와 등록/철회 RPC, private helper를 추가하고
기존 identity/plan/mutation/asset 함수에 정확한 데모 검증 분기를 추가한다.
일반 유료 만료·billing 정책은 유지된다.

기존 boundary rollback은 schema downgrade가 아니다. 데모 테이블과 기존 데이터는
보존하고 FORCE RLS 및 private ACL을 재고정한다. 등록된 데모 권한 종료에는 별도의
철회 RPC 승인이 필요하다. 테이블/계정/credential 삭제는 이 작업에 포함되지 않는다.

## 검증

합성 CLI 테스트는 세 플랜과 무부작용 dry-run, expiry 거부, 정확한 review 승인,
충돌/replay, 철회 검토를 검사한다. gateway 테스트는 데모 namespace+mode의 정확한
NULL 만료 envelope만 허용하며 일반 유료 무만료는 거부한다.
교사 signed session은 데모에서도 12시간 후 만료된다.
`supabase/permanent-demo-assertions.sql`은 로컬 임시 PG17에서 owner/member 분리,
정확한 replay, 충돌/일반 조직 거부, paid mutation proof, 조직 격리,
철회 후 차단, audit 및 ACL을 transaction rollback으로 검증한다.
전체 runner는 migration, boundary, rollback, 재적용과 기존 paid/concurrency 검증을 수행한다.
