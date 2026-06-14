# Supabase setup

1. In Supabase, open SQL Editor and run `supabase/schema.sql`.
2. Create `.env.local` in the project root:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://wqhiajvisirxdjivhmlt.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_full_key_here
```

3. Restart the Next.js dev server after changing `.env.local`.

The app keeps localStorage as a fallback. When Supabase is configured, exams and attempts are synced to:

- `public.omr_organizations`
- `public.omr_organization_members`
- `public.omr_classes`
- `public.omr_exams`
- `public.omr_attempts`
- `public.omr_audit_logs`

## Alpha data model

The schema now includes organization and class columns on exams and attempts so the app can grow from a single-teacher alpha into Academy-style workspaces:

- `organization_id` separates academy, school, or teacher-owned data.
- `class_id` links exams and attempts to a roster/class context.
- `omr_organization_members` is the future role boundary for owner/admin/teacher/assistant/viewer access.
- `omr_audit_logs` is the future trail for sensitive admin actions.

## RLS warning

The current policies in `schema.sql` are intentionally open for alpha/local testing because the app does not have real Supabase Auth yet. Do not store real student data with these policies.

Before using production or sensitive real student data:

1. Enable Supabase Auth for teachers and students.
2. Replace public read/write policies with organization-scoped checks.
3. Restrict `omr_audit_logs` insert/read access by role.
4. Add server-side entitlement checks for Pro and Academy features.
5. Add data retention rules for archived handwriting.
