# OMR Maker Project Task Plan

> Last refreshed: 2026-07-14. Earlier revisions of this file described the pre-MVP plan;
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

- [ ] Real per-student authentication (accounts, not name/group).
- [ ] Enable Supabase RLS in production (blocked on beta1 teacher server migration B1–B4).
- [ ] Row-level roster upsert with `updated_at` optimistic concurrency (draft migration exists once infra pass lands).
- [ ] Printable OMR PDF generation / physical OMR scanning (future).
- [ ] Excel export (CSV exists; XLSX pending).
