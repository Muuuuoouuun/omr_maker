-- DRAFT — NOT YET APPLIED. See supabase/drafts/README.md.
--
-- Follow-up for the roster save-concurrency work in src/lib/rosterPersistence.ts
-- (T2). That change reduces the window in which two devices can clobber each
-- other's roster edits WITHOUT a schema change, by:
--   1. diffing locally-built rows against a freshly-fetched remote snapshot and
--      only upserting rows that actually differ (see upsertRemoteRosterSnapshot
--      / rosterRowUnchanged), and
--   2. reconciling remote-deleted-vs-local-edited races via reconcileRemoteDeletions,
--      which compares a row against this device's own last-synced copy.
--
-- Neither of those is true optimistic concurrency: two devices can still both
-- read the same row, both edit different fields, and the second save's write
-- silently overwrites the first save's write at the ROW level (see the
-- rosterPersistence.test.ts test "is last-writer-wins at the row level when
-- two devices edit the same student concurrently"). Fixing that for real needs
-- a conditional write: "update this row only if it hasn't changed since I read
-- it", which needs a comparable version stamp on every row.
--
-- omr_classes and omr_student_profiles already have `updated_at`. The one
-- roster table missing it is the enrollment join table, omr_class_students —
-- it currently has no timestamp/version column at all. This adds one so all
-- three roster tables can eventually support the same conditional-update
-- pattern:
--
--   const { data, error } = await client
--       .from('omr_student_profiles')
--       .update({ ...nextRow, updated_at: nowIso })
--       .eq('id', row.id)
--       .eq('updated_at', lastKnownUpdatedAt)   -- the value THIS device last read
--       .select();
--   // data.length === 0  =>  someone else wrote this row first; re-fetch,
--   // re-merge (or surface a conflict to the teacher), and retry.
--
-- That client-side switch from upsert() to this conditional update()+insert()
-- fallback is a real behavioral change (upsert() has no "only if unchanged"
-- mode) and is deliberately NOT implemented as part of T2 — this file only
-- adds the column so that follow-up isn't blocked on a schema change later.
--
-- Safe to run any time (additive, backwards compatible): existing rows get
-- `now()` as their updated_at, which is a harmless starting point for
-- optimistic-concurrency checks going forward.

alter table public.omr_class_students
    add column if not exists updated_at timestamptz not null default now();

create index if not exists omr_class_students_updated_at_idx
    on public.omr_class_students (updated_at desc);

-- Follow-up (not included here — application code changes, tracked
-- separately, not a schema concern):
--   1. Stamp `updated_at = now()` on every write to this table from
--      rosterPersistence.ts (rosterEnrollmentToSupabaseRow currently doesn't
--      set it — mirror rosterStudentToSupabaseRow/rosterGroupToSupabaseRow).
--   2. Extend RosterSnapshot (or a side-channel map) to retain each row's
--      last-read updated_at so a save can pass it back as the `.eq(...)`
--      guard described above.
--   3. Switch saveRosterSnapshot's upserts to the conditional update+insert
--      pattern for all three roster tables, treating "0 rows affected" as a
--      conflict to re-merge rather than a silent overwrite.
