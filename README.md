# OMR Maker

Next.js based OMR exam maker for teachers and students. Teachers can create and distribute exams, students can solve them online, and the app can run as an installable PWA.

## Development

```bash
npm install
npm run dev
```

The dev server runs on [http://localhost:3003](http://localhost:3003).

## Sample Accounts

Development teacher/admin login:

- Role: `교사`
- ID: `admin`
- Password: `admin123`

In production, there is no default account. Set one of these on the server before deploying:

- Single teacher: `TEACHER_LOGIN_ID`, optional `TEACHER_EMAIL`/`TEACHER_NAME`, and `TEACHER_PASSWORD`
- Multiple teachers: `TEACHER_ACCOUNTS` as a JSON array, for example `[{"id":"teacher1","email":"teacher1@example.com","name":"Teacher 1","password":"change-me"}]`
- Recommended for server-side route guards: `TEACHER_SESSION_SECRET`

Teacher login is currently backed by server environment variables, not Supabase Auth. If a deployed build only says the credentials are invalid, check the deployment provider's environment variables and redeploy before checking Supabase.

Student login uses the roster student number or email as the account ID, and a six-character start code as the password-like credential. Import `examples/student-roster.csv` from `/teacher/users`, then students can choose `학생` and enter one of these sample names with the matching class. Share the CSV `id` or `email` value as the student's login ID, especially when names overlap:

- `김민준` / `3학년 A반` / `서울`
- `이서연` / `3학년 A반` / `서울`
- `박도윤` / `3학년 B반` / `서울`
- `최예은` / `2학년 A반` / `부산`

On first student login, the app issues a six-character start code. Returning students with prior attempts must enter that start code; teachers can also issue or regenerate it from `/teacher/users`.

If a class has same-name students, students must enter the roster email or teacher-issued student ID in `학생번호 또는 이메일` so records do not merge into the wrong profile.

Production account, security, privacy, and usability rollout items are tracked in `docs/account-security-usability-checklist.md`.

## Product Direction

Current service direction and prioritization are tracked in `docs/service-direction.md`. The short version: stabilize PDF-region question metadata, tablet handwriting, 5-choice OMR solving, wrong-question/type analytics, and Kakao-first notification planning before advanced cropped question-image DB and payment integrations.

## Verification

```bash
npm audit
npm test
npm run lint
npm run build
npm run test:e2e:prod
```

## Web And App Use

The app is a web app with PWA support:

- `src/app/manifest.ts` defines install metadata and icons.
- `public/sw.js` precaches the app shell and offline page in production.
- `src/components/PWARegister.tsx` registers the service worker for production builds.

Users can open it in a browser or install it to a phone/tablet home screen from a supported browser.

## Supabase Sync

Without Supabase env vars, data is saved locally in the browser. With Supabase configured, exams and attempts sync across web/PWA installs.

Setup:

1. Run `supabase/schema.sql` in the Supabase SQL Editor.
2. Add `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_full_key_here
SUPABASE_SERVICE_ROLE_KEY=server_only_service_role_key_for_workspace_bootstrap
```

3. Restart the dev or production server.

See `supabase/README.md` for details, the current RLS warning, and the production RLS handoff.

The alpha schema includes organization, member, class, exam, attempt, and audit-log tables. Current saves use an interim teacher-scoped `teacher_<hash>` organization id when a teacher session is active. `SUPABASE_SERVICE_ROLE_KEY` is optional and server-only; when set, teacher login bootstraps the matching workspace/member/profile rows from the server. Current `schema.sql` RLS policies are open only for alpha/local testing; configure Supabase Auth, fill real `organization_id`/membership rows, and apply `supabase/production-rls.sql` before storing real student data.

## Answer-Key Recognition

Answer PDFs can be parsed with PDF text extraction or Gemini image recognition. Recognition usage is counted locally as `omr_ai_usage` and shown on the billing page as AI answer-key recognition usage.
