# OMR Maker

Next.js based OMR exam maker for teachers and students. Teachers can create and distribute exams, students can solve them online, and the app can run as an installable PWA.

## Development

```bash
npm install
npm run dev
```

The dev server runs on [http://localhost:3003](http://localhost:3003).

## Sample Accounts

Development teacher login (role `교사`). Configure accounts with `.env.local` `TEACHER_ACCOUNTS`. The table below is an example seed, not an account set guaranteed to exist in every checkout:

| ID | Password | Plan | Notes |
| --- | --- | --- | --- |
| `admin` | `admin1234` | Academy | Academy catalog example; unfinished organization features remain unavailable |
| `test1` | `test1234` | Free | Free tier |
| `test2` | `test1234` | Pro | Pro tier |
| `test3` | `test1234` | Academy | Enterprise tier |

With no `TEACHER_ACCOUNTS`/`TEACHER_PASSWORD` configured, the app falls back to `admin` / `admin123`. The `admin` account is bound to the Academy plan and can use every feature without quota limits.

In production, there is no default account. Set one of these on the server before deploying:

- Single teacher: `TEACHER_LOGIN_ID`, optional `TEACHER_EMAIL`/`TEACHER_NAME`/`TEACHER_PLAN`, and `TEACHER_PASSWORD`. An account whose login id is exactly `admin` defaults to the Academy plan and admin role.
- Multiple teachers: `TEACHER_ACCOUNTS` as a JSON array, for example `[{"id":"teacher1","email":"teacher1@example.com","name":"Teacher 1","password":"change-me","plan":"pro"}]`
- `omr_organizations.plan` is the authoritative plan when Supabase service-role access is configured. Browser `omr_plan` values are display caches only and never authorize paid mutations.
- Without a server plan store, paid mutations fail closed. Local development may opt into the process-local simulator with `OMR_PLAN_DEV_SIMULATION=1` and `OMR_DEV_PLAN=free|pro|academy`; this override is ignored in production.
- Academy is a catalog tier, not a promise that every listed organization feature is implemented. Billing readiness labels are the source of truth for unavailable/partial features.
- Recommended for server-side route guards: `TEACHER_SESSION_SECRET`

Teacher login is currently backed by server environment variables, not Supabase Auth. If a deployed build only says the credentials are invalid, check the deployment provider's environment variables and redeploy before checking Supabase.

The shared deployment QA workspace uses four teacher logins against the same Supabase organization (`teacher_sharedqa`): `admin` (Academy), `teacher1` (Free), `teacher2` (Pro), and `teacher3` (Academy). The organization itself is Academy; each signed account plan is a ceiling that can reduce, but never elevate, server authorization. Provision and verify the fixture with `npm run accounts:deploy:apply` and `npm run accounts:deploy:verify`. See `docs/deployment-test-accounts.md` for the test-only credentials and student entry URL.

Synthetic dashboard, roster, and live-monitoring examples are restricted to the public `omr-showcase` mockup account. Normal admin and teacher accounts display their real workspace, including an empty state when no data exists.

For local-only account QA, setting `NEXT_PUBLIC_OMR_SEED_TEST_ACCOUNTS=1` in `.env.local` adds four login-ready students (`student1` through `student4`) to the existing local roster without replacing user-created rows. This separate browser seed is disabled in production. The students use the `테스트반` class; their development start codes are defined in `src/lib/localTestAccounts.ts`.

Student login uses the roster student number or email as the account ID, and a six-character start code as the password-like credential. Import `examples/student-roster.csv` from `/teacher/users`, then students can choose `학생` and enter one of these sample names with the matching class. Share the CSV `id` or `email` value as the student's login ID, especially when names overlap:

- `김민준` / `3학년 A반` / `서울`
- `최지우` / `3학년 B반` / `서울`
- `한지호` / `2학년 A반` / `부산`

On first student login, the app issues a six-character start code. Returning students with prior attempts must enter that start code; teachers can also issue or regenerate it from `/teacher/users`.

If a class has same-name students, students must enter the roster email or teacher-issued student ID in `학생번호 또는 이메일` so records do not merge into the wrong profile.

For deployment smoke testing with the shared administrator, three teachers, and three roster-backed students, see `docs/deployment-test-accounts.md`.

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

PWA release checks:

```bash
npm run test:pwa:prod
PWA_SMOKE_BASE_URL=https://your-public-https-deployment.example npm run pwa:smoke
PLAYWRIGHT_BASE_URL=https://your-public-https-deployment.example npm run test:e2e -- --project=mobile-chrome-pwa --project=mobile-ios-like-pwa --project=tablet-android-pwa --project=tablet-android-landscape-pwa --project=tablet-ios-like-pwa --project=tablet-ios-like-landscape-pwa
```

Use a public HTTPS URL for phone/tablet install testing. Preview deployments that return HTTP 401 because of deployment protection cannot prove installability in mobile Chrome or iOS Safari. For the final device pass, open the public URL on Android Chrome and iOS Safari, add it to the home screen, launch it from the app icon, confirm it opens standalone, and run the student start flow without horizontal overflow.

The `pwa:smoke` check also asks Chromium for `Page.getAppManifest` and `Page.getInstallabilityErrors`, so Android-style installability regressions fail the release check before device handoff.

For device QA, open `/pwa-check` on the public URL. The page shows a QR code and share/copy controls for moving the check URL to a real phone or tablet. It reports HTTPS, display mode, app-icon launch evidence, service worker, manifest, viewport, mobile metadata, horizontal overflow, storage access, and install-prompt state, then shows and copies a text report that includes the device verdict, display mode, CSS/iOS standalone evidence, user agent, and every check result. In browser mode it should show `설치 실행 전`; after launching from the home-screen icon it should show `앱 실행 통과`. `/pwa-check` is also exposed as an installed app shortcut named `앱 상태 체크`, and it is part of the service worker app shell, so it can still open after the route has been cached and the device is offline. The page also links back into the student and exam creation flows.

## Web And App Use

The app is a web app with PWA support:

- `src/app/manifest.ts` defines install metadata and icons.
- `public/sw.js` precaches the app shell and offline page in production.
- `src/components/PWARegister.tsx` registers the service worker for production builds.

Users can open it in a browser or install it to a phone/tablet home screen from a supported browser.

Windows-to-Android device development is also available through the Capacitor test shell. Run `npm run android:doctor`, then connect an emulator or USB-debugging device and use `npm run android:dev`. See [docs/mobile-app.md](docs/mobile-app.md) for the PWA/Android deployment boundary and setup steps.

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

The alpha schema includes organization, member, class, exam, attempt, plan-usage, and audit-log tables. Current saves use an interim teacher-scoped `teacher_<hash>` organization id when a teacher session is active. `SUPABASE_SERVICE_ROLE_KEY` is required for authoritative plan lookup and atomic quota reservation; when set, teacher login also bootstraps the matching workspace/member/profile rows from the server. Current `schema.sql` business-data RLS policies are open only for alpha/local testing (plan-usage tables remain server-only); configure Supabase Auth, fill real `organization_id`/membership rows, and apply `supabase/production-rls.sql` before storing real student data.

## Answer-Key Recognition

Answer PDFs can be parsed with PDF text extraction or Gemini image recognition. Shared platform-key recognition consumes an atomic server-side monthly quota after signed-teacher authentication; failed provider calls release the reservation. A teacher-supplied personal API key is billed to that teacher and is deliberately excluded from the platform quota. The browser `omr_ai_usage` value is UX telemetry only.
