# Korean Exam Supabase Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Turn the three supplied Korean-language PDFs into private, 45-question language-and-media exams, distribute them to the shared QA class, and seed realistic student attempt, handwriting, feedback, review, and wrong-answer retake states in Supabase.

**Architecture:** A pure ESM fixture core owns stable IDs, answer keys, point maps, exam payloads, attempt/result payloads, feedback, and verification expectations. A small Python PDF normalizer creates 16-page problem PDFs from the supplied A3 source files. A Node runner pulls the deployed Vercel Supabase credentials, uploads the normalized PDFs and handwriting JSON to the private bucket, writes canonical rows through service-role gateways/upserts, and verifies both database and storage state. All writes are idempotent and restricted to rows marked with the fixture owner `korean-exam-sample-v1`.

**Tech Stack:** Node.js ESM, Vitest, Python + pypdf, Supabase JS, Vercel CLI, existing Next.js teacher/student routes.

---

### Task 1: Define and validate the fixture domain

**Files:**

- Create: `src/lib/koreanExamFixture.test.ts`
- Create: `scripts/korean-exam-fixture-core.mjs`

**Step 1: Write failing fixture tests**

Add Vitest cases that require:

- exactly three stable exam IDs and titles;
- 45 questions per exam with answers limited to 1–5;
- ten 3-point and thirty-five 2-point questions per exam, totaling 100;
- group access for `teacher_sharedqa_test_class`;
- normalized page selection `1–12,17–20` and student-facing pages `1–16`;
- student 1 original attempt, returned feedback, and wrong-only retake;
- student 2 original attempt only;
- student 3 and exams 2–3 with no seeded attempts;
- deterministic row IDs and a redacted dry-run summary.

**Step 2: Run the focused test and confirm RED**

Run `npx vitest run src/lib/koreanExamFixture.test.ts`. Confirm it fails because `scripts/korean-exam-fixture-core.mjs` is absent.

**Step 3: Implement the minimal pure fixture core**

Export:

- fixture owner, organization/class/student IDs, and stable exam/attempt/feedback/asset IDs;
- official answer arrays and 3-point question sets for the three exams;
- source PDF descriptors and EBS answer-source URLs;
- `buildKoreanExamFixture({ now })` returning exam rows, question rows, attempts, question results, feedback, and handwriting payloads;
- `validateKoreanExamFixture(fixture)` with hard failures for question counts, answer range, duplicate IDs, score totals, invalid retake linkage, or unexpected student state;
- `summarizeKoreanExamFixture(fixture)` containing no credentials or private object URLs.

The seeded student scenarios use stable timestamps and deliberate wrong/unanswered answers. The retake includes only the original wrong/unanswered question IDs, with a mixture of recovered and still-wrong answers.

**Step 4: Run the focused test and confirm GREEN**

Run `npx vitest run src/lib/koreanExamFixture.test.ts`.

**Step 5: Commit the domain layer**

Commit only the new fixture core and its tests.

### Task 2: Normalize and inspect the three PDFs

**Files:**

- Create: `scripts/normalize-korean-exam-pdfs.py`
- Create: `tmp/pdfs/` intermediate files during execution
- Create: `output/pdf/2025학년도-수능-국어-언어와매체-홀수형.pdf`
- Create: `output/pdf/2026학년도-9월-모평-국어-언어와매체.pdf`
- Create: `output/pdf/2026학년도-수능-국어-언어와매체-홀수형.pdf`

**Step 1: Extend the failing test**

Add a test for the normalizer manifest contract: each output uses zero-based source indexes `0–11,16–19`, has 16 pages, and maps normalized page 13 to original page 17.

**Step 2: Run the focused test and confirm RED**

Run `npx vitest run src/lib/koreanExamFixture.test.ts` and confirm the missing manifest function causes the expected failure.

**Step 3: Implement the normalizer**

Use pypdf to read each source and write only pages 1–12 and 17–20. Refuse sources with fewer than 20 pages, write through `tmp/pdfs`, then atomically replace the final file under `output/pdf`. Support `--verify` to check final page counts and dimensions.

**Step 4: Run the test and create the artifacts**

Run the focused test, then run the normalizer with the bundled workspace Python. Verify all three outputs report 16 pages.

**Step 5: Render and visually inspect**

Render pages 1, 12, 13, and 16 of each output into `tmp/pdfs`. Inspect the images to confirm:

- page 1 is the intended exam cover;
- page 12 closes the common section;
- page 13 starts `언어와 매체` at question 35;
- page 16 contains question 45 and no even-form or speech-and-writing pages;
- no clipping or corruption was introduced.

Clean up the rendered intermediates after inspection.

**Step 6: Commit the normalizer and generated PDFs**

Commit the Python script and the three final PDFs. Do not commit `tmp/pdfs`.

### Task 3: Build the idempotent Supabase fixture runner

**Files:**

- Create: `scripts/setup-korean-exam-fixture.mjs`
- Modify: `src/lib/koreanExamFixture.test.ts`
- Modify: `package.json`

**Step 1: Write failing runner-contract tests**

Test exported helpers for:

- accepting exactly one of `--dry-run`, `--apply`, `--verify`, `--remove`;
- private object paths scoped under `organizations/teacher_sharedqa/...`;
- ownership guards that reject collisions with rows not marked `korean-exam-sample-v1`;
- deduplicating production/preview when they point to the same Supabase URL;
- verification expectations for three exams, 135 questions, three attempts, one returned feedback row, and four private assets.

**Step 2: Run the focused test and confirm RED**

Run `npx vitest run src/lib/koreanExamFixture.test.ts` and confirm the runner module or helpers are missing.

**Step 3: Implement the runner**

The runner must:

- pull production and preview environments into a temporary directory using the linked Vercel project;
- resolve Supabase URL and service-role key without logging either;
- check the shared organization, class, and students exist;
- upload three normalized PDFs and one handwriting JSON to `omr-private-assets` with `upsert: true`;
- upsert remote asset metadata, three exam rows, 135 question rows, three attempt rows, their result rows, and one returned feedback row;
- delete stale fixture-owned question-result rows before replacing an attempt, without touching non-fixture rows;
- keep all payloads compatible with current exam/attempt/feedback hydration;
- implement `--verify` by checking exact IDs/counts, score math, access groups, storage object existence, feedback status, and retake linkage;
- implement `--remove` in child-to-parent order and only after ownership checks;
- print redacted summaries only.

Add package scripts `exams:korean:dry-run`, `exams:korean:apply`, `exams:korean:verify`, and `exams:korean:remove`.

**Step 4: Run tests and lint the new files**

Run the focused test, then ESLint on the new test and Node modules.

**Step 5: Commit the runner**

Commit the runner, tests, and package script changes.

### Task 4: Dry-run, apply, and verify the live fixture

**Files:**

- No source changes expected

**Step 1: Verify prerequisite accounts**

Run `npm run accounts:deploy:verify` and confirm the shared organization, `테스트반`, and all three student profiles exist.

**Step 2: Run the redacted dry-run**

Run `npm run exams:korean:dry-run`. Confirm it lists three exams, three attempts, one feedback item, and four assets without credentials or signed URLs.

**Step 3: Apply to Supabase**

Run `npm run exams:korean:apply`. This is an authorized external write to the shared QA workspace.

**Step 4: Verify idempotency**

Run `npm run exams:korean:apply` a second time, then `npm run exams:korean:verify`. Confirm counts do not grow and all IDs/relationships remain stable.

### Task 5: Verify teacher and student workflows in the deployed app

**Files:**

- Create: `e2e/korean-exam-fixture.spec.ts`

**Step 1: Write the browser smoke test**

Using existing login helpers, verify:

- teacher 1 can see all three distributed exam titles and open the seeded exam detail;
- student 1 sees the returned review and completed wrong-only retake;
- student 2 sees the original result and can reach the retake initiation path;
- student 3 sees all three fresh distributed exams and can enter the first exam’s solving/handwriting view.

**Step 2: Run and confirm RED if fixture routes/selectors differ**

Run only `e2e/korean-exam-fixture.spec.ts` against the deployed URL. Treat missing data or a broken route as a real failure; adjust only selectors that differ from accessible UI labels.

**Step 3: Make only necessary fixture or test corrections**

If the app exposes a hydration incompatibility, first add a focused fixture-core regression test, confirm RED, then correct the payload and re-apply. Do not modify unrelated dashboard UI.

**Step 4: Re-run the smoke test and capture evidence**

Run the smoke test to GREEN and preserve Playwright screenshots/traces only when a failure needs diagnosis.

**Step 5: Commit the browser verification**

Commit the new E2E test and any tested fixture compatibility correction.

### Task 6: Evaluate the elements and finish verification

**Files:**

- Create: `docs/korean-exam-fixture-evaluation.md`

**Step 1: Write the evaluation report**

Document each workflow element—teacher creation, distribution, student access, handwriting, grading/review, wrong-answer retake—with:

- implemented sample state;
- live verification evidence;
- pass/partial/fail result;
- current limitation and recommended follow-up when applicable.

Include the stable exam IDs, private artifact filenames, source provenance links, and safe instructions for re-running dry-run/apply/verify/remove. Link to the existing deployment test-account document rather than duplicating credentials.

**Step 2: Run full verification**

Run:

- `npx vitest run src/lib/koreanExamFixture.test.ts`
- relevant existing persistence/gateway tests;
- ESLint on all new files;
- `npm run build`;
- `npm run exams:korean:verify`;
- the focused deployed Playwright test.

**Step 3: Inspect the worktree and commit**

Confirm only fixture-related files are staged. Preserve all unrelated user changes. Commit the evaluation report and any final fixture-only adjustments.

**Step 4: Finish the branch**

Use `superpowers:verification-before-completion` and `superpowers:finishing-a-development-branch`. Report the live result, exact verification outcomes, artifact links, evaluation document, and any residual limitations.
