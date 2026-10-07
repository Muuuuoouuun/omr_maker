# Student Direct Login Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Follow the approved student direct-login design and verify authentication behavior before reporting completion.

**Goal:** Let teacher-provisioned students log in without an exam invitation and reach their existing exam list.

**Architecture:** Resolve the existing canonical student ID on the server and verify the existing credential before reading class enrollment. Reuse signed sessions and guest claim handling. A small form handles credentials and authenticated class selection.

**Tech Stack:** Next.js server actions, React, Supabase service-role queries, Vitest, Playwright.

## Task 1: Server credential and class gateway

- [x] Write `src/lib/studentDirectLoginGateway.server.test.ts` for a verified single-class identity, generic credential failures, credential revocation, active scoped enrollment, multiple classes, query bounds, and service errors; run `npx vitest run src/lib/studentDirectLoginGateway.server.test.ts` and observe missing gateway failures.
- [x] Implement `src/lib/studentDirectLoginGateway.server.ts`. Export `resolveDirectStudentLogin(client, { studentId, startCode, groupId? })`; return `verified` with server-only credential identity and selected class, `group_required` with safe class choices, `invalid_credentials`, or `service_unavailable`. Use exact ID lookup, current credential verifier, generation validation, and organization-scoped active enrollment/class queries capped at `INITIAL_OPERATIONS_LIMITS.classes + 1`.
- [x] Run gateway and existing verifier tests; review spec compliance, then code quality.

## Task 2: Session action and UI

- [x] Write behavioral tests for `loginStudentWithStartCode` in `src/lib/studentDirectLoginAction.test.ts`; exercise same-origin, pre-query durable rate limiting, unavailable storage, authenticated class selection, safe signed-session result, and guest claim preservation. Run the file to verify failure before the action exists.
- [x] Add the action in `src/app/actions/studentSession.ts`; extract its existing verified-session finalization into a shared helper used by invitation and direct login. Keep organization/account/generation private.
- [x] Write rendered tests for `src/components/StudentDirectLoginForm.tsx`; empty and wrong credentials, pending state, authenticated class selection and continuation are the required behaviors. Run `npx vitest run src/components/StudentDirectLoginForm.test.tsx` before implementing the component.
- [x] Integrate the form in `src/app/page.tsx`, replace recovery-only direct entry, and change student dashboard account connection and missing-session guidance to direct login. Update obsolete recovery surface expectations.
- [x] Run relevant authentication, invite, credential, recovery, guest ownership and dashboard tests.

## Task 3: Documentation and validation

- [x] Explain teacher-issued direct login in `README.md` and teacher credential download guidance. Preserve the CSV format and secret-handling rules.
- [x] Run `npx eslint` on changed code, `npx tsc --noEmit`, focused Vitest tests, and `npm run build`.
- [x] Validate rendered form, credential failure, responsive layout, console health and navigation with Playwright. Save temporary screenshots outside the repository.
- [x] Review final diff against the spec and fix material findings. Report the implemented behavior and the validation limits without claiming live deployment verification.

## Validation results

- New gateway: 52 behavioral tests, including credential/status transitions and scoped enrollment rejection.
- New action, form and Home tests cover same-origin admission, cookie privacy, guest claims, class selection and navigation.
- Full suite: 4,041 passed; three unchanged baseline failures reproduced in the original checkout (`effectiveWorkspacePlanGateway`, `teacherAccountGateway`, `operatorProvisioningCli`) use dated teacher/plan provisioning fixtures.
- Scoped ESLint, TypeScript, production build, and route performance budgets passed.
- Production browser validation on `http://localhost:3103`: desktop 1280×900 and mobile 390×844 direct entry, empty-input error, missing-session login navigation, no application console errors, and no horizontal overflow; all three Playwright tests passed. Browser plugin was unavailable, so regular Playwright was used.
- No live database or deployment login was exercised. Server authentication behavior is covered by gateway/action tests; signed session restoration and existing invite/guest checks remain covered by the regression suite.

Final quality review approved after fixing the authenticated class-selection limiter boundary, with a regression using the real limiter implementation. Reviewed changes were applied to the original checkout at the same base commit.

## Current-base integration verification (2026-10-07)

Ported the original completed change onto integration base 899aa833, preserving the newer registered identityType, durable limiter service-error distinction, canonical guest name, demo entitlement checks, guest claim ownership, signed-session restoration and expired-session recheck. Returning-device hints continue to store only name/class; neither canonical ID nor start code is stored in that hint.

The direct entry uses the same credential verifier and session-validation RPC as invited entry. It returns class choices only after credential validation and revalidates credentials/enrollment on selection. Existing identity, organization, enrollment and student data permissions are unchanged. No database migration, credential creation or live account operation is required.

Local verification: 4,496 unit tests passed; lint, TypeScript, production build and nine route budgets passed. Production Chromium/WebKit security and direct-entry checks passed, including unavailable-backend denial with no student cookie or stored start code. Existing invitation, roster, expiry and opt-in hint browser regressions passed after correcting the fresh-entry button expectation; collapsed guest entry and strict 320/390px viewport bounds remain asserted. These are isolated synthetic checks, not live-account or deployment verification.

Hosted follow-up found two PWA cases in all three WebKit app projects still expecting the removed bare-login name input. Update those cases to assert the canonical ID/password inputs while preserving actual guest navigation, standalone/install proof, touch targets, minimum 16px input text and overflow checks. All six corrected cases passed locally without retries, and 132 PWA/UI/workflow contract tests passed. The initial hosted main PWA suite failed on those selectors while its separate ten strict readiness repetitions passed; test thresholds and retry settings were unchanged.
