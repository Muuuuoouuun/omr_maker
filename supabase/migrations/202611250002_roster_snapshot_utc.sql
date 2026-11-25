begin;

-- JSON serialization of timestamptz otherwise inherits the caller's time zone.
-- The roster gateway expects UTC for class and student update timestamps.
alter function public.omr_load_roster_v2(text) set timezone to 'UTC';

commit;
