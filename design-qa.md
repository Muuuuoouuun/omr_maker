# Design QA — `09_win1` 프론트 디자인 이식

- Target branch: `09_win1` (visual port baseline `8de8100`)
- Home source visual: `2608.cle:public/design-concepts/omr-home-concept-c-learning-coach.png`
- Dashboard source visual: `/Users/clmagi/.codex/generated_images/01a060ce-9c07-7bb2-a7e4-c28feecbc413/exec-61405696-b361-4d6a-9e55-13a1a47b6b90.png`
- Runtime backdrop: `public/assets/omr-home-learning-coach-bg-v2.png`
- Intended desktop viewport: 1672 × 941 CSS px
- Intended mobile viewport: 390 × 844 CSS px

## Port boundary

- Ported only the visual hierarchy for the role-selection home and teacher dashboard.
- Preserved the latest branch's authentication, account lifecycle, canonical cache, degraded read-only states, assignment generations, analytics snapshots, server actions, and release tooling.
- No Supabase migration, persistence gateway, entitlement, billing, or security logic was copied from `2608.cle`.

## Automated verification

- ESLint passed for the complete repository.
- TypeScript passed with `npx tsc --noEmit`.
- Next.js production build passed, including route-performance budgets.
- The complete Vitest suite passed: 392 files, 3,978 tests.
- Node 25's process-level Web Storage is disabled only inside Vitest workers so jsdom keeps its complete `localStorage` implementation.
- The billing hydration Playwright scenario is committed, but the repository-managed Chromium could not launch locally because its headless-shell binary is not installed. The same provider/details/annual-price flow passed in the connected system Chrome without installing new browser dependencies.

## Visual verification

- Source references and implementation targets are resolved and were compared at the same 1672 × 941 desktop viewport.
- The home page keeps the reference composition: centered brand/hero, 1220px two-card role grid, matching soft gradient backdrop, and a fully visible first viewport with no page overflow.
- The teacher dashboard keeps the reference hierarchy: fixed navigation rail, page title and summary, four KPI cards, primary trend analysis, and recent exam actions.
- At 390 × 844, the role cards remain usable side by side, dashboard KPIs form a stable 2 × 2 grid, values stay on one line, and overview/exam/student views have no horizontal page overflow.
- Fresh reload produced no application warning or error logs. The two earlier Recharts zero-size warnings did not reproduce after the layout patch and clean reload.

## Final evidence score

| Category | Score | Evidence |
| --- | ---: | --- |
| Visual fidelity | 23/25 | Same-viewport rendered comparison confirms the reference hierarchy, scale, spacing, palette, card treatment, and first-fold composition. |
| Task clarity and information architecture | 19/20 | Role cards state the outcome; dashboard navigation and tab-specific headings preserve location context. |
| Responsive structure | 14/15 | Desktop and 390px mobile captures have no page-level horizontal overflow; KPI values and analysis controls remain readable. |
| Interaction usability | 14/15 | Keyboard role selection and demo entry work; overview, exam, and student tabs update both pressed state and URL. |
| Accessibility | 14/15 | Native controls, visible focus, skip link, chart data summaries, readable labels, and reduced-motion support are present. |
| Build and regression safety | 10/10 | Lint, TypeScript, production build, route budgets and all 3,978 Vitest tests pass. |
| **Final total** | **94/100** | The implementation clears the 90-point target with rendered, responsive, interaction, and automated evidence. |

## Audit improvements completed

1. Real-account dashboard headings follow the selected view; showcase analysis subviews retain their dedicated analysis landmark and section headings.
2. KPI cards restore their intended individual borders and remove the old shared strip border.
3. Dashboard sidebar can scroll on short desktop viewports without hiding account controls.
4. Chart containers expose the visible data as meaningful accessible image labels.
5. Home role cards now keep valid button content semantics while preserving the visual hierarchy.
6. The repeated secondary “최근 시험” title is clarified as “시험 운영 현황” to distinguish detail from the quick list.

## Findings

1. No open P0 or P1 design/usability issue remains on the audited home → teacher demo → overview → exam analysis → student analysis journey.
2. P2 accepted — dense exam-analysis sub-tabs use an explicit horizontal scroll region on narrow mobile screens instead of compressing labels below a usable size.
3. P2 accepted — the teacher login demo CTA is below the initial 390 × 844 fold, while the primary credential login action remains above it and the page scroll is clear.
4. No code-level P0, P1, or P2 regression is present in lint, TypeScript, focused surface tests, production compilation, or route-performance verification.
5. P2 environment note — the repository-managed Playwright Chromium binary is absent locally; the system Chrome path covered the target interaction loop and the checked-in hydration spec remains ready for CI.

## Interaction evidence

1. Keyboard focus order: home link → student role → teacher role; Enter opens the teacher portal.
2. Keyboard activation: “데모 계정으로 둘러보기” enters `/teacher/dashboard?showcase=1`.
3. Mobile overview: four KPI values remain single-line in a 2 × 2 grid.
4. Exam analysis: selected state and URL become `tab=exam`; page width remains equal to its client width.
5. Student analysis: selected state and URL become `tab=student`; filters and trend content render without page overflow.
6. Console: clean reload and all audited tab transitions produced zero new warnings or errors.
7. Billing hydration: provider status remains visible after hydration, operations details expand, and the annual toggle renders `₩182,400` with zero console warnings or errors.

final result: passed
