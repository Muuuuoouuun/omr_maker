# Draft migrations — NOT YET APPLIED

Everything in this directory is a **draft**. Nothing here has been run against
any Supabase project, and nothing here is wired into an automatic migration
pipeline (this repo has none — `schema.sql` / `production-rls.sql` are applied
manually via the Supabase SQL Editor, per `supabase/README.md`). Files are
named `*.draft.sql` specifically so they are never mistaken for something to
paste-and-run as part of the normal `schema.sql` → `production-rls.sql`
sequence.

Do **not** apply any file in this directory to a production project without
re-reading its header comment and satisfying its stated prerequisites.

## Sequencing relative to `production-rls.sql`

`supabase/production-rls.sql` is itself already a (fairly complete) draft —
its own header says "apply this only after Supabase Auth, organization_id
backfill, and staff membership bootstrap are ready." This directory exists
for two things that draft doesn't cover yet:

1. **`0001_roster_class_students_updated_at.draft.sql`** — a schema addition
   (not a policy change) needed before client-side roster saves can do real
   optimistic-concurrency conflict detection. See that file's header and
   `src/lib/rosterPersistence.ts` for the current (non-schema-dependent)
   mitigation already in place.

2. **`0002_organization_id_not_null_readiness_gate.draft.sql`** — a
   verification + constraint script for the "every production row has a
   non-null `organization_id`" precondition that `production-rls.sql`'s
   header already calls out but never actually checks or enforces in SQL.

## Known blocker `production-rls.sql` does not mention

`production-rls.sql`'s policies gate every table behind `to authenticated`
plus `auth.uid()` (via `omr_current_user_id()`). **The app never establishes
a real Supabase Auth session** — `src/lib/omrPersistence.ts` and
`src/lib/rosterPersistence.ts` create their Supabase client with
`persistSession: false` / `autoRefreshToken: false` and there is no
`supabase.auth.signInWithPassword` (or any other `supabase.auth.signIn*`)
call anywhere in the codebase. Teacher identity comes from a custom
HMAC-signed cookie (`src/lib/teacherServerSession.ts`), and student identity
from a separate signed cookie (`src/lib/studentServerSession.ts`) — neither
is a Supabase Auth session, so `auth.uid()` is `NULL` for every request the
app makes today, including the ones currently reading/writing through the
publishable/anon key in `omrPersistence.ts`/`rosterPersistence.ts`.

Applying `production-rls.sql` as-is today would not "tighten" access — it
would **break every teacher-side client read/write**, because every
`to authenticated using (... omr_is_org_member(organization_id) ...)` policy
would evaluate against a `NULL` `auth.uid()` and deny all rows, and
`revoke all ... from anon` already blocks the unauthenticated fallback. This
is the "server-path migration (teacher B1–B4)" referenced elsewhere: teacher
writes need to move to trusted server actions using the service-role client
(`src/lib/supabaseServerAdmin.ts`), the same pattern `src/app/actions/studentExam.ts`
already uses for the student solve/submit path, before `production-rls.sql`
can be turned on without an outage. No SQL fix belongs here for that — it's
an application-code sequencing problem, not a schema/policy one.
