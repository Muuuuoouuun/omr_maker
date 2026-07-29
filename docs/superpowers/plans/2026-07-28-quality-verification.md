# Service Quality Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce fresh, reproducible evidence that the service average is at least 84, every area is at least 80, and UI/UX is at least 85.

**Architecture:** Run local and database gates from a clean install, capture representative rendered surfaces, then dispatch independent score reviewers who cannot edit the code. Treat missing external evidence as incomplete rather than awarding inferred points.

**Tech Stack:** npm, Vitest, Playwright, PostgreSQL/Supabase verifier, independent subagents

---

### Task 1: Run the clean local release matrix

**Files:**
- Create: `docs/quality/service-quality-84-evidence.md`

- [ ] **Step 1: Start from a clean dependency graph**

Run:

```bash
npm ci
npm ls next postcss sharp
npm audit --omit=dev --audit-level=high
```

Expected: declared versions resolve once and audit exits 0.

- [ ] **Step 2: Run static and unit gates**

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Expected: every command exits 0 with no failed test.

- [ ] **Step 3: Run browser and PWA gates**

```bash
npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=webkit
npm run test:e2e -- --project=webkit-ipad
npm run test:pwa:prod
```

Expected: all required projects pass; intentional fixture-dependent skips are listed with reasons.

- [ ] **Step 4: Record exact evidence**

Create the evidence document with command, timestamp, commit SHA, exit code, pass/fail/skip counts, and artifact paths. Do not write “passed” without the fresh output.

- [ ] **Step 5: Commit**

```bash
git add docs/quality/service-quality-84-evidence.md
git commit -m "docs: record service quality release evidence"
```

### Task 2: Run the database security matrix

**Files:**
- Modify: `docs/quality/service-quality-84-evidence.md`

- [ ] **Step 1: Run live PostgreSQL assertions**

```bash
npm run test:supabase:live
```

Expected: schema, migrations, server-only RLS, negative privilege assertions, and readiness v4 all pass.

- [ ] **Step 2: Record privilege evidence**

Record:

```text
anon canonical read/write: denied
authenticated canonical read/write: denied
service_role scoped RPC: allowed
cross-organization access: denied
null/orphan/cross-org preflight counts: 0
```

- [ ] **Step 3: Commit**

```bash
git add docs/quality/service-quality-84-evidence.md
git commit -m "docs: record database boundary evidence"
```

### Task 3: Capture UI/UX representative surfaces

**Files:**
- Create: `docs/quality/ui-ux-85-review.md`
- Create: `docs/quality/screenshots/teacher-dashboard-desktop.png`
- Create: `docs/quality/screenshots/create-mobile.png`
- Create: `docs/quality/screenshots/solve-tablet.png`
- Create: `docs/quality/screenshots/review-mobile.png`

- [ ] **Step 1: Capture the four required journeys**

Use Playwright at desktop 1440×900, mobile 390×844, and tablet portrait/landscape. Capture the teacher dashboard, exam creation primary action, student solve rail, and result review receipt.

- [ ] **Step 2: Score the visual contract**

Score:

```text
visual hierarchy /25 (minimum 22)
emphasis and task efficiency /25 (minimum 22)
spacing and responsive rhythm /25 (minimum 21)
motion and state feedback /25 (minimum 20)
total /100 (minimum 85)
```

Every deduction references a screenshot and DOM/CSS evidence.

- [ ] **Step 3: Verify accessibility interaction**

Run keyboard-only upload/dialog flows, 200% zoom, and reduced-motion. Record focus order, overflow, touch target, and motion results.

- [ ] **Step 4: Commit**

```bash
git add docs/quality/ui-ux-85-review.md docs/quality/screenshots
git commit -m "docs: capture UI UX 85 review evidence"
```

### Task 4: Dispatch independent final scoring

**Files:**
- Create: `docs/quality/service-quality-84-scorecard.md`

- [ ] **Step 1: Dispatch three read-only reviewers**

Assign independent reviewers:

```text
Reviewer A: product completeness + teacher/student workflows
Reviewer B: UI/UX + accessibility/PWA
Reviewer C: engineering quality + security/operations
```

Each uses the original six-area rubric and receives the evidence documents plus current source. Reviewers may run read-only checks but cannot edit.

- [ ] **Step 2: Reconcile evidence, not opinions**

For score disagreements above 3 points, require both reviewers to cite the exact contradictory evidence. The root reviewer selects the score supported by runtime or privilege evidence.

- [ ] **Step 3: Write the final scorecard**

Include six scores, arithmetic average, minimum, UI/UX subscore, commands, external limitations, and unresolved risks.

- [ ] **Step 4: Apply the completion gate**

Complete only when:

```ts
average(scores) >= 84
Math.min(...scores) >= 80
uiUxScore >= 85
```

If any condition is false or evidence is missing, return to the corresponding implementation plan.

- [ ] **Step 5: Commit**

```bash
git add docs/quality/service-quality-84-scorecard.md
git commit -m "docs: publish independent service quality scorecard"
```
