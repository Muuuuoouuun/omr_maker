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
- `public.omr_user_profiles`
- `public.omr_organization_members`
- `public.omr_teacher_profiles`
- `public.omr_student_profiles`
- `public.omr_classes`
- `public.omr_class_teachers`
- `public.omr_class_students`
- `public.omr_materials`
- `public.omr_exam_materials`
- `public.omr_exams`
- `public.omr_assignments`
- `public.omr_assignment_targets`
- `public.omr_attempts`
- `public.omr_assignment_submissions`
- `public.omr_comments`
- `public.omr_audit_logs`

## Data Model

The schema separates the current JSON sync surface from the future relational product model:

- `organization_id` separates academy, school, or teacher-owned data.
- `omr_user_profiles` stores global app user metadata without forcing every student to have an auth account.
- `omr_organization_members` is the workspace role boundary for owner/admin/teacher/assistant/viewer access.
- `omr_teacher_profiles` and `omr_student_profiles` keep role-specific metadata such as subjects, external student IDs, guardian contact, and roster status.
- `omr_class_teachers` and `omr_class_students` model many-to-many class membership.
- `omr_materials` stores worksheet/PDF/link/file metadata, while actual files should live in Supabase Storage.
- `omr_exam_materials` links reusable materials to exams as problem PDFs, answer keys, solutions, references, or attachments.
- `omr_assignments` represents a distributed exam/work item with open/due/close windows.
- `omr_assignment_targets` scopes an assignment to a class, student, or group.
- `omr_attempts` remains compatible with the app's JSON payload sync and now has nullable `assignment_id` and `student_profile_id`.
- `omr_assignment_submissions` is the normalized assignment-gradebook layer that can point at an `omr_attempts` row.
- `omr_comments` supports teacher-only and student-visible feedback on students, materials, exams, assignments, submissions, attempts, or questions.
- `omr_audit_logs` is the future trail for sensitive admin actions.

```mermaid
erDiagram
    omr_organizations ||--o{ omr_organization_members : has
    omr_organizations ||--o{ omr_teacher_profiles : has
    omr_organizations ||--o{ omr_student_profiles : has
    omr_organizations ||--o{ omr_classes : has
    omr_classes ||--o{ omr_class_teachers : assigns
    omr_classes ||--o{ omr_class_students : enrolls
    omr_student_profiles ||--o{ omr_class_students : joins
    omr_organizations ||--o{ omr_materials : owns
    omr_materials ||--o{ omr_exam_materials : attaches
    omr_exams ||--o{ omr_exam_materials : uses
    omr_exams ||--o{ omr_assignments : distributed_as
    omr_assignments ||--o{ omr_assignment_targets : targets
    omr_assignments ||--o{ omr_assignment_submissions : receives
    omr_student_profiles ||--o{ omr_assignment_submissions : submits
    omr_attempts ||--o| omr_assignment_submissions : normalizes
    omr_organizations ||--o{ omr_comments : contains
    omr_organizations ||--o{ omr_audit_logs : audits
```

## Storage Plan

For large assets, keep metadata in Postgres and binary data in Supabase Storage:

- Problem PDFs: `omr_materials.material_type = 'problem_pdf'`
- Answer keys: `omr_materials.material_type = 'answer_key'`
- Solutions/explanations: `solution`, `worksheet`, `note`, or `link`
- File location: `storage_bucket` + `storage_path`
- External resources: `source_url`

## RLS warning

The current policies in `schema.sql` are intentionally open for alpha/local testing because the app does not have real Supabase Auth yet. Do not store real student data with these policies.

Before using production or sensitive real student data:

1. Enable Supabase Auth for teachers and students.
2. Replace public read/write policies with organization-scoped checks.
3. Restrict `omr_audit_logs` insert/read access by role.
4. Add server-side entitlement checks for Pro and Academy features.
5. Add data retention rules for archived handwriting.
