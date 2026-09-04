# Design QA — 홈 및 교사 대시보드 UI 개선

- Home reference: `/Users/clmagi/Desktop/Projects/omr_maker/public/design-concepts/omr-home-concept-c-learning-coach.png`
- Dashboard reference: `/Users/clmagi/.codex/generated_images/01a060ce-9c07-7bb2-a7e4-c28feecbc413/exec-61405696-b361-4d6a-9e55-13a1a47b6b90.png`
- Generated home backdrop: `/Users/clmagi/Desktop/Projects/omr_maker/public/assets/omr-home-learning-coach-bg-v2.png`
- Home implementation capture: `/tmp/omr-home-final-desktop.png`
- Dashboard implementation capture: `/tmp/omr-dashboard-final.png`
- Mobile home capture: `/tmp/omr-home-final-mobile.png`
- Mobile dashboard capture: `/tmp/omr-dashboard-mobile.png`
- Desktop viewport: 1672 × 941 CSS px
- Mobile viewport: 390 × 844 CSS px
- State: light theme, role selection home, demo teacher overview

## Reference comparison

### Home

- Rebuilt the first fold around the selected learning-coach reference: centered brand mark, compact eyebrow, oversized blue-violet title, one-line supporting copy, and two large role cards.
- Generated a dedicated text-free decorative backdrop from the supplied reference. The pale lavender arc, OMR bubble motif, teal accent, and pink/violet ribbon fields are now a responsive presentation layer beneath semantic HTML controls.
- At 1672 × 941, the role cards begin at 513 px versus roughly 514 px in the reference, and render at 589 × 386 px; the title width, hero rhythm, icon blocks, card radii, and CTA hierarchy were tuned against a side-by-side capture.
- Existing student and teacher login behavior remains live. Only the role-selection state is locked to the reference's light visual treatment; login states retain the application's theme control.

### Teacher dashboard

- Matched the editorial reference structure: persistent left navigation, simple dashboard heading, top-right create CTA, four KPI cards, a dominant analysis chart, and a compact recent-exams panel.
- Replaced the single-series trend chart with a functional score-line and participation-bar comparison sourced from existing demo data.
- Kept the existing exam/student analytics routes, data synchronization UI, search, session, notification, export, and detailed panels available.

## Responsive and interaction evidence

- Home teacher role card opened the teacher login form (`data-home-role="teacher"`) and returned successfully to role selection (`data-home-role="none"`).
- Mobile dashboard `시험별 분석` tab changed `aria-selected` to `true` and updated the URL to `?tab=exam&showcase=1`; `개요` returned to overview.
- At 390 px, home and dashboard document widths remained within the viewport with no horizontal overflow.
- Desktop and mobile captures showed no active Next.js error overlay; browser logs contained no error or warning entries.

## Verification

- ESLint: passed for the four changed TypeScript/TSX files.
- TypeScript (`tsc --noEmit`): passed.
- Vitest: 140 files, 1059 tests passed.
- Next.js production build: passed; all 16 static/dynamic routes compiled.
- `git diff --check`: passed for the implementation files.

## Findings

1. P1 fixed — the first backdrop pass plus opaque cards hid the reference's colored ribbon movement. The final cards use a scoped translucent surface and mild blur so the generated pink/violet fields remain visible without reducing text contrast.
2. P1 fixed — the initial desktop composition exceeded the 941 px viewport. Hero spacing, card intrinsic height, and container padding were tuned to fit exactly without vertical or horizontal overflow.
3. P2 fixed — the mobile composition was separately checked at 390 × 844; the two role choices remain side by side, CTA targets stay full width, and no horizontal overflow occurs.
4. P1 fixed — initial sidebar layout inherited the shared column direction and moved dashboard content below the fold. A late, scoped dashboard shell rule now keeps sidebar and workspace in one row on desktop.
5. P2 fixed — the original mockup density buried the primary chart and recent exams among secondary analysis panels. The first fold now reflects the selected hierarchy; detailed tables remain below.
6. No actionable P0, P1, or P2 findings remain in the requested home and teacher dashboard surfaces.

final result: passed
