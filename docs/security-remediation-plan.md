# 보안·아키텍처 개선 계획 (감사 후속)

전체 A-to-Z 감사(2026-07-13)에서 확인된 항목 중, **Supabase 스키마·서버 세션·클라우드 스토리지 등 백엔드 구조 변경이 필요해** 이번 병렬 수정 배치에서 코드로 완결하지 않고 별도로 다루는 대형 항목을 정리한다. 여기 적힌 항목은 "발견됨 + 설계 확정" 상태이며, 실제 결제/실서비스 배포 전에 반드시 처리해야 한다.

각 항목은 감사에서 인접 어드버서리 에이전트가 재검증(refute 시도)을 통과한 것이다.

---

## A1. 플랜/권한이 클라이언트 localStorage에만 존재 — 위·변조 가능 (HIGH)

- **근거:** `src/utils/plans.ts:241` `getCurrentPlan()`이 `localStorage['omr_plan']`을 읽고, 모든 게이트(`hasPlanEntitlement`, `evaluatePlanLimit`)가 이 값에서 파생. 로그인은 계정에 바인딩된 플랜을 `setCurrentPlan()`으로 localStorage에 복사할 뿐(`src/app/page.tsx:231`), 서버 세션 쿠키에는 plan 필드가 없음. 결제 "업그레이드"도 `setCurrentPlan(target)` 로컬 호출뿐(`src/app/teacher/billing/page.tsx:335`).
- **영향:** devtools에서 `localStorage.setItem('omr_plan','academy')` 한 줄로 모든 유료 기능 해제, 학생/시험 수 제한 무력화, AI 사용량 카운터 리셋.
- **이번 배치에서 처리한 부분:** AI 인식 서버 액션에 서버 세션 검증 + 서버측 사용량 카운팅 추가(항목 A2). 나머지 게이트는 여전히 표시용.
- **완결 계획:**
  1. 플랜을 서버 권위값으로 승격: `TEACHER_ACCOUNTS`(또는 Supabase `teacher_accounts` 테이블)의 계정 레코드에 plan 저장, 로그인 시 서명된 teacher 세션 쿠키(`TeacherSession`)에 `plan` 필드 포함(`createTeacherSession`/`createSignedTeacherSessionCookie` 확장).
  2. 게이트가 걸린 실제 mutation(시험 저장 sync, attempt sync, `analyzeKey`)을 수행하는 **서버 경로**에서 entitlement/limit 재검증.
  3. 클라이언트 `omr_plan`은 표시 힌트로만 취급.
- **선행 의존:** 서버 세션에 plan을 싣는 변경은 `teacherServerSession.ts`/`teacherSession.ts`를 건드리므로, A2와 함께 단일 PR로 진행 권장.

## A2. AI 인식 서버 액션 무인증·무제한 — 플랫폼 Gemini 키 남용 (CRITICAL/HIGH)

- **근거:** `src/app/actions/analyzeKey.ts:69` `analyzeAnswerImages`는 `'use server'` 액션(직접 POST 가능)이며 `resolveGeminiApiKey(personalApiKey, process.env.GEMINI_API_KEY)`로 서버 키 폴백. 세션 검증·레이트리밋·사용량 회계 전무. 유일한 제한은 클라이언트(`AnswerImportModal.tsx:52`).
- **이번 배치 처리(server-security-plan):** 액션 상단에서 `parseSignedTeacherSessionCookie(TEACHER_SERVER_SESSION_COOKIE)` 검증, 세션 없고 personalApiKey도 없으면 서버 키 사용 거부, `session.identity` 키로 서버 인메모리 사용량 카운터 + 이미지 수 상한. **→ 코드로 완결(배치 결과 참조).**
- **잔여(이 문서):** 인메모리 카운터는 서버리스/멀티 인스턴스에서 불완전(A3). Redis/Supabase 원자적 카운터로 승격 필요.

## A3. 레이트리미터가 프로세스 인메모리뿐 (MEDIUM)

- **근거:** `teacherLoginRateLimit.ts:21`, `examPinRateLimit.ts:44`가 각각 `new Map()`. 인스턴스마다 별도, 콜드스타트 리셋. PIN 공간 4~6자리라 실서비스 브루트포스 방어 취약.
- **이번 배치 처리:** 스토어를 주입 가능한 인터페이스로 유지(기본은 인메모리). Redis/Supabase 어댑터 자리 마련.
- **완결 계획:** Redis `INCR`+TTL 또는 Supabase 원자적 upsert/RPC 백엔드 어댑터 구현, 해시 키 그대로 사용.

## A4. 그룹 제한 시험 접근이 로그인 폼의 자기신고 그룹을 신뢰 (MEDIUM)

- **근거:** `examAccess.ts:64`가 `session.groupId ∈ exam.allowedGroups`면 접근 허용. 그 groupId는 로그인 폼 `selectedGroupId` → 서명 학생 쿠키(`page.tsx:342`, `studentSession.ts:55`). 로스터는 클라이언트 localStorage(`readRosterGroups`), 서버는 실제 소속 미검증.
- **영향:** 임시 신원 학생이 로그인 시 임의 그룹 선택으로 다른 반 대상 시험 통과 가능(게스트는 정상 차단).
- **완결 계획:** 로스터/등록을 DB에 영속화하고, 접근 평가 서버 액션(`studentExam.ts` `evaluateGatedAccess`)에서 서명된 studentId가 해당 그룹에 실제 등록됐는지 확인. 그때까지 group 접근을 PIN 접근처럼 서버 검증 단계로 취급.
- **선행 의존:** A6(로스터 서버 영속화).

## A5. 클라이언트 anon 키 + 클라이언트 org 필터 vs 전면 공개 RLS (HIGH)

- **근거:** 브라우저 영속 클라이언트가 publishable/anon 키로 생성(`omrPersistence.ts:982`), 테넌트 격리는 클라이언트가 붙이는 `.eq('organization_id', ctx.organizationId)`뿐. 알파 정책 `supabase/schema.sql:903,945`는 `omr_exams`/`omr_attempts`를 `using(true)`로 **공개**. exam payload에 정답·PIN·정답지 참조 포함.
- **영향:** anon 키(모든 브라우저에 배포됨)를 가진 누구나 org 필터를 빼고 전 테넌트 시험·정답·응시 열람 가능.
- **완결 계획(택1):**
  - (a) 모든 read/write를 service-role 서버 액션으로 라우팅(현재 `studentExam.ts`처럼)하고 data-capable anon 클라이언트 배포 중단.
  - (b) Supabase Auth 연동으로 `auth.uid()`를 채워 `supabase/production-rls.sql`(uid 기반)을 실제 적용.
- **최소 조치:** 비개발 배포 전 `using(true)` select/all 정책 제거, 시험 read를 배정/멤버십 뒤로 게이트.
- **주의:** 현재 앱이 anon 공개 read에 의존하므로, RLS를 조이기 전에 (a)/(b) 중 하나를 먼저 완료해야 앱이 깨지지 않음.

## A6. 그룹 제한 배포가 학생 브라우저 localStorage의 교사 로스터에 의존 (HIGH)

- **근거:** `page.tsx:151`/`examAccess.ts:65`. 학생 기기에 교사 로스터가 없으면 그룹 매칭 불가.
- **완결 계획:** 로스터를 서버(Supabase)에 영속화하고 접근 평가를 서버에서 수행. A4와 동일 기반.

## A7. 문제지/정답지 PDF가 교사 기기를 떠나지 않음 — 타 기기 학생은 시험지 없음 (HIGH)

- **근거:** `blobStore.ts:60` `saveFileDataUrl`이 IndexedDB 사용 가능 시 로컬 ref만 반환. `create/page.tsx:1285`가 `pdfData = inlineDataUrl || ""` → 원격 payload는 `pdfData:""` + 기기-로컬 ref. `omrPersistence.ts` 업로드에 asset 업로드 단계 없음(`storage.from().upload` 부재). 학생 기기에서 ref 해석 실패 → `solve/[id]/page.tsx:988`는 else 없이 업로드 드롭존 노출(무오류).
- **정답지 뉘앙스:** 정답지 PDF는 학생에게 안 보내는 것이 의도(`examSolvePayload.ts`가 strip). 단, 정답지도 Supabase에 전혀 안 올라가 교사 2번째 기기에서도 복구 불가.
- **이번 배치 처리(create-distribute):** solve 로드 시 ref 해석 실패하면 조용한 업로드 프롬프트 대신 "문제지 PDF를 불러오지 못했습니다" 상태 노출(부분). Electron 데스크톱 공유 URL 루프백 경고(항목 9).
- **완결 계획:** 업로드 전 문제지 PDF를 Supabase Storage에 업로드하고 URL을 payload에 저장(행 크기 한계 고려), 정답지는 교사 전용 접근으로 원격 영속화.

---

## 처리 완료(코드) 항목 요약

이번 병렬 배치에서 코드로 완결된 보안/버그 항목(상세는 배치 결과):
- AI 인식 서버 액션 인증 게이트 + 서버측 사용량/이미지수 상한 (A2 핵심)
- 세션 HMAC 시크릿 production fail-closed, 비보안 쿠키 오버라이드를 non-production으로 제한
- CSV 수식 인젝션 중화(`csv.ts` 단일 지점, 3개 export 경로 동시 수정)
- 보안 헤더 추가(`X-Frame-Options`, `nosniff`, `Referrer-Policy`, `frame-ancestors`)
- "월" AI 인식 카운터가 실제로 월별 리셋되도록 수정
- 로그아웃/계정 전환 시 plan localStorage 정리
- `/create` 에디터 서버 세션 게이트

> 유지보수 메모: A1·A4·A5·A6·A7은 서로 얽혀 있다(서버 세션 확장 + Supabase 스키마/스토리지 + 서버 라우팅). 개별 패치보다 "서버 권위화" 단일 에픽으로 묶어 진행하는 것을 권장한다.
