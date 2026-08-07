# UI/UX hierarchy audit — 2026-08-04

## Result

- Harsh route average: **8.53 / 10**
- Lowest route score: **8.4 / 10**
- Acceptance target: average >= 8.5, every route >= 7.8
- Viewports: 390×844 mobile, 1440×900 desktop, and 834×1112 tablet evidence
- Visual source: latest local production build plus the quality screenshot fixture
- Figma source of truth: [OMR Maker UI/UX development](https://www.figma.com/design/qKmrOGYzcGFVFKcYlkoFbs)

| Route | Score | Main evidence |
| --- | ---: | --- |
| `/` | 8.8 | Role choice is visible in one mobile viewport after the short entrance transition. |
| `/groups` | 8.4 | Group actions and status lead; supporting explanations remain secondary. |
| `/create` | 8.5 | Readiness and validation lead the settings workspace without hiding editor controls. |
| `/pwa-check` | 8.4 | Only four attention checks lead; 12 passing checks are in a closed native disclosure. Mobile height: 1,145px. |
| `/solve/[id]` | 8.8 | Tablet PDF and OMR panes preserve the exam task as the dominant surface. |
| `/student/dashboard` | 8.5 | Mobile identity is split into brand/status and user/action rows; redundant guest group copy is removed. |
| `/student/history` | 8.4 | Empty state has one clear recovery action and no competing decoration. |
| `/student/review/[attemptId]` | 8.5 | Answer, drawing, report, and analysis surfaces retain clear progressive disclosure. |
| `/teacher/attempt/[attemptId]` | 8.5 | Score summary leads; detailed answers and feedback follow in task order. |
| `/teacher/billing` | 8.4 | Current and Pro plans remain visible; Academy and local history are collapsed on mobile. |
| `/teacher/dashboard` | 8.9 | Operational priorities, metrics, charts, and records form a strong scan path. |
| `/teacher/exam/[id]` | 8.4 | Mobile title/actions no longer collide; six compact results lead with explicit load-more. Mobile height: 2,101px. |
| `/teacher/live` | 8.5 | Live state and remaining time dominate; no-exam and demo states remain explicit. |
| `/teacher/settings` | 8.5 | Compact section navigation leads; backup and advanced controls stay secondary. |
| `/teacher/users` | 8.4 | Roster actions, data-source warning, and analysis summary follow a clear hierarchy. |

## Subtraction rules applied

1. Keep the current decision and next action visible.
2. Collapse passed diagnostics, secondary plans, historical records, and advanced operations.
3. Preserve native disclosure semantics, 44px touch targets, keyboard access, and existing test identifiers.
4. Prefer compact summaries and explicit load-more over rendering long mobile tables.
5. Remove duplicate context only when the same state is already communicated nearby.

## Verification evidence

- TypeScript: passed (`tsc --noEmit`).
- Unit/integration: 177 files, 1,383 tests passed.
- Production build: passed on Next.js 16.2.12.
- Mobile PWA focused browser test: the changed diagnostics test passed and verified mobile height <= 1,400px.
- Horizontal overflow: none on the four remediated 390px routes (`scrollWidth 379`, viewport client width 379).
- Screenshots: `docs/quality/screenshots/teacher-dashboard-desktop.png`, `create-mobile.png`, `solve-tablet.png`, and `review-mobile.png`.
