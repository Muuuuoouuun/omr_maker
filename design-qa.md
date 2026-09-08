# Design QA — `09_win1` 프론트 디자인 이식

- Target branch: `09_win1` at `c1964af` (tracks `origin/09_win1`)
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

- ESLint passed for the three changed TSX files.
- TypeScript passed after installing the branch's exact lockfile dependencies.
- Next.js production build passed, including route-performance budgets.
- Focused UI and text-encoding contract tests passed: 2 files, 97 tests.
- The full suite currently has seven unrelated baseline/environment-sensitive failures: four localStorage harness failures, two expired pilot-envelope expectations, and one competing operator-process expectation. None touch the changed UI files.

## Visual verification

- Source references and implementation targets are resolved.
- Fresh implementation screenshots and interaction evidence are pending because the local Mac is locked and the in-app browser cannot be observed.
- No visual fidelity claim is made until the Mac is unlocked and desktop/mobile captures are compared with the source images.

## Findings

1. P0 blocked — visual comparison and primary interaction verification cannot run while the Mac remains locked.
2. No code-level P0, P1, or P2 finding is present in lint, TypeScript, focused surface tests, production compilation, or route-performance verification.

final result: blocked
