# Student Handwriting Upload Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve an officially submitted student's failed premium-handwriting upload locally and expose a private, bounded, explicit retry flow that survives app restart.

**Architecture:** A focused client recovery module owns the versioned manifest, owner fingerprint, TTL/size validation, cleanup, and coalesced retry runner. The solve page creates recovery state only after an immutable server receipt; a small review-page component restores the exact attempt for the current owner and calls the unchanged server action/gateway boundary.

**Tech Stack:** Next.js App Router, React, TypeScript, IndexedDB blob store, localStorage, Vitest, Playwright/in-app Browser.

---

### Task 1: Recovery manifest and retry runner

**Files:**
- Create: `src/lib/studentHandwritingUploadRecovery.ts`
- Create: `src/lib/studentHandwritingUploadRecovery.test.ts`

- [x] **Step 1: Write failing schema and privacy tests**

Test a v1 manifest with `attemptId`, `sessionId`, SHA-256 `ownerFingerprint`, IndexedDB ref, `createdAt`, `expiresAt`, `retryCount`, `nextRetryAt`, and sanitized `failureCategory`. Assert raw drawings, tickets, names, answers, oversized refs, expired records, and mismatched owners are rejected and cleaned.

- [x] **Step 2: Run the focused test and observe RED**

Run: `npx vitest run src/lib/studentHandwritingUploadRecovery.test.ts`

Expected: FAIL because the recovery module does not exist.

- [x] **Step 3: Implement minimal manifest helpers**

Export constants for seven-day TTL, 10 MiB maximum source bytes, three attempts, and delays `[0, 750, 2000]`; export owner fingerprinting, key construction, read/write/clear helpers with injected Storage, and a sanitizer that stores only `service_unavailable`, `invalid_ticket`, `invalid_asset`, or `source_unavailable`.

- [x] **Step 4: Write failing retry tests**

Assert one explicit retry performs no more than three attempts, applies only the fixed delays, stops the current click on blocked authentication or terminal asset statuses, preserves authentication failures, and coalesces two simultaneous calls for one attempt.

- [x] **Step 5: Implement and verify the retry runner**

Use a module-level `Map<string, Promise<Result>>`, injected `wait(ms)`, and `finally` cleanup. Run the focused suite and expect PASS.

### Task 2: Official-confirmation integration

**Files:**
- Modify: `src/app/solve/[id]/page.tsx`
- Modify: `src/lib/submissionReliabilitySurface.test.ts`

- [x] **Step 1: Write a failing surface contract**

Assert recovery persistence occurs after `result.status === "submitted"`, before the first handwriting upload, and only for a persisted IndexedDB ref. Assert draft keys remain on failure and recovery data is cleared on success.

- [x] **Step 2: Run the surface test and observe RED**

Run: `npx vitest run src/lib/submissionReliabilitySurface.test.ts`

Expected: FAIL because no handwriting recovery manifest is created.

- [x] **Step 3: Implement the smallest solve integration**

Persist `activeDrawings` to deterministic `attempt:<attemptId>:handwriting-upload-source`, create the manifest from the current owner fingerprint and submitted session, execute the first upload through the bounded runner, and clear the recovery source only after `uploaded`. Keep the existing draft on all failures.

- [x] **Step 4: Run the focused tests and expect PASS**

Run the recovery and submission reliability suites together.

### Task 3: Review recovery card

**Files:**
- Create: `src/components/student/HandwritingUploadRecoveryCard.tsx`
- Create: `src/lib/studentHandwritingUploadRecoverySurface.test.ts`
- Modify: `src/app/student/review/[attemptId]/page.tsx`
- Modify: `src/app/globals.css`

- [x] **Step 1: Write failing UI contracts**

Assert the review page mounts the card for the exact attempt, derives the current owner fingerprint, loads the source from IndexedDB, invokes the existing `uploadStudentAttemptHandwriting` action, exposes pending/waiting/uploading/succeeded/failed live text, disables duplicate clicks, and reloads the authoritative attempt after success.

- [x] **Step 2: Run the UI contract and observe RED**

Run: `npx vitest run src/lib/studentHandwritingUploadRecoverySurface.test.ts`

Expected: FAIL because the card does not exist.

- [x] **Step 3: Implement the card and responsive styles**

Render a compact recovery card with an `aria-live="polite"` status, a 44 px minimum retry button, full-width mobile layout, wrapping Korean copy, and tablet-safe grid placement. Hide it for missing/expired/mismatched manifests, preserve session/auth failures, and clear invalid sources without uploading.

- [x] **Step 4: Run all focused tests and expect PASS**

Run the three focused suites plus the existing gateway and UI surface suites.

### Task 4: Verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-07-student-handwriting-upload-recovery.md` (check completed steps only)

- [x] **Step 1: Run lint, TypeScript, and production build**

Run targeted ESLint, `npx tsc --noEmit`, and `npm run build`. Record unrelated concurrent failures without editing their files.

- [x] **Step 2: Run the full Vitest suite**

Run: `npm test`

Expected: all tests pass.

- [x] **Step 3: Render phone and tablet UX**

Use the in-app Browser against the local app, checking page identity, meaningful DOM, framework overlay, console health, 390x844 and 820x1180 layouts, screenshot evidence, and retry interaction state.

- [ ] **Step 4: Check worktree integrity**

Run `git diff --check` and report changed files, server/live limitations, and remaining risk. Do not stage or commit.
