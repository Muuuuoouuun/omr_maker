# Progressive Identity And Security Design

## Goal

Make OMR Maker easy enough for students to enter an exam in seconds while keeping teacher-owned data secure, reviewable, and clean enough for real classroom use.

## Decision

Use **teacher-required signup** and **student quick entry** as the default product model.

Teachers, academies, and school staff must sign in and work inside an organization workspace. Students do not need an account to take an exam. A student enters through an assignment link or code, identifies with a roster-friendly name/number/PIN flow, submits, and only creates an account later if they want long-term personal history.

This avoids the biggest classroom usability failure: forcing every student to create an account before a timed exam. Data quality is handled through controlled assignment links, roster matching, duplicate rules, pending queues, and retention policy rather than up-front student signup.

## Product Principles

1. **Teacher accounts are the trust boundary.**
   Teachers own organizations, classes, rosters, materials, exams, assignments, submissions, and reports.

2. **Students can take tests without signup.**
   A student should be able to open a link, identify themselves, and begin in under 15 seconds.

3. **Untrusted submissions do not become official records automatically.**
   Submissions that fail roster matching or quality checks enter a pending review state.

4. **Student accounts are optional upgrades, not entry requirements.**
   Students can claim history later through email/social/phone, but this should not block exam-taking.

5. **Security grows with data sensitivity.**
   Alpha can run with open development policies. Real student data requires Supabase Auth, organization-scoped RLS, audit logging, and retention rules.

## Personas

### Teacher

Needs to create exams, distribute links, manage classes, review suspicious submissions, and trust that students cannot view or modify other students' records.

### Student

Needs to enter an exam quickly without password setup. May later want to see long-term history.

### Academy Admin

Needs workspace-level teacher management, class ownership, billing, audit logs, and data export/cleanup.

### Parent Or Guardian

Not part of the first implementation. Guardian contact can be stored in `omr_student_profiles`, but guardian login is out of scope.

## Signup And Entry Flows

### Teacher Signup

Default path:

1. Teacher signs up with email magic link or Google OAuth.
2. If no organization exists, create one with the teacher as `owner`.
3. Teacher can invite other staff as `admin`, `teacher`, `assistant`, or `viewer`.
4. Teacher creates classes and optional student rosters.

Recommended auth methods:

- Google OAuth for speed.
- Email magic link for non-Google users.
- Password login only if needed later.
- MFA available for owners/admins before production.

### Student Quick Entry

Default path:

1. Student opens `/solve/:assignmentOrExamId` from a teacher-provided link or QR code.
2. App resolves the assignment and checks whether it is open.
3. Student identifies by:
   - class roster selection plus short PIN, or
   - name plus student number, or
   - name plus teacher-provided access code for public/guest exams.
4. If roster match is confident, submission links to `student_profile_id`.
5. If match is weak or unknown, submission is accepted into pending state but excluded from official analytics until teacher review.

### Optional Student Account Claim

Later path:

1. Student chooses "내 기록 저장하기".
2. Student creates a permanent identity through email/social/phone.
3. App asks the teacher-owned workspace to confirm the claim when needed.
4. Past matching submissions attach to the student's `user_id`.

This avoids forcing accounts before the test while still supporting long-term history.

## Garbage Data Controls

### Entry Controls

- Require an assignment link/code for writes.
- Do not allow arbitrary public insert into official gradebook tables.
- Use assignment open/due/close windows.
- Require one of:
  - roster match,
  - student number,
  - short PIN,
  - device/session continuity,
  - teacher approval.

### Duplicate Controls

For each assignment target, enforce a logical uniqueness rule:

- one active final submission per `assignment_id + student_profile_id`, or
- one pending submission per `assignment_id + normalized_name + student_number/device_id`.

If retakes are allowed, store attempt number and make the grading rule explicit:

- latest submission wins,
- highest score wins,
- teacher selects official submission.

### Suspicion Signals

Submissions should be marked `pending_review` or `flagged` when:

- roster matching fails,
- same student identity submits multiple times,
- name contains obvious junk or unsupported characters,
- completion time is implausibly short,
- tab focus loss count is high,
- assignment was opened from an expired or wrong code,
- device/session identity conflicts with an existing student.

### Teacher Review Queue

Teacher dashboard needs a "미확인 제출" queue with actions:

- approve as official,
- merge into existing student,
- create new roster student,
- mark as practice/test,
- delete,
- block duplicate device/name combination for the assignment.

### Retention

Default retention recommendation:

- Approved official submissions: keep according to organization policy.
- Pending guest submissions: auto-hide after 30 days.
- Clearly rejected/test submissions: delete after 7 days.
- Heavy handwriting/PDF assets: separate retention from grade metadata.

## Data Model Mapping

Existing advanced schema already supports this direction:

- `omr_organizations`: teacher or academy workspace.
- `omr_organization_members`: staff roles.
- `omr_teacher_profiles`: teacher metadata.
- `omr_student_profiles`: roster students, whether or not they have login accounts.
- `omr_classes`: class/roster container.
- `omr_class_teachers`: teacher-class assignment.
- `omr_class_students`: student enrollment.
- `omr_materials`: PDFs, answer keys, worksheets, links, notes.
- `omr_exams`: exam definition and current JSON compatibility payload.
- `omr_assignments`: distribution instance with windows and max attempts.
- `omr_assignment_targets`: class/student/group targeting and access controls.
- `omr_attempts`: current answer payload sync.
- `omr_assignment_submissions`: normalized gradebook row.
- `omr_comments`: teacher/student-visible feedback.
- `omr_audit_logs`: sensitive admin actions.

Recommended new status values for implementation:

- Submission status: `assigned`, `in_progress`, `submitted`, `pending_review`, `graded`, `returned`, `excused`, `rejected`.
- Assignment status: `draft`, `scheduled`, `open`, `closed`, `archived`.
- Student profile status: `invited`, `active`, `inactive`, `graduated`, `withdrawn`.

## Authorization Model

### Roles

- `owner`: billing, organization settings, all data, deletion/export.
- `admin`: staff/class management, all academic data.
- `teacher`: assigned classes, exams, materials, submissions.
- `assistant`: grading/review for assigned classes, limited settings.
- `viewer`: read-only reports.
- `student`: own submissions and student-visible feedback only.
- `guest_candidate`: unauthenticated or anonymous submission identity before approval.

### RLS Strategy

Production RLS should use Supabase Auth. Supabase Auth issues user-bound JWTs and integrates with RLS, so policies can use `auth.uid()` for row access. RLS should be treated as defense in depth, not just UI hiding.

High-level rules:

- Organization members can read organization-scoped rows where they are active members.
- Teachers can mutate rows only for organizations/classes where their role permits it.
- Students can read only their own `student_profile_id`, official submissions, and student-visible comments.
- Anonymous/public users cannot read roster data.
- Anonymous/public users can only create tightly scoped pending submissions through assignment access controls.
- Service role/server actions can perform privileged merge, cleanup, and audit operations.

### Public Submission Safety

The public browser key should not be able to write official records directly in production. Public quick-entry should either:

1. call a server action/route handler that validates assignment code and writes pending rows with service credentials, or
2. use a narrow RLS policy that permits insert only into a pending submission table when a valid assignment token is present.

Recommendation: use server actions for the first production version because validation logic will be easier to audit.

## UX Requirements

### Teacher UX

- First run asks for workspace name and school/academy type.
- Create class can start empty.
- Student roster import is optional.
- Exam distribution asks: public link, class link, or targeted students.
- Each assignment shows an entry mode:
  - "빠른 응시": name + number,
  - "PIN 응시": roster + short PIN,
  - "로그인 응시": student account required.
- Dashboard has pending review count.

### Student UX

- Link opens directly to a friendly entry screen.
- If roster exists, search/select name and enter PIN/student number.
- If no roster, enter name and optional number.
- No account prompt before submission.
- After result, show optional "내 기록 저장하기".

### Admin UX

- Staff roles page.
- Data cleanup page.
- Export logs.
- Suspicious submission rules.

## Security Requirements

- Never expose `sb_secret_*` or JWT secret to browser code.
- Use publishable key only for browser Supabase clients.
- Store service role key only in server-only environment variables if server actions need privileged writes.
- Enable MFA for owners/admins before production.
- Audit these actions:
  - staff invite/remove,
  - roster import/delete,
  - official submission approval/rejection,
  - grade override,
  - data export,
  - bulk delete,
  - billing/plan change.
- Rate limit public entry and submission endpoints.
- Normalize names for matching but preserve original input for audit.
- Avoid storing more student PII than necessary.

## Phased Rollout

### Phase 1: Safe Alpha

- Teacher signup only.
- Student quick entry.
- Pending review queue.
- Supabase schema remains mostly as-is, with status additions.
- Server-side validation for submission entry preferred.

### Phase 2: Classroom Production

- Organization-scoped RLS.
- Teacher/staff roles.
- Roster import.
- Assignment targets.
- Duplicate and suspicious submission queue.
- Audit logs.

### Phase 3: Student Accounts

- Optional student history accounts.
- Claim flow for prior submissions.
- Student-visible feedback.
- Long-term analytics.

### Phase 4: Academy Controls

- MFA enforcement for owners/admins.
- Retention policies.
- Export/delete workflows.
- Advanced access logs.

## Open Decisions

1. Student PIN default: teacher-generated short PIN vs student number vs no PIN for first alpha.
2. Official duplicate rule: latest submission vs highest score vs teacher-selected.
3. Pending retention: 7, 14, or 30 days.
4. Whether anonymous Supabase Auth users should be used for student quick entry, or whether quick entry should stay fully app-managed until account claim.

Recommended defaults:

- Student quick entry uses name + student number when roster exists.
- PIN is optional per assignment.
- Official duplicate rule is teacher-selected for now.
- Pending retention is 30 days, rejected/test retention is 7 days.
- Use app-managed quick entry first, not anonymous Auth, to keep the mental model simple.

## References

- Supabase Auth: https://supabase.com/docs/guides/auth
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Users and anonymous users: https://supabase.com/docs/guides/auth/users
