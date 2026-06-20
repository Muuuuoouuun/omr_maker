# Premium Plan Design

## Goal

Split the product into three plans that match how the app is actually used:

- Free: let an individual teacher try online OMR with minimal setup.
- Pro: help one teacher or a small academy run classes faster with saved handwriting, analysis, and exports.
- Academy: help a large academy, school, or multi-campus institution manage teachers, classes, students, and learning data at scale.

The plan structure should make the product easier to understand before it becomes a real billing system. It should also give engineering one source of truth for feature gating.

## Plan Positioning

| Plan | Target User | Main Value | Buying Trigger |
| --- | --- | --- | --- |
| Free | Trial users, individual teachers | Create and run a few OMR exams immediately | "Can this replace my manual scoring workflow?" |
| Pro | Teachers and small academies | Save time on scoring, review, remediation, and student follow-up | "I need this every week for multiple classes." |
| Academy | Large academies, schools, institutions | Centralize operations, teacher permissions, class data, long-term analytics, and integrations | "We need institution-wide visibility and control." |

## Free

Free is the product trial. It should prove the core loop without feeling broken.

Limits:

- 5 exams per month.
- 30 students.
- 100 AI answer-key recognition runs per month.
- Basic local/browser storage, with optional remote sync only when configured.

Included:

- OMR exam creation.
- Student solve flow.
- Automatic scoring.
- Basic result view.
- Basic exam analytics: average score, highest/lowest score, submission count, question correct rate.
- Exam result CSV export.
- Student CSV import/export for small rosters.
- Temporary handwriting while solving.

Not included:

- Submitted handwriting archive.
- Advanced teaching action insights.
- Long-term student growth reports.
- PDF report export.
- Organization-level teacher, class, campus, or permission management.

## Pro

Pro is for a teacher who runs this as part of weekly teaching, or for a small academy where one operator manages the data.

Limits:

- Unlimited exams.
- 300 students.
- 5,000 AI answer-key recognition runs per month.
- Saved handwriting archive for submitted attempts.

Included:

- Everything in Free.
- Handwriting archive and read-only replay for teacher review.
- Student-facing result review with saved handwriting when available.
- Advanced exam analytics:
  - question correct rate,
  - wrong answer distribution,
  - discrimination check,
  - unanswered rate,
  - risky question detection.
- Teaching action center:
  - weak concept ranking,
  - suggested remediation action,
  - low/borderline/advanced student grouping,
  - retake or follow-up assignment recommendations.
- Student achievement trend by exam.
- Student-level strength and weakness summary.
- CSV and PDF report export.
- Missed-exam reminders and retake assignment workflow.
- Priority support.

Product message:

"One teacher can run scoring, review, and remediation without spreadsheets."

## Academy

Academy is for institutions that need organization controls and aggregate data, not just bigger limits.

Limits:

- Unlimited exams.
- Unlimited students.
- Unlimited or contract-based AI usage.
- Long-term handwriting archive with configurable retention.

Included:

- Everything in Pro.
- Multi-teacher accounts.
- Admin, teacher, assistant, and viewer roles.
- Class, grade, course, campus, and cohort management.
- Institution dashboard:
  - teacher-level activity,
  - class-level performance,
  - campus-level comparison,
  - course and concept weakness distribution,
  - completion and missed-exam monitoring.
- Long-term student growth reports across exams and terms.
- Curriculum or unit-level analytics.
- Bulk operations for rosters, classes, and exams.
- Audit logs for sensitive admin actions.
- SSO.
- API access.
- Custom domain.
- Data export and retention policy controls.
- Dedicated onboarding and support.

Product message:

"An institution can see learning data across teachers, classes, and campuses."

## Entitlement Model

The app should use a single entitlement source instead of scattering plan checks across pages.

Proposed keys:

- `maxExamsPerMonth`
- `maxStudents`
- `aiAnswerRecognitionPerMonth`
- `handwritingArchive`
- `advancedAnalytics`
- `teachingActionCenter`
- `studentGrowthReports`
- `csvExport`
- `pdfExport`
- `reminders`
- `retakeAssignments`
- `multiTeacher`
- `organizationDashboard`
- `rolesAndPermissions`
- `sso`
- `apiAccess`
- `customDomain`
- `auditLogs`
- `retentionControls`
- `prioritySupport`
- `dedicatedSupport`

Plan checks should read from this model. UI copy, billing cards, feature gates, and usage warnings should all use the same data.

## Current Implementation Gap

The current app already has useful pieces:

- Billing page with Free, Pro, and School copy.
- Local `omr_plan` flag.
- Handwriting archive gated for Pro and School.
- Teacher attempt handwriting replay.
- Student result review.
- Exam analytics and student analytics.
- CSV exports.
- AI answer-key recognition.

The gaps:

- Rename School to Academy.
- Make plan names and features consistent across types, billing UI, utilities, and copy.
- Move plan feature definitions out of the billing page into a shared module.
- Connect limits to real usage behavior.
- Count AI answer-key recognition usage.
- Rename AI copy from "AI scoring" to "AI answer-key recognition" unless actual AI scoring is added.
- Add PDF report export or remove that claim from Pro.
- Gate advanced analytics and teaching action center as Pro-only features. Keep basic analytics available in Free.
- Add Academy-specific data model work before selling SSO/API/custom domain as real features.

## UX Rules

Plan messaging should be teacher-centered:

- Free: "Try the full OMR loop."
- Pro: "Save time after every test."
- Academy: "Manage learning data across the organization."

Students should not see upgrade pressure during solving. If the current plan does not archive handwriting, show a quiet teacher-facing note and keep the student submission flow clean.

Teachers should see upgrade prompts only at relevant moments:

- creating the 6th monthly exam,
- importing more than the AI quota,
- trying to view saved handwriting from a Free submission,
- opening advanced teaching insights,
- exporting PDF reports,
- adding the 31st student on Free or 301st student on Pro.

Academy prompts should be shown to owner/admin workflows only, not normal teachers.

## Data And Security Notes

Academy cannot be only a pricing label. It needs real organization boundaries:

- organization id on exams, attempts, students, classes, and teachers,
- role-based access checks,
- private row-level security,
- audit logs,
- retention policy metadata,
- server-backed billing and entitlement state.

The current open Supabase policies are acceptable for development only and must be tightened before using real student data.

## Rollout Order

1. Create a shared plan catalog and entitlement helper.
2. Rename School to Academy across types, billing UI, plan labels, and copy.
3. Update billing page feature cards and usage language.
4. Add usage counters for exams, students, and AI answer-key recognition.
5. Add soft gates and upgrade prompts for Free and Pro limits.
6. Gate advanced analytics and teaching action center behind Pro while keeping basic analytics in Free.
7. Add PDF report export before showing it as an included Pro feature in billing cards.
8. Scope Academy as a separate organization-data project.

## Success Criteria

- A teacher can understand the difference between Free, Pro, and Academy in under 30 seconds.
- Billing copy matches actual behavior.
- A feature is never advertised as included unless it is implemented, gated, and reachable from the relevant user workflow.
- Plan gates use one shared entitlement source.
- Pro clearly improves the teacher's after-test workflow.
- Academy clearly means institution management, not only bigger limits.
