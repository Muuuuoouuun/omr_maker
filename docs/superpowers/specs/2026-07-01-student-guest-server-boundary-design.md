# 학생/게스트 서버 신뢰 경계 (슬라이스 A) — 설계문서

- **작성일**: 2026-07-01
- **상태**: 설계 확정(구현계획 대기)
- **브랜치**: premier0.1
- **관련 문서**: [`docs/system-review-2026-07.md`](../../system-review-2026-07.md) (P0 로드맵), [`supabase/production-rls.sql`](../../../supabase/production-rls.sql), 메모 `omr-server-trust-boundary` / `omr-guest-identity-collapse`

---

## 1. 배경 · 문제

premier0.1의 **단일 최대 병목 = 서버 신뢰 경계 부재**. 학생/게스트 플로우에서 구체적으로 다음으로 발현한다(2026-07-01 코드 확인):

1. **통합 계정** — 교사 세션이 없는 모든 사용자가 `readActiveWorkspaceContext()`([`src/lib/workspaceContext.ts:162-175`](../../../src/lib/workspaceContext.ts))에서 `organization_id="default"` 한 통으로 수렴. 모든 원격 read가 이 org로 필터([`omrPersistence.ts:1119-1146`](../../../src/lib/omrPersistence.ts)). 게스트를 갈라주는 유일한 선은 클라이언트 필터 `attemptBelongsToSession()`([`storage.ts:219-221`](../../../src/utils/storage.ts)).
2. **정답 유출** — solve 페이지가 정답 포함 full 시험을 클라로 로드([`solve/[id]/page.tsx:837-848`](../../../src/app/solve/[id]/page.tsx)). `Question.answer`, `answerKeyPdf`/`Ref`가 그대로 전송.
3. **점수 위조** — 채점이 클라 `gradeAttempt`([`solve/[id]/page.tsx:1147`](../../../src/app/solve/[id]/page.tsx))이고, 제출이 publishable(anon) 키로 `omr_attempts` 직접 upsert. 임의 점수 저장 가능.
4. **PIN 우회** — `accessConfig.pin`이 클라로 전송되고 `verifyExamPin`이 클라 대조([`solve/[id]/page.tsx:1348`](../../../src/app/solve/[id]/page.tsx)).
5. **PII 무인증 노출** — alpha RLS 전 테이블 `using(true) with check(true)`([`supabase/schema.sql:837-873`](../../../supabase/schema.sql)) + anon 키 → default org 전체(전 학생 이름·점수·문항결과) 조회 가능.

Supabase는 **라이브(다기기 동기화 실사용)**, 서버 `SUPABASE_SERVICE_ROLE_KEY` 주입 및 SQL 적용 가능 → 위 노출은 지금 실재하며 서버 중개 정공법이 가용하다.

## 2. 목표 · 비목표

### 슬라이스 A 목표
- 학생/게스트 **데이터 경로(정답 조회·채점·제출·본인조회)를 서버 경계로 이관**.
- 서버 발급 신원으로 **제출 소유자·`organization_id`를 서버가 강제**.
- solve-load payload에서 **정답·정답PDF·PIN 제거**, **PIN 검증 서버화**.
- 게스트 격리를 서버 소유 신원으로 확립.

### 비목표(명시적 이월)
- **서버 명단/시작코드 검증(학생 사칭 완전차단, 서버 TOFU 코드 레지스트리 포함)** → 슬라이스 B. (A는 학생 로그인 UI에 "임시 신원" 고지만 수행.)
- **교사 read/write 서버 이관** → 슬라이스 B.
- **`production-rls.sql` 적용 · anon revoke · deploymentReadiness flip** → 슬라이스 C. *그 전까지 옛 publishable-키 클라 경로가 병존하므로, 구멍의 완전차단은 C에서 완결된다.* 슬라이스 A는 "서버 경로를 만들어 C를 가능케 하고, 앱 자체 경로에서의 유출·위조를 제거"하는 단계다.
- 플랜/AI 사용량 서버강제 → 슬라이스 D.

### 성공 기준
- solve-load 응답에 어떤 문항의 정답도, answerKey도, pin도 존재하지 않는다(계약 테스트).
- `submitAttempt`가 클라 제출 점수를 신뢰하지 않고 서버 재채점한 값으로 저장한다.
- 게스트/학생이 **본인 제출만** 조회한다.
- 서버 채점 결과가 기존 클라 경로와 동등하다(회귀 동등성 테스트).

## 3. 아키텍처 · 모듈 경계

신규 3모듈 + 기존 페이지 재배선. 기존 교사 서버 경계([`src/app/actions/auth.ts`](../../../src/app/actions/auth.ts), [`teacherServerSession.ts`](../../../src/lib/teacherServerSession.ts), [`supabaseServerAdmin.ts`](../../../src/lib/supabaseServerAdmin.ts))와 동일 패턴을 재사용한다.

| 모듈 | 책임 | 의존 |
|---|---|---|
| `src/lib/studentServerSession.ts` | `omr_student_server_session` 서명 HttpOnly 쿠키 mint/parse (teacherServerSession 미러) | node:crypto |
| `src/app/actions/studentSession.ts` | `issueGuestSession()`, `issueStudentSession(identity)` — 쿠키 발급 | studentServerSession |
| `src/app/actions/studentExam.ts` | `loadExamForSolving`, `verifyExamAccessServer`, `submitAttempt`, `listMyAssignments`, `loadMyAttempt` — service-role + 쿠키 신원 | supabaseServerAdmin, examAccess, types/omr(gradeAttempt), premiumAnalytics(buildQuestionResults) |
| (재배선) `solve/[id]/page.tsx` | 클라 채점·정답로드 제거 → 서버 액션 호출 | studentExam actions |
| (재배선) `student/dashboard/page.tsx` | `listMyAssignments` 서버 액션으로 목록 | studentExam actions |
| (재배선) `page.tsx` 로그인 핸들러 | 게스트/학생 로그인 시 쿠키 발급 액션 호출 | studentSession actions |

**격리 원칙**: 정답 스트립 로직은 순수함수 `stripExamForSolving(exam): SolvableExam`로 분리해 단위 테스트. 서버 채점은 기존 순수함수 `gradeAttempt`/`buildQuestionResults`를 서버에서 그대로 호출(중복 로직 없음).

## 4. 신원 모델 (A1: 서버 발급 서명 쿠키)

쿠키 payload:
```
{ kind: 'guest' | 'student', guestId?, studentId?, name, groupId?, groupName?,
  regionId?, regionName?, identityType, issuedAt, expiresAt }
```
- HMAC-SHA256 서명, HttpOnly, `sameSite:lax`, 프로덕션 `secure`, TTL 30일(기존 StudentSession TTL과 정렬).
- 시크릿: 전용 env `STUDENT_SESSION_SECRET`, 미설정 시 dev 폴백(프로덕션 미설정이면 발급 실패 — teacher 패턴과 동일).

### 게스트
`issueGuestSession()`가 서버에서 guestId 생성(crypto) → 쿠키. 완전 서버 소유·격리. (클라 `getOrCreateGuestId` localStorage 값은 draft 소유키/legacy 병합용으로만 잔존.)

### 학생
클라가 현행대로 명단/코드로 studentId 해석([`resolveStudentIdentity`](../../../src/lib/studentCodes.ts)) → `issueStudentSession(resolvedIdentity)`가 쿠키 발급.

> **명시적 한계(A 범위)**: 명단·시작코드가 아직 클라(localStorage `rosterStorage`/`studentCodes`)이므로, 서버는 로그인 시점에 클라 해석 studentId를 **신뢰**한다. 즉 **로그인 시점 "다른 학생 사칭"은 A에서 완전히 막지 못한다**(서버 명단/코드 검증 = 슬라이스 B). 그러나 발급 후 모든 쓰기의 소유자·org를 서버가 쿠키 기준으로 주입하므로 **점수위조·타학생 대량조회·정답유출·PIN우회는 A에서 차단**된다. 게스트는 서버 생성 신원이라 사칭 개념 자체가 없다.
>
> **A의 완화 조치**: 학생 로그인 UI에 "정식 학생 인증은 준비 중(현재는 이름·반 기반 임시 신원)" 성격을 명시해 보안 오해를 줄인다. 서버 TOFU 코드 레지스트리 등 사칭 하드닝은 **B로 이월**(교사 서버 코드발급 + RLS와 함께 제대로 처리).

클라의 기존 `StudentSession`(sessionStorage/localStorage)은 화면 표시·draft·legacy 병합용으로 잔존하되, **권위 있는 신원은 서버 쿠키**다.

## 5. 서버 액션 계약

### `loadExamForSolving(examId, pin?): SolveLoadResult`
- 쿠키 신원 필수(없으면 `unauthenticated`).
- service-role로 시험 read → `evaluateExamAccess(exam, { session: cookieIdentity, pinVerified })` **서버 강제**. **PIN은 stateless**: `pin` 인자를 `verifyExamPin`(정규화 대조)으로 검증 → 미제공/불일치면 `pin_required` 반환. **구현 확정**: pin-ok 쿠키를 두지 않고 load·submit **양쪽이 각각 `pin` 인자로 재검증**한다. ⚠️ **A2 영향(최우선)**: 클라는 **submit(특히 타이머 자동제출)에도 PIN을 넘겨야** 공개+PIN 시험 제출이 막히지 않는다 — A2에서 (권장) `loadExamForSolving` 성공 시 서명 pin-ok 쿠키를 세워 submit이 PIN 없이 통과하게 개선하거나, (최소) 모든 submit 호출(자동제출 포함)에 PIN을 스레딩할 것.
- 접근 상태 반환: `allowed | pin_required | login_required | group_denied | not_started | ended | archived`. (존재하지 않는 examId도 `ended`로 마스킹 — 열거 방지, 의도적. A2가 "종료됨" UX로 오인 않도록 주의.)
- `allowed`일 때 `stripExamForSolving(exam)` 반환: **문항 `answer`·`explanation` 제거, `answerKeyPdf`/`answerKeyPdfRef` 제거, `accessConfig.pin` 제거**(존재여부 `hasPin` 불리언만). 문항 이미지·pdfRegion·배점·choices는 유지. (`explanation`은 리뷰 전용 서술이라 정답 노출 가능 → 풀이 payload에서 제외.)
- (선택적 하드닝, A 필수 아님) 서명 `attemptToken`(examId+identity+issuedAt)을 함께 반환해 제출 시 재검증 — 구현 계획에서 비용 대비 판단, 기본은 미포함.

### `submitAttempt(input): SubmitResult`
- `input = { examId, answers, timings, drawingRefs?, autoSubmitted }`. **클라가 계산한 점수·questionResults는 받지 않는다.**
- `submitAttempt(input, pin?)`: 쿠키 신원 + 접근 재검증(load와 동일 게이트, `verifyExamPin` 재검증). 접근 실패 시 **granular status**(pin_required/ended/group_denied…) 반환. 클라 `startedAt`는 서버가 `[finishedAt−(durationMin+5m), finishedAt]`로 **클램프**(음수·황당 duration 방지). 재시험(retake)은 A1 서버 경로 없음(`SubmitAttemptInput`에 retake 필드 없음 → 항상 전체 시험 채점) → A2/B에서 별도 처리, 클라 재시험 기능 회귀 주의.
- service-role로 **full 시험** read → `gradeAttempt(exam.questions, answers)` + `buildQuestionResults(exam, attempt)` **서버 채점**.
- `organization_id`(시험 소유 org), 소유자(`guestId`/`studentId`), `identity_type`, `student_name`을 **서버가 쿠키에서 주입**해 `omr_attempts` + `omr_question_results` upsert.
- 반환: 채점 결과(점수·문항결과, 이때 correctAnswer 포함 OK — 제출 후이므로).

### `listMyAssignments(): AssignmentView[]`
- 쿠키 신원 기준.
- **게스트**: 본인(guestId) attempt/draft가 있는 시험만(= 링크로 열어 시작한 것). → "모든 공개시험이 전 게스트에 노출" 제거.
- **학생**: 현행 접근규칙(그룹/공개) 유지하되 서버에서 평가. (완전 서버 명단연동은 B.)

### `loadMyAttempt(attemptId): Attempt | null`
- 쿠키 신원 소유 확인 후에만 반환.

## 6. 데이터 흐름

```
로그인
  게스트: issueGuestSession() → 쿠키
  학생:   (클라 studentId 해석) → issueStudentSession() → 쿠키
대시보드: listMyAssignments()               [본인 것만]
시작:     loadExamForSolving(examId, pin?)   [정답 없는 시험 + 접근게이트 + PIN 서버대조]
  (pin_required면) 사용자 PIN 입력 → loadExamForSolving(examId, pin) 재호출
풀이:     클라 로컬 draft(답안·타이밍, 정답 없음)
제출:     submitAttempt({examId, answers, timings}, pin?)  [PIN 재검증·서버 채점·소유/org 주입·저장]
리뷰:     loadMyAttempt(id)                  [정답 포함 결과 OK]
```

## 7. 확정된 설계 결정

- **(a) 게스트 대시보드 목록 좁힘**: 게스트는 본인 attempt/draft 있는 시험만. (통합계정 냄새 제거) — **확정**.
- **(b) 오프라인 = 서버 필수**: Supabase 백엔드 시험은 load+submit 서버 경로 필수(오프라인 채점 없음). localStorage엔 본인 진행중 draft(답안·타이밍, **정답 없음**)만 저장. 제출 시 오프라인이면 큐잉 후 재접속 서버채점 — **확정**.

## 8. 백워드 호환 · degradation

- **Supabase 미설정(dev/로컬)**: `getSupabaseServerConfigFromEnv`가 null이면 서버 액션은 `degraded_local` 모드로 응답하고, 이 경우에 한해 클라가 기존 localStorage 경로를 사용. **단 이 폴백에서는 정답숨김 보장이 약화**되므로, `NODE_ENV!=='production'`에서만 허용하고 프로덕션에서 service-role 미구성이면 명시적 error(배포 게이트 [`deploymentReadiness.ts`](../../../src/lib/deploymentReadiness.ts)와 정렬).
- **anon 클라 경로 병존(C 이전)**: A 배포 후에도 옛 경로가 살아있어 완전차단은 아님 → 문서·이슈로 C 의존성 추적. A는 앱 UI가 유출·위조 경로를 더는 *사용하지 않도록* 만든다.

## 9. 에러 처리

- 모든 서버 액션은 `{ status, error?, data? }` 형태. 네트워크/서버 실패 시 draft 보존, 제출 실패는 재시도 큐(사용자에게 "재접속 시 자동 제출" 고지).
- 정답이 클라에 없으므로 **임시 클라 채점 폴백 금지**(보안 우선). 채점 결과는 오직 서버에서.
- 접근 거부(group_denied/ended 등)는 기존 solve 페이지 안내 UI 재사용.

## 10. 테스트 전략

- **단위**: `studentServerSession`(서명 라운드트립·위조·만료), `stripExamForSolving`(answer/pin/answerKey 부재 + 표시필드 유지), 서버 채점 동등성(`gradeAttempt` 결과 == 기존 클라 스냅샷).
- **계약**: `loadExamForSolving` 반환 타입에 정답/pin 필드 부재를 타입+런타임으로 단언.
- **통합**: `submitAttempt` org·소유자 서버주입, 클라 위조점수 무시(전달한 점수와 무관하게 재채점), `listMyAssignments`/`loadMyAttempt` 본인격리(타 신원 접근거부).
- **회귀**: 기존 solve/dashboard e2e([`e2e/`](../../../e2e))를 서버경로로 갱신.

## 11. 보안 분석 — A가 닫는 것 / 남는 것

| 위협 | A 이후 | 완전차단 |
|---|---|---|
| 앱 UI의 정답 사전유출 | 차단(정답 미전송) | C(anon revoke)에서 raw 테이블 접근까지 차단 |
| 점수 위조(임의 저장) | 앱 경로 차단(서버 재채점) | C |
| 타학생 PII 대량조회(앱) | 차단(본인만) | C |
| PIN 우회 | 차단(서버 대조) | C |
| 로그인 시점 학생 사칭 | **남음** | B(서버 명단/코드) |
| raw anon 키 직접 쿼리 | **남음** | C(production-rls) |

## 12. 시퀀싱

A → B(교사 서버 read/write) → **C(production-rls 적용 · anon revoke · deploymentReadiness flip)**. C는 A+B 완료 전제. A/B는 각각 독립 배포·테스트 가능하며, C가 최종 스위치. **실제 학생 데이터/런치 전 C 필수** — `deploymentReadiness`의 `OMR_PRODUCTION_RLS_APPLIED` 런치 게이트에 연결하고, C 전까지 "안전한 시험"으로 런치하지 않는다(A/B는 내부 마일스톤).
