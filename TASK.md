# OMR Maker Project Task Plan

> Last refreshed: 2026-07-15. Earlier revisions of this file described the pre-MVP plan;
> most of those items have shipped. This revision reflects the actual state of the app.

## 1. Project Overview

**OMR Maker** is a web platform for teachers to create, distribute, and grade OMR-based exams, and for students to take them online and review results.

**Tech Stack**: Next.js 16 (Turbopack) + React 19 + TypeScript, custom CSS-variable design system (no Tailwind), Recharts, localStorage-first persistence with optional Supabase sync, Gemini AI (answer-key extraction), Playwright/Vitest, PWA + Capacitor Android shell + Electron desktop shell.

## 2. Current Status (shipped)

- **Auth**: role-based portal — teacher accounts via `TEACHER_ACCOUNTS`/`TEACHER_PASSWORD` env (dev demo fallback `admin`/`admin123` when unset); student login by name/group; guest mode with merge-on-login.
- **Teacher**: dashboard (overview / exam analytics / student analytics tabs), exam create flow (`/create`) with PDF + Gemini answer-key import, distribution (groups/PIN access), live monitoring (`/teacher/live`), user & group management (`/teacher/users`) with CSV import/export, undo delete, bulk group move, sortable table; billing/plans; settings.
- **Student**: dashboard with assignments, solve interface (`/solve/[id]`) with OMR marking, PDF handwriting overlay, timer, auto-submit, draft recovery; result review with wrong-answer filter, question dot-map, keyboard navigation, print, per-question Q&A with the teacher.
- **Analytics**: per-exam trend, score-distribution histogram + median/SD, question correct/wrong rates, discrimination (guarded for small n), concept/label analytics, per-group weakness matrix (Pro), CSV stats export.
- **Sync**: localStorage-first with Supabase mirroring, tombstoned roster sync, offline queue + SyncFlusher.

## 3. Active Workstreams (2026-07-14)

- [ ] **Handoff/transition hardening**: create→distribute→dashboard, submit→review, export/import roundtrip, guest→student merge — error surfacing and latency (in progress).
- [ ] **Management UX round 2**: CSV import dry-run preview with conflict detail, roster pagination, Toast action API + undo unification, bulk-move region policy (in progress).
- [ ] **Analytics round 2**: per-group score comparison (min/median/avg/max), point-biserial discrimination, large-workspace CSV export performance (in progress).
- [ ] **Infra**: Supabase RLS org-scoping audit + draft policies (do NOT enable before beta1 B1–B4 server migration), roster save concurrency improvements (in progress).
- [ ] **UI sweep**: text overflow/truncation, panel spacing, usability pass (queued after the above).
- [ ] **Beta1 selective integration** (separate worktree `../omr_beta1`): port premier0.1_cle server modules to beta1 per `docs/superpowers/specs/2026-07-13-beta1-integration-design.md` (Step 0–1 in progress).
- [ ] **Android/Capacitor shell** (separate session): dev-shell live-reload landed; release pipeline pending.

## 4. Backlog / Future

- [ ] **시험 화면 이탈 판정·경고 완화**
  - [ ] 화면을 벗어난 뒤 2초 안에 복귀하면 이탈 기록에서 제외한다.
  - [ ] `window.blur`와 `document.hidden`이 같은 이탈에서 발생해도 1회만 집계한다.
  - [ ] 2초 이상 이탈은 복귀 시 1회 기록하고, 제출 시 진행 중인 이탈도 2초를 넘겼다면 누락 없이 반영한다.
  - [ ] 첫 이탈은 부드러운 안내로, 2회부터는 단계형 경고로 표시하고 현재의 강한 전면 빨간색 표현을 완화한다.
  - [ ] 학생 안내 문구를 실제 저장 흐름에 맞게 “제출 기록과 함께 선생님 화면에 표시됩니다”로 수정한다.
  - [ ] 교사·분석 화면은 1~2회를 중립적으로 표시하고 3회 이상부터 주의색으로 강조한다.
  - [ ] 학생 리뷰에서는 이탈 횟수를 행동 기록으로만 표시하고 부정행위로 단정하지 않는다.
  - [ ] 2초 미만 제외, 2초 이상 집계, 중복 방지, 학생 경고 단계, 교사 3회 강조를 자동화 테스트로 검증한다.
- [ ] Real per-student authentication (accounts, not name/group).
- [ ] Enable Supabase RLS in production (blocked on beta1 teacher server migration B1–B4).
- [ ] Row-level roster upsert with `updated_at` optimistic concurrency (draft migration exists once infra pass lands).
- [ ] Printable OMR PDF generation / physical OMR scanning (future).
- [ ] Excel export (CSV exists; XLSX pending).
