# OMR Maker 시스템 파악 및 개발 로드맵

작성일: 2026-07-01 · 대상 브랜치: `premier0.1` · 방법: 7개 영역 병렬 서브에이전트 분석 + 교차검증 + 총괄 종합

---

## 총평 (Executive Summary)

OMR Maker는 프리미어(premier0.1) 진입을 앞둔 **성숙 중기 제품**이다. 강점은 명확하다.

1. 방향 문서(pdf_region + canonical ID + 태그, 이미지 후속)와 **데이터 모델이 정확히 정렬**됨
2. 분석/추천 1~2단계, 재응시 스코프 분리, 아이덴티티 스코프 키가 견고함
3. **모바일/PWA 체감**(앱쉘, 뷰포트, 오프라인 복구, pwa-check 자가진단)이 프로젝트에서 가장 잘 다듬어진 축
4. 461개 순수 로직 테스트 + 완결적 CI가 하부를 받침

그러나 제품의 근본 병목은 **단 하나의 구조적 결함으로 수렴**한다: **신뢰 경계가 서버에 없다.**
정답·채점·플랜·organization_id·PIN이 전부 클라이언트(publishable 키 + localStorage/sessionStorage)에서 결정되고, 현행 alpha RLS는 `using(true)`로 완전 개방돼 있다. 이 하나가 부정행위/점수위조(핵심기능 critical), 테넌트 격리 부재·학생 PII 무인증 노출(보안 2 critical), 결제 연동 시 즉시 터지는 게이팅 우회(프리미엄 예약 블로커)로 여러 영역에 동시에 나타난다.

**다행히 근본 해결의 부품은 이미 준비돼 있다** — `production-rls.sql`(완성형), 서버 서명 세션 쿠키(`teacherServerSession`), 서비스롤 서버 클라이언트(`supabaseServerAdmin`). 남은 일은 **쓰기·채점·정답 조회 경로를 서버 경계로 이관**하는 것이다.

---

## 횡단 테마 (근본 원인)

| # | 테마 | 요지 |
|---|------|------|
| 1 | **서버 신뢰 경계 부재** (단일 최대 병목) | 정답 조회·채점·점수 쓰기·org_id·플랜·AI 사용량·PIN이 전부 클라이언트에서 결정. alpha RLS 전면 개방. 핵심기능·보안·프리미엄의 critical/high가 모두 여기서 파생. 부품은 준비됨. |
| 2 | **채점 로직 이원화 + 무테스트** | 저장 점수는 `gradeAttempt`, 표시 점수는 `summarizeAttemptScore`. ungraded 기준이 달라 저장점수≠표시점수. DB에 남는 `gradeAttempt`는 테스트 0개. '정답 미설정 문항을 학생 오답으로 집계'하는 잠재 버그까지 확인됨. |
| 3 | **통계 정확성: 표본 무시 + 산포 부재** | 표준편차/중앙값/분포 전무, 개념 정답률이 표본 무시 '평균의 평균', 변별도에 소표본 가드 없음, 참여율이 로스터 없으면 무조건 100%. 원 데이터는 이미 존재 — 집계만 표본가중으로 교체하면 됨. |
| 4 | **로컬↔Supabase 이중화의 재동기화 공백** | `saveAttempt` 원격 실패 시 재시도 큐 없음. 재동기화는 목록 로드에만 있는데 학생은 제출 후 단건 리뷰로 이동해 미트리거. `online/visibilitychange` 훅에 flush 한 줄이면 대부분 복구. |
| 5 | **거대 파일 + 행위 테스트 공백** | `create/page.tsx` 2863줄(useState 32개), `ExamAnalyticsTab.tsx` 2700줄. vitest가 node 환경이라 컴포넌트/DOM 테스트 0개. PDF 캔버스 필기(방향 우선순위 2번 핵심)에 행위 회귀 안전망 전무. |
| 6 | **한국 시장 특화 취약점** | CSV 가져오기가 CP949/EUC-KR 미지원(온보딩 첫 관문 사일런트 손상), PDF 문항검출이 수능형 키워드 하드코딩, AI 모델 ID가 유효하지 않은 하드코딩 이름. |

---

## 영역별 요약

### 1. 핵심기능 (제작·PDF/정답 인식·배포·풀이·자동채점)
- **강점**: 데이터 모델이 방향 문서와 일치 · 정답 인식 '텍스트 우선 → AI 폴백' 계층 + 품질 평가 재시도 · AI 오류 안전 처리 · 재응시 스코프 분리 · `examValidation` 촘촘한 배포 전 검증
- **최대 갭**: `[critical]` 정답·채점이 전부 클라이언트 노출·수행 (부정행위/점수위조 무방비) · `[high]` 두 채점 경로 총점 불일치 · `[high]` `gradeAttempt` 무테스트 · `[high]` 복수정답·부분점수 미지원

### 2. 분석및통계
- **강점**: 아이덴티티 스코프 키(지역/동명이인 분리) · 재시험 전 계층 일관 분리 · 합성 데이터 격리 · 데이터 결손 복구 설계 · 0-division/NaN 방어 중앙화
- **최대 갭**: `[high]` 표준편차·중앙값·분포 전무 · `[high]` 개념 정답률 '평균의 평균'(표본 무시) · `[high]` 변별도 소표본 가드 없음 · `[medium]` 참여율 로스터 없으면 100%

### 3. 프리미엄기능
- **강점**: 게이팅 판정 순수 함수 단일화(서버 이관 표면 작음) · provider readiness 상태머신 통일 · '로컬 기록' 정직한 표기 · 카카오 후보 파이프라인 성숙(실발송만 없음)
- **최대 갭**: `[critical→예약]` 게이팅이 localStorage만으로 결정돼 완전 우회(실결제 연동 순간 터짐) · `[high]` AI 사용량 카운터 월 리셋 없는데 UI는 '월 한도' · `[high]` Gemini 서버액션에 플랜/사용량/인증 전무

### 4. 모바일체감
- **강점**: 오프라인 앱쉘 실전 설계 · SW 업데이트가 작업 파괴 안 함 · iOS/안드로이드 뷰포트 구분 · pwa-check 자가진단 완성도 · 반응형 3단 전략 · 로컬 우선 저장
- **최대 갭**: `[high]` PDF 캔버스 필기 e2e 미검증 · `[high]` 원격 동기화 실패 재시도 큐 부재 · `[medium]` 필기 저장 실패가 제출 자체를 차단 · `[medium]` PDF가 실제보다 40px 좁게 렌더

### 5. 보안설계
- **강점**: 자격증명 서버액션 검증(timingSafeEqual) · 서비스롤 서버 전용 · 서버컴포넌트 라우트 가드 · `production-rls.sql` 완성형 사전 준비 · 보안 체크리스트 문서화
- **최대 갭**: `[critical]` 클라이언트 통제 org_id + 공개 RLS = 테넌트 격리 부재 · `[critical]` 학생 PII 무인증 노출/조작 · `[high]` 세션 토큰 서명·바인딩 없음 · `[high]` 시험 ID 열거 가능 · `[high]` 레이트리밋 in-process Map(서버리스 무력화)

### 6. 기타 / 횡단 인프라
- **강점**: 순수 로직 테스트 밀도(461개 전부 통과) · CI 완결적 · 영속화 준비성 계층 분리 · 한글 인코딩 이중 방어 · draftRecovery 무손실 설계
- **최대 갭**: `[high]` CSV 가져오기 EUC-KR/CP949 미지원 · `[medium]` `global-error.tsx` 부재 · `[medium]` 실제 에러 관측성 부재(Sentry 주석뿐) · `[medium]` TASK.md/TECHNICAL_SPECS.md 심하게 낡음

---

## 개발 로드맵

### P0 — 프리미어 배포 전 블로커 (성적 신뢰성·테넌트 격리·PII)
| 영역 | 항목 | Effort |
|------|------|:---:|
| 보안/핵심 | 학생용 Exam 페이로드에서 정답·answerKeyPdf를 서버에서 스트립한 solve-view 라우트 | L |
| 보안/핵심 | 서버측 채점 서버액션(`gradeAndSaveAttempt`) — 클라이언트는 답안만 전송 | L |
| 보안 | alpha 공개 RLS 제거 + publishable-키 직접 쓰기 봉쇄(서버 라우트+service-role, org_id 서버 강제) | L |
| 보안/PII | `omr_student_profiles`(email/phone/guardian_contact) 공개 정책 즉시 제거 | M |
| 핵심/테스트 | `gradeAttempt` 전용 단위테스트 + 정답 미설정 문항 오답 집계 버그 수정 | S |

### P1 — 다음 마일스톤 (신뢰성·정확성·비용 안전)
| 영역 | 항목 | Effort |
|------|------|:---:|
| 핵심 | 채점 단일 소스 통합(`gradeAttempt`를 `summarizeAttemptScore` 기준으로 재구현) | M |
| 프리미엄/보안 | AI 서버액션 세션 검증 + 서버측 월별 사용량 카운팅 | M |
| 프리미엄 | 플랜/엔타이틀먼트를 서버 소스(organizations.plan)로 이관 (실결제 PR과 동일 마일스톤) | L |
| 모바일/영속화 | 제출 실패분 pending-sync 큐 + online/visibilitychange flush | M |
| 모바일/핵심 | 제출 순서 분리 — 답안 먼저 확정, 필기 실패는 deferred 큐잉 | M |
| 분석/통계 | 기술통계 코어(표준편차·중앙값·사분위·분포 히스토그램) | M |
| 분석/통계 | 표본 가중 정답률 교정 + 소표본 신뢰도 게이팅 | S |
| 보안 | 시험 ID·시작코드를 CSPRNG 비열거 토큰으로 교체 | S |
| 핵심 | 복수정답·전항정답·부분점수 정답 스키마 확장 | L |
| 횡단/온보딩 | CSV 가져오기 EUC-KR/CP949 자동 감지 폴백 | S |

### P2 — 이후 (품질·기술부채·관측성)
| 영역 | 항목 | Effort |
|------|------|:---:|
| 핵심 | AI 정답 인식 저신뢰 문항 리뷰 UX(신뢰도 뱃지·더블체크) | M |
| 핵심 | AI 모델 ID env 외부화 + 유효 모델 교정 + 성공 경로 로깅 | S |
| 횡단/관측성 | `global-error.tsx` + `reportError` 훅 | S |
| 모바일/테스트 | PDF 필기 e2e 스모크 + getPos/포인터 분기 순수함수 추출·단위테스트 | M |
| 핵심/기술부채 | `create/page.tsx` 도메인 훅/컴포넌트 분해 + 빠른입력 q.number 기반 교정 | XL |
| 횡단/문서 | TASK.md·TECHNICAL_SPECS.md 최신화/아카이브, service-direction.md 단일 소스 명시 | S |

---

## 즉효 (Quick Wins — 반나절~1일)

1. `gradeAttempt` 단위테스트 + 정답 미설정 문항 오답 집계 버그 수정 (회귀방지 + 실버그 동시)
2. `omr_student_profiles` 공개 읽기/쓰기 RLS 정책 제거 (PII 즉시 차단, SQL 위주)
3. OverviewTab 가짜 트렌드 `+12%` 하드코딩 제거 + avgScore `.toFixed(1)` 정리
4. 시험 ID/시작코드를 `crypto.randomUUID`/`getRandomValues`로 교체
5. CSV 가져오기 EUC-KR/CP949 폴백 + `csv.test.ts` 바이트 픽스처
6. 참여율: 로스터 없는 반은 100% 대신 '명단 미연결' 표시
7. AI 모델 ID env 외부화 + 성공 경로 응답 모델 로깅
8. 변별도/약점 severity에 MIN_SAMPLE 게이트
9. vitest 커버리지(`@vitest/coverage-v8`) 도입 + CI 리포트(비강제)
10. TASK.md/TECHNICAL_SPECS.md 아카이브 + service-direction.md 단일 소스 명시

---

## 최우선 리스크 (Top Risks)

1. **성적 신뢰성 원천 붕괴** — 서버 신뢰 경계 없이 배포하면 학생이 정답을 풀이 전 추출하거나 임의 점수 위조 저장 가능. '온라인 시험'으로서 무의미. (RLS와 무관하게 실재)
2. **학생·보호자 PII 무인증 노출** — alpha 공개 RLS 하 publishable 키만으로 read/write. 실제 데이터 투입 시 PIPA 위반급.
3. **테넌트 격리 부재** — org_id 클라이언트 파생 + by-id 조회 무스코프. curl로 타 학원 데이터 교차 조회·오염.
4. **결제 스위치 = 유료기능 무료 개방** — 서버 게이팅 없이 billing 켜면 localStorage 한 줄로 뚫림. billing PR과 서버 검증을 반드시 동일 마일스톤에.
5. **점수 은닉 회귀** — DB 저장 점수 만드는 `gradeAttempt` 무테스트 + 표시 경로와 총점 기준 상이. 잘못된 점수 조용히 저장돼도 CI가 못 잡음.

---

---

## 구현 진행 로그

### 2026-07-01 — 즉효 묶음 (완료)

| 항목 | 내용 | 파일 |
|------|------|------|
| ✅ gradeAttempt 버그+테스트 | 정답 미설정 문항을 오답으로 집계하던 버그 수정(→ `ungraded` 분류, 총점에서 제외해 표시 경로와 정합). `ungradedCount` 필드 추가. 전용 단위테스트 10개 | `src/types/omr.ts`, `src/types/omr.test.ts` |
| ✅ 참여율 정확화 | 로스터 없는 반의 오해성 100% → `null`(분모 미상). UI는 '명단 미연결' 표시. 정렬/카카오 큐 가드 | `src/lib/premiumAnalytics.ts`, `ExamAnalyticsTab.tsx`, `kakaoNotificationQueue.ts` |
| ✅ 시작코드 CSPRNG | `Math.random` → `crypto.getRandomValues`(주입형 인터페이스 유지) | `src/lib/studentCodes.ts` |
| ✅ 시험 ID 비열거화 | `Date.now().toString(36)`(단조증가) → `crypto.randomUUID` 기반 `secureRandomId`. 신규 시험/복제 시험 링크. 기존 ID는 보존 | `src/utils/ids.ts`(+test), `create/page.tsx`, `OverviewTab.tsx` |
| ✅ 가짜 트렌드/표시 정리 | Total Students 하드코딩 `+12%` 제거, 정수 avgScore의 무의미한 `.0` 제거 | `OverviewTab.tsx` |
| ✅ CSV EUC-KR 폴백 | 가져오기가 UTF-8 실패 시 EUC-KR/CP949로 재디코드(`decodeCsvBytes`). 바이트 픽스처 테스트 | `src/lib/csv.ts`(+test), `teacher/users/page.tsx` |
| ✅ PII 배포 게이트 강화 | (alpha schema는 dev 의존이라 미변경) 프로덕션+Supabase+RLS 미확인 상태를 `error`로 승격. `OMR_PRODUCTION_RLS_APPLIED` attestation 플래그 도입 | `src/lib/deploymentReadiness.ts`(+test) |

**검증**: 단위 478개 통과(461→+17) · `tsc` 클린 · eslint 클린 · `npm run build` 성공 · 교사 대시보드 preview 무에러 확인.

### 2026-07-02 — 슬라이스 A Phase A2(클라 배선) 구현 + 학생 Q&A 루프 (완료)

| 항목 | 내용 | 파일 |
|------|------|------|
| ✅ A2 래퍼 | `studentExamClient` — 서버 우선 + 안전 로컬 폴백(`degraded_local`/`not_found`/네트워크 예외만, **로컬 읽기 전용** — 쿠키 삭제로 정답 오라클 우회 불가) | `src/lib/studentExamClient.ts`(+test 14) |
| ✅ 로그인 배선 | 게스트/학생 로그인 시 `issueGuestSession`/`issueStudentSession` 서버 쿠키 발급 + 임시신원 고지 문구 | `src/app/page.tsx` |
| ✅ 게스트 연속성 | `issueGuestSession`이 유효한 게스트 쿠키 재사용(이름만 갱신) — 재로그인/딥링크에도 guestId 유지 | `src/app/actions/studentSession.ts` |
| ✅ solve 서버화 | 로드=`loadExamForSolving`(정답 없는 payload), PIN 게이트 서버 재검증, 제출=`submitAttempt` 서버 채점(자동제출 PIN 스레딩 `pinRef`), 접근판정 단일화(`solveAccess`) | `src/app/solve/[id]/page.tsx` |
| ✅ 서버 채점 보강 | `SubmitAttemptInput`에 retake/필기 메타 확장 + **재시험 스코프 채점**(`resolveRetakeScope`, 검증된 부분집합만 채점) | `src/lib/studentExamCore.ts`(+test 5) |
| ✅ not_found 구분 | 시험 행 부재를 `ended`와 구분 — 오프라인 생성/미동기화 시험 로컬 폴백 가능 | `src/app/actions/studentExam.ts` |
| ✅ 대시보드/리뷰 서버화 | `listMyAssignments`(게스트는 시작한 시험만+로컬 draft 감지), `loadMyAttempt`(본인 소유 확인) | `student/dashboard`, `student/review` |
| ✅ 학생 Q&A 루프 | 질문이 attempt payload(`studentQuestions`)에 저장·동기화 — 서버 액션 `askAttemptQuestion`(소유 검증), 교사 attempt 페이지 답변 카드, 학생 리뷰에 답변 표시. 레거시 localStorage 큐는 마이그레이션 읽기 전용 | `src/lib/studentQuestions.ts`(+test 6), `types/omr.ts`, 리뷰/교사 attempt 페이지 |
| ✅ 동기화 pending 큐 | `saveAttempt` 원격 실패 → 레지스트리 기록, `SyncFlusher`(online/visibilitychange)가 재시도 — 제출→단건 리뷰 경로의 유실 복구 | `omrPersistence.ts`(+test 3), `components/SyncFlusher.tsx`, `app/layout.tsx` |
| ✅ 로그아웃 쿠키 정리 | 학생 로그아웃이 httpOnly 서버 세션 쿠키도 삭제(공용 기기 신원 상속 차단) | `studentSession.ts`, `student/dashboard` |
| ✅ e2e 결정론화 | `.env.local`의 TEACHER_ACCOUNTS가 e2e 교사 로그인(admin/admin123 dev 기본값)을 깨던 기존 결함 — playwright webServer env에서 TEACHER_* 중화 | `playwright.config.ts`, `playwright.production.config.ts` |

> **활성화 조건**: 서버 경로는 `SUPABASE_SERVICE_ROLE_KEY`(또는 `OMR_SUPABASE_SERVICE_ROLE_KEY`)가 서버 env에 있어야 켜진다. 미설정 시 전 경로가 기존 로컬 동작으로 degrade(설계된 폴백). 잔여: production-rls 적용(C), 리뷰 페이지 시험 로드(정답 포함)의 서버 액션화(B), PIN 레이트리밋(P1).

### 2026-07-02 — 라운드2: B-1 착수 + 학생/교사 디벨롭 + 관측성 (완료)

전 항목 다차원 적대적 리뷰(4차원×2스킵틱 검증) 후 확정 이슈 수정까지 포함.

| 항목 | 내용 | 파일 |
|------|------|------|
| ✅ 리뷰 시험로드 서버화 | `loadExamForReview`(본인 소유 확인, `stripExamForReview`로 PIN·답지 PDF만 제거·정답/해설 유지) + `loadReviewExamClient` 래퍼, 리뷰 페이지 배선 | `examSolvePayload.ts`, `actions/studentExam.ts`, `studentExamClient.ts`, 리뷰 페이지 |
| ✅ PIN 브루트포스 방어 | `examPinRateLimit`(2계층: per-(exam,신원) 5회 + **per-exam 글로벌 60회** — 게스트 신원 회전 스윕 차단). `evaluateGatedAccess`가 load/submit 양쪽 게이트 | `examPinRateLimit.ts`(+test 6) |
| ✅ 배포 진단 강화 | `supabase_service_role` 체크가 production+public-sync에서 미설정 시 `error`로 승격(학생 서버 경계 무력화 경고) | `deploymentReadiness.ts`(+test) |
| ✅ 재시험 회복 리포트 | `retakeRecovery`(원시험 대비 회복/역행, **학생 교차비교 방어**). 학생 리뷰 회복 카드 + ExamAnalyticsTab 회복률 stat | `retakeRecovery.ts`(+test 7), 리뷰/분석 페이지 |
| ✅ 불안정 개념 신호 | '맞았지만 기대시간 1.5×↑ 반복' 문항을 `slowCorrectCount`로 집계, 추천에 반영(opt-in `includeSlowCorrect` — 기존 소비자 회귀 zero, 학생 리뷰만 켬) | `premiumAnalytics.ts`(+test 4) |
| ✅ Q&A 인박스 | `collectStudentQuestionInbox`(대기 오래된 순), 교사 대시보드 Overview 대기 질문 카드(attempt 링크) | `studentQuestions.ts`(+test), `OverviewTab.tsx` |
| ✅ 해설 요청 원클릭 | 리뷰 문항 카드에서 Q&A 채널 재활용해 해설 요청 전송 | 리뷰 페이지 |
| ✅ 프리미엄 게이트 연산 skip | ExamAnalyticsTab의 잠금 UI 전용 5개 useMemo가 `!advancedAnalyticsEnabled`면 조기 반환(Free 티어 낭비 연산 제거) | `ExamAnalyticsTab.tsx` |
| ✅ 관측성 기반 | `reportError` 단일 퍼널 + `global-error.tsx`(루트 레이아웃 장애 대비, 자체 html/body) | `reportError.ts`, `app/global-error.tsx`, `app/error.tsx` |
| ✅ **HIGH 수정** | 전체범위("전체") 재시험이 서버 제출 시 retake 메타를 잃고 원시험으로 이중집계되던 버그 — `resolveRetakeScope`가 full-scope도 retake 유지 | `studentExamCore.ts`(+test) |
| ✅ 리뷰 확정 이슈 6건 | Q&A stale-closure(attemptRef+뮤텍스), 레거시 큐 미마이그레이션 삭제 제거, solve PIN 상태 되돌림/스테일 재검증, Free-티어 slow-only 표시 오해 | 리뷰/solve 페이지 |

**B/C 잔여 실행 플랜**: [`docs/superpowers/plans/2026-07-02-slice-bc-server-migration.md`](superpowers/plans/2026-07-02-slice-bc-server-migration.md) — 교사 read/write 이관·명단/시작코드 서버화·production-rls 적용 절차 + 클라이언트 직접 쓰기 경로 인벤토리.

> **PII 관련 판단**: `production-rls.sql`이 이미 학생 PII를 완전히 잠그고 있어(read by staff/self, write by staff, anon revoke, force RLS), 진짜 리스크는 '보호 부재'가 아니라 'production-rls 미적용 상태 배포'다. alpha `schema.sql`의 공개 정책을 제거하면 인증 없는 dev/alpha가 깨지므로, 대신 배포 준비성 체크를 위험 상태에서 `error`로 승격하는 방식으로 처리. 실제 PII 잠금(서버 경로 이관 + production-rls 적용)은 P0에 남아 있음.

---

*원본 상세 리포트(영역별 gap 근거 `file:line`, 교차검증 verdict 포함)는 워크플로우 산출물에 보존됨.*
