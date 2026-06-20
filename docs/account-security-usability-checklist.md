# Account, Security, And Usability Checklist

This document tracks the baseline product logic needed before OMR Maker handles real teacher accounts or sensitive student data.

## Current State

- Teacher access now requires a teacher identifier plus password through local/server env credentials.
- Teacher sessions store `teacherId`, `email`, and `displayName` when available, but they are still app-managed browser sessions rather than Supabase Auth sessions.
- Local/server env supports a single teacher via `TEACHER_LOGIN_ID`/`TEACHER_PASSWORD` or multiple teachers via `TEACHER_ACCOUNTS` JSON.
- Teacher login also issues an HttpOnly signed server session cookie so `/teacher/*` and `/create` can be blocked before client hydration.
- Teacher login has an in-process failure limiter keyed by hashed identifier/client fingerprint; this is an interim guard until Supabase Auth or a shared rate-limit store owns it.
- Supabase is currently used for roster/exam/attempt sync only; it is not the source of teacher login credentials yet.
- Supabase sync currently uses the publishable key and alpha RLS policies that are intentionally public read/write.
- `supabase/production-rls.sql` now records the production RLS handoff: authenticated users only, organization membership checks, forced RLS, and no anonymous table access.
- Roster, exam, attempt, and question-result sync now derive an interim `teacher_<hash>` organization/user scope from the active teacher session. Anonymous/no-session flows still fall back to `default` until real organization membership is connected.
- Teacher login can bootstrap matching organization, user profile, organization member, and teacher profile rows through server/service-role code when `SUPABASE_SERVICE_ROLE_KEY` is configured.
- Remote roster/exam/attempt saves still perform client-side bootstrap under the alpha public-policy sync model; production content writes must move away from publishable-key bootstrap before RLS hardening.
- Students use quick entry with name, class, optional student ID/email lookup for same-name cases, and start code. This should remain the default exam-taking path.

## Deployment Login Triage

- If production login says the ID or password is invalid, first check the deployment provider env vars, not Supabase.
- For one teacher, set `TEACHER_LOGIN_ID=admin` and `TEACHER_PASSWORD=<strong password>`; optionally add `TEACHER_NAME` and `TEACHER_EMAIL`.
- For multiple teachers, set `TEACHER_ACCOUNTS` to a JSON array with unique `id` values and per-teacher passwords.
- Add `TEACHER_SESSION_SECRET` so signed route-guard cookies do not depend on a password value.
- Add `SUPABASE_SERVICE_ROLE_KEY` only to server-side deployment env vars if server-side workspace bootstrap is enabled. Never expose it as `NEXT_PUBLIC_*`.
- Redeploy after changing env vars; Next.js server actions read these values from the running deployment.

## Target Rules

- Teachers and staff must use real accounts through Supabase Auth before production use.
- Every teacher-owned row must be scoped by `organization_id`; mutable rows should also carry `created_by_user_id` or an audit actor.
- Staff authorization should come from `omr_organization_members.role`, not from UI state.
- Server-side route guards must use a signed session secret such as `TEACHER_SESSION_SECRET` until Supabase Auth replaces env-backed credentials.
- Login throttling should move to Supabase Auth protections or a shared server store before multi-instance production traffic.
- Students should not need full accounts to take a test. They should enter through assignment links, roster matching, student number, PIN, or start code.
- Same-name students in the same class must remain separate roster profiles and require student ID/email confirmation before their records can merge.
- Public student submission writes should go through server validation or a narrow pending-submission RLS policy.
- Do not store raw passwords in app tables. Supabase Auth owns credentials; app tables store profiles, roles, and metadata only.

## Implementation Order

1. Replace env-backed teacher credential login with Supabase Auth email/password or Google OAuth.
2. On first teacher login, create or join an `omr_organizations` row and an `owner`/`teacher` membership.
3. Replace the interim `teacher_<hash>` app-managed scope with Supabase Auth `auth.uid()` and real `omr_organization_members` rows across exam, roster, material, assignment, attempt, and audit writes.
4. Replace the interim signed-cookie server guards with Supabase Auth session checks, then keep client guards only for UX.
5. Move workspace bootstrap writes from publishable-key client sync to server/service-role code.
6. Apply `supabase/production-rls.sql` after `organization_id`, staff membership, and server-side bootstrap paths are ready.
7. Add staff management for owner/admin invites, suspension, and role changes.
8. Add a pending-review lane for weak student matches and duplicate submissions.

## Usability Checks

- Teacher login shows ID/email and password fields, clear errors, logout, teacher identity, and session expiry.
- A new teacher can create a workspace before seeing empty dashboards.
- Existing class and roster import still works after organization scoping.
- Student quick entry remains under 15 seconds for a rostered student.
- Returning students can recover with a teacher-issued start code without creating an account.
- Print preview stays uncluttered: the A4 print sheet shows only question numbers and choice bubbles, with no subject, score, name, student number, barcode, supervisor box, or footer.

## Production Blockers

- Public Supabase RLS policies must be removed before real student data.
- `supabase/production-rls.sql` must not be applied until all production rows have real `organization_id` values; otherwise the current null/default/interim rows will be hidden by design.
- Env-backed teacher login and signed-cookie guards must be retired or kept only as local development fallbacks once Supabase Auth is connected.
- Service role keys must stay server-only.
- Audit logs are required for roster import/delete, staff role changes, grade overrides, official submission approval/rejection, and data export.
