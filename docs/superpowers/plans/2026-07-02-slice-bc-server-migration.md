# 서버 신뢰 경계 — 슬라이스 B(교사 경로)·C(production-rls) 실행 플랜

작성일: 2026-07-02 · 선행: 슬라이스 A(A1+A2) 완료 · 관련: [`system-review-2026-07.md`](../../system-review-2026-07.md), [`supabase/production-rls.sql`](../../../supabase/production-rls.sql), 스펙 [`2026-07-01-student-guest-server-boundary-design.md`](../specs/2026-07-01-student-guest-server-boundary-design.md)

## 현재 상태 (A2 이후)

학생/게스트 경로는 서버 경계를 통과한다: 시험 로드(정답 없는 payload)·PIN(서버 검증+레이트리밋)·제출(서버 채점)·본인 조회·리뷰 payload(`loadExamForReview`)·문항 질문(`askAttemptQuestion`). 전부 `SUPABASE_SERVICE_ROLE_KEY` 있을 때 활성, 없으면 로컬 degrade.

**남은 클라이언트 직접 쓰기 경로(전부 publishable 키·alpha RLS 의존)** — 2026-07-02 인벤토리:

| 호출자 | 함수 | 쓰는 테이블 |
|---|---|---|
| `create/page.tsx:1256`, `OverviewTab:137,158` | `saveExam` | `omr_exams`, `omr_exam_questions`(+bootstrap 4테이블) |
| `OverviewTab:185` | `deleteExam` | `omr_question_results`→`omr_exam_questions`→`omr_attempts`→`omr_exams` 하드삭제 |
| `teacher/dashboard:191`(리페어), `teacher/live:429`(강제종료), `teacher/attempt:179`(Q&A 답변) | `saveAttempt` | `omr_attempts`, `omr_question_results` |
| `student/review:547`(질문 degraded 폴백), `solve:1386`(degraded 제출), `SyncFlusher` | `saveAttempt`/flush | 동일 |
| `teacher/users:331,260`, `dashboard:93`, `settings:318` | `saveRosterSnapshot`/`loadRosterSnapshot`(로드가 쓰기도 함!) | `omr_classes`, `omr_student_profiles`, `omr_class_students`(+bootstrap) |
| `ExamAnalyticsTab:390,410,426` | 카카오 리뷰/디스패치 sync | `omr_kakao_candidate_reviews`, `omr_kakao_dispatch_logs` (`organization_id: null`로 기록 — 버그성) |
| 모든 `loadExams`/`loadAttempts` 호출 | 로드시 재동기화 upsert | exams/attempts 계열 |

## 0. 선행 준비 — 서비스롤 키

1. Supabase 대시보드 → Project Settings → API → `service_role` 키 복사.
2. `.env.local`(dev) / 배포 환경변수(운영)에 `SUPABASE_SERVICE_ROLE_KEY=...` 추가. **NEXT_PUBLIC 접두 금지**, 클라이언트 번들에 절대 노출 금지.
3. 확인: 교사 설정 → 보안 → 배포 진단에서 "서버 신뢰 경계 (service role)" ready. 학생 solve 네트워크 응답에 `answer` 필드 부재 확인.

## B — 교사 read/write 서버 이관

원칙: A2와 동일 패턴 — 교사 서명 쿠키(`teacherServerSession`)를 검증하는 서버 액션 + `supabaseServerAdmin`, 클라 래퍼는 `degraded_local` 폴백. `omrPersistence`의 로컬 캐시 계층은 유지(오프라인/dev).

- [ ] **B1. teacherExam 액션 모듈**: `saveExamAction`/`deleteExamAction`/`listWorkspaceExamsAction`/`listWorkspaceAttemptsAction` — org 스코프는 쿠키에서 서버 파생(`workspaceContextFromIdentity`), 클라 org_id 불신. `teacherExamClient` 래퍼(A2의 `studentExamClient` 패턴 재사용).
- [ ] **B2. create/OverviewTab/dashboard 배선**: saveExam/deleteExam/목록 로드를 래퍼로. 로드시-재동기화(upsert on load)는 서버 액션 뒤로 이동하거나 pending 큐로 일원화.
- [ ] **B3. 교사 attempt 쓰기 서버화**: Q&A 답변(`answerAttemptQuestionAction` — 교사 쿠키 검증 + org 소속 attempt 확인), live 강제종료(`forceFinishAttemptsAction`).
- [ ] **B4. 명단 서버 소스화**: `loadRosterSnapshot`의 "로드가 곧 쓰기" 제거 → 명시적 `saveRosterAction`/`fetchRosterAction`. 시작코드(`omr_student_codes` — 현재 **localStorage 전용, 서버 미동기**)를 서버 테이블(`omr_student_codes`: org_id, student_profile_id, code_hash)로 이관 → 학생 로그인 시 서버 검증(사칭 차단의 실질 해결). 스키마 추가 필요.
- [ ] **B5. 카카오 기록 정합**: `organization_id: null`로 쓰이는 리뷰/디스패치 행에 org 주입(서버 액션 이관 시 함께). 신규 candidate_kind(예: `question_answered`)는 `omr_kakao_candidate_reviews.candidate_kind` CHECK 제약 마이그레이션 필요(schema.sql:354).
- [ ] **B6. 라이브 실시간 설계(선택)**: 현재 `status:"in_progress"` attempt를 만드는 코드가 없어 강제종료 실경로가 사실상 도달 불가. solve 시작 시 서버 액션으로 in_progress presence 행 생성 → 분석 필터(`baseAttemptsOnly`, 통계 경로)의 completed 필터링 전수 점검과 **같은 PR**로. 폴링(3s) → Supabase Realtime 구독 전환 검토.

## C — production-rls 적용 (런치 게이트)

전제: B1–B4 배선 완료(교사 쓰기가 서버 경유), Supabase Auth/조직 멤버십 부트스트랩 준비.

- [ ] **C1. 리허설**: 스테이징(또는 별도 프로젝트)에 `production-rls.sql` 적용 → e2e full-journey + 교사 여정 수동 점검. anon 키 curl로 `omr_student_profiles`/`omr_exams` read/write가 거부되는지 확인.
- [ ] **C2. 적용**: 운영 SQL Editor에서 `production-rls.sql` 실행 → `OMR_PRODUCTION_RLS_APPLIED=true` 설정 → 배포 진단 5항목 ready 확인.
- [ ] **C3. 봉쇄 검증**: publishable 키 직접 쿼리(시험 정답, 학생 PII, 타 org attempt) 전부 거부. `SyncFlusher`/degraded 폴백 경로가 운영에서 remoteError로 무해하게 실패하는지(로컬 데이터 유지) 확인.
- [ ] **C4. 롤백 계획**: alpha `schema.sql`의 공개 정책 재적용 스크립트를 준비해 두되, 롤백 시 `OMR_PRODUCTION_RLS_APPLIED` 해제.

## 이월(D)

- 플랜/엔타이틀먼트 서버 이관(organizations.plan 소스화) — **실결제 PR과 동일 마일스톤 필수**.
- AI 사용량 서버 카운팅, 시험 ID 열거 잔여(레거시 ID), 레이트리밋 저장소의 다중 인스턴스 대응(Redis/DB 카운터).
