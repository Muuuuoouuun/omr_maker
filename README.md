# OMR Maker

Next.js based OMR exam maker for teachers and students. Teachers can create and distribute exams, students can solve them online, and the app can run as an installable PWA.

## Development

```bash
npm install
npm run dev
```

The dev server runs on [http://localhost:3003](http://localhost:3003).

## Verification

```bash
npm audit
npm test
npm run lint
npm run build
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
```

3. Restart the dev or production server.

See `supabase/README.md` for details and the current RLS warning.

The alpha schema includes organization, member, class, exam, attempt, and audit-log tables. Current RLS policies are open only for alpha/local testing; configure Supabase Auth and organization-scoped policies before storing real student data.

## Answer-Key Recognition

Answer PDFs can be parsed with PDF text extraction or Gemini image recognition. Recognition usage is counted locally as `omr_ai_usage` and shown on the billing page as AI answer-key recognition usage.
