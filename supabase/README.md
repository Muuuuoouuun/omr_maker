# Supabase setup

1. In Supabase, open SQL Editor and run `supabase/schema.sql`.
2. Create `.env.local` in the project root:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://wqhiajvisirxdjivhmlt.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_full_key_here
```

3. Restart the Next.js dev server after changing `.env.local`.

The app keeps localStorage as a fallback. When Supabase is configured, exams and attempts are synced to:

- `public.omr_exams`
- `public.omr_attempts`

The current policies in `schema.sql` are intentionally open because the app does not have real Supabase Auth yet. Tighten RLS before storing sensitive student data.
