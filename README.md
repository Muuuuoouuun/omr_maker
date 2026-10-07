# OMR Maker

Next.js based OMR exam maker for teachers and students. Teachers can create and distribute exams, students can solve them online, and the app can run as an installable PWA.

## Development

```bash
npm install
npm run dev
```

The dev server runs on [http://localhost:3003](http://localhost:3003).

## Authentication setup

Production uses operator-provisioned, database-backed teacher accounts (`provisioned_only`). Issue them with `npm run ops:teacher:provision` under the [Go-Live Gate](docs/production-readiness.md). Development/legacy QA accounts may use `.env.local` `TEACHER_ACCOUNTS`; do not publish credentials or commit environment files.

Only local development falls back to the demo accounts `admin` / `admin123`, `owner1` / `owner123` (원장 1, owner) and `teacher1` / `teacher123` (교사 1, teacher) when no teacher credentials are configured. Development fixtures do not prove production login, billing, or external integration readiness.

The teacher identity mode defaults to `provisioned_only` everywhere, which is the intended secure default. Without Supabase, a fresh checkout therefore reports "배포 환경에 교사 계정이 설정되어 있지 않습니다." until you opt into the local fallback in `.env.local`:

```bash
# .env.local (development only; ignored when NODE_ENV=production)
OMR_TEACHER_IDENTITY_MODE=self_service
```

With that set, the demo accounts above (or your `TEACHER_ACCOUNTS` / `TEACHER_LOGIN_ID` values) work locally. Production always stays `provisioned_only` regardless of this variable. See [deployment test accounts](docs/deployment-test-accounts.md) and [operator provisioning](docs/operator-teacher-provisioning.md).

There is no default production account. These legacy account settings do not replace production operator provisioning:

- Single teacher: `TEACHER_LOGIN_ID`, optional `TEACHER_EMAIL`/`TEACHER_NAME`/`TEACHER_PLAN`, and a supported PBKDF2 value in `TEACHER_PASSWORD_HASH`.
- Multiple teachers: `TEACHER_ACCOUNTS` as a JSON array whose entries use `passwordHash` rather than `password`. Production rejects plaintext `TEACHER_PASSWORD` and `TEACHER_ACCOUNTS[].password`; plaintext remains available only for local development fixtures.
- `omr_organizations.plan` is the authoritative plan when Supabase service-role access is configured. Browser `omr_plan` values are display caches only and never authorize paid mutations.
- Without a server plan store, paid mutations fail closed. Local development may opt into the process-local simulator with `OMR_PLAN_DEV_SIMULATION=1` and `OMR_DEV_PLAN=free|pro|academy`; this override is ignored in production.
- Academy is a catalog tier, not a promise that every listed organization feature is implemented. Billing readiness labels are the source of truth for unavailable/partial features.
- Required production signing secrets: `TEACHER_SESSION_SECRET`, `STUDENT_SESSION_SECRET`, and `STUDENT_ATTEMPT_SECRET`, each containing at least 32 UTF-8 bytes of random secret material. Short values fail closed and cannot mint or verify sessions or attempt tickets.

Production login requires the provisioned account, active membership/profile, current grant, service-role RPCs, and signing/rate-limiter secrets. A rendered login screen alone does not prove these are ready; verify the protected `/api/readyz` endpoint.

The legacy QA workspace (`teacher_sharedqa`) is restricted to a Preview Supabase project separate from Production. Its provisioning scripts reject shared or unresolved database targets and require private credentials. They never modify Production and do not qualify the current production teacher-login flow. See [the QA setup](docs/deployment-test-accounts.md).

Synthetic dashboard, roster, and live-monitoring examples are restricted to the public `omr-showcase` mockup account. Normal admin and teacher accounts display their real workspace, including an empty state when no data exists.

For local account QA, setting `NEXT_PUBLIC_OMR_SEED_TEST_ACCOUNTS=1` in `.env.local` adds four login-ready students (`student1` through `student4`) to the current browser's local roster without replacing user-created rows. This seed is disabled in production and does not create Supabase Auth users. Remove the flag and clear the dedicated QA browser's `omr_*` local/session storage when the fixture is no longer needed. The students use the `테스트반` class; their development start codes are defined in `src/lib/localTestAccounts.ts`.

Students can open `/?role=student` and log in without an exam invite using the canonical student ID (`student_id`) and six-character start code (`start_code`) from the teacher-issued credential CSV. Teachers register students and issue or regenerate credentials from `/teacher/users`; students do not need to self-register. The teacher's student-number copy control provides the same canonical ID. Direct login does not accept an organization-local external ID or email, which may overlap between workspaces.

After authentication, a student with one active class opens `/student/dashboard`; a student enrolled in several active classes selects their class first. Student home shows assigned exams and submission history. Existing exam invitation links still support their class-scoped name, student-number/email, and start-code login and return to the invited exam. Public guest exams retain browser-based guest identity and can be connected to a verified student account.

For local-only development, import `examples/student-roster.csv` from `/teacher/users` and use the roster login form. The local first-login flow can issue a start code; production always requires a teacher-issued server credential. Returning local students must enter their existing code. When names overlap, use the roster email or canonical student ID.

For deployment smoke testing with the shared administrator, three teachers, and three roster-backed students, see `docs/deployment-test-accounts.md`.

Production account, security, privacy, and usability rollout items are tracked in `docs/account-security-usability-checklist.md`.

## Product Direction

Current service direction and prioritization are tracked in `docs/service-direction.md`. The short version: stabilize PDF-region question metadata, tablet handwriting, 5-choice OMR solving, wrong-question/type analytics, and Kakao-first notification planning before advanced cropped question-image DB and payment integrations.

## SOLAPI learning reminders

Open `/teacher/reminders` (account menu → 학습 알림) to register student/guardian
phone numbers, enable exam deadline reminders, preview recipients, and inspect
dispatch records. The default is `OMR_REMINDER_MODE=dry_run`; no messages are sent.
Apply `supabase/migrations/202609100001_solapi_reminders.sql` after the existing
migrations. See [the setup guide](docs/solapi-reminders.md) for server credentials,
Kakao templates, SMS fallback, scheduling, and activation.

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

PWA is the current Android/iOS delivery path. This checkout has Capacitor development configuration but no generated Android or iOS native project. Native device testing requires platform generation and SDK setup; see [docs/mobile-app.md](docs/mobile-app.md).

## Supabase Sync

Local development can save data in the browser. Production canonical data, authentication, and submissions require a verified Supabase server boundary; local storage is not a substitute for an unavailable production backend.

Setup:

1. Run `supabase/schema.sql` in the Supabase SQL Editor.
2. Add `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_full_key_here
SUPABASE_SERVICE_ROLE_KEY=server_only_service_role_key_for_workspace_bootstrap
OMR_RATE_LIMIT_HASH_SECRET=replace_with_at_least_32_random_bytes
```

`OMR_RATE_LIMIT_HASH_SECRET` is mandatory in production. Use a unique random value of at least 32 bytes; if it is missing or too short, teacher/student login, exam PIN checks, and AI request admission fail closed.

3. Apply every migration and the production server boundary before promoting the matching application build, then restart the server. Do not deploy the code first: the limiter RPC and secret must both exist before login traffic reaches the new build.

See `supabase/README.md` for details, the current RLS warning, and the production RLS handoff.
Before going live with real student data, work through the consolidated [Go-Live Gate](docs/production-readiness.md).

The alpha `schema.sql` alone is not safe for real student data. Apply sorted migrations, pass organization preflight, and apply `supabase/production-server-boundary.sql` with the migration owner before receiving live traffic. The historical `production-rls.sql` browser-access profile is not the current production handoff. Local PostgreSQL tests validate the repository SQL, while hosted readiness must separately prove the actual deployment.

## Answer-Key Recognition

Answer PDFs can be parsed with PDF text extraction or Gemini image recognition. Shared platform-key recognition consumes an atomic server-side monthly quota after signed-teacher authentication; failed provider calls release the reservation. A teacher-supplied personal API key is billed to that teacher and is deliberately excluded from the platform quota. The browser `omr_ai_usage` value is UX telemetry only.
