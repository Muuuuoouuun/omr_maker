# Student direct login

The user approved the proposed flow: teacher-provisioned student accounts open their assigned exams and submission history from student home, without needing an exam invite for each login. Exam links remain shortcuts; public guest attempts retain their current ownership rules.

## Identity and authentication

Use the globally unique `omr_student_profiles.id`, already included as `student_id` in teacher credential CSVs and available through the teacher's student-number copy control. Do not use organization-local external IDs or email to infer an organization. A direct login accepts only this student ID, the existing six-character start code, and optionally a class ID selected after successful credential verification.

Resolve the profile by exact primary key on the server, verify the current PBKDF2 credential and credential generation, then load active enrollment and active classes within that server-resolved organization. A single class is selected automatically. Multiple classes are offered only after successful authentication; the second submission re-verifies credentials and enrollment. An unknown ID, wrong code, inactive profile, missing credential, or foreign class gets the same generic credential error. Database errors fail closed. Admission and durable login rate limiting happen before account lookup. The browser never receives an organization ID or credential account ID.

Issue the existing signed HttpOnly student session with its credential generation; session restoration and revocation continue through the existing server checks. Preserve server-owned guest attempt claim behavior when a guest connects to an account.

## Interface

Replace the production bare-login invite warning with a focused ID and start-code form. Keep the existing invited-class login and local-development roster flow. A fresh local browser with no roster also shows the direct form so its interaction can be verified. Existing signed student cookies still restore student home. Successful direct login opens the safe `next` route, defaulting to `/student/dashboard`. Use password semantics for the reusable start code and keep it only in component state.

Student home and guest account connection direct students to student login instead of requiring another exam invite. Teacher credential guidance explains that `student_id` and `start_code` are sufficient at the student login URL. README distinguishes production teacher-issued credentials from local first-login code generation.

## Validation

Behavioral tests verify direct login, wrong and rotated credentials, inactive/foreign enrollments, multiple classes, bounded queries, unavailable services, same-origin admission, durable rate limiting, signed-cookie issuance, and private scope omission. Component tests exercise empty input, invalid credentials, class selection, successful continuation, and pending state. Existing invite, recovery, guest ownership, and credential tests must continue passing. Validate desktop and mobile rendered direct forms with Playwright, then run lint, type checking, and production build. No database migration is required; live deployment is outside this change.
