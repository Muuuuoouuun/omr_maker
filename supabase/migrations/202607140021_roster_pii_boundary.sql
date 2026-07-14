begin;

-- Teacher roster and student sign-in flows already use authenticated server
-- actions backed by the service role. Remove the alpha browser boundary so
-- names, emails, class membership, and student identifiers cannot be read or
-- changed with a publishable key.
alter table public.omr_classes enable row level security;
alter table public.omr_classes force row level security;
alter table public.omr_student_profiles enable row level security;
alter table public.omr_student_profiles force row level security;
alter table public.omr_class_students enable row level security;
alter table public.omr_class_students force row level security;

drop policy if exists "OMR classes are publicly writable"
    on public.omr_classes;
drop policy if exists "OMR student profiles are publicly writable"
    on public.omr_student_profiles;
drop policy if exists "OMR class students are publicly writable"
    on public.omr_class_students;

revoke all on table public.omr_classes from anon, authenticated;
revoke all on table public.omr_student_profiles from anon, authenticated;
revoke all on table public.omr_class_students from anon, authenticated;

grant all on table public.omr_classes to service_role;
grant all on table public.omr_student_profiles to service_role;
grant all on table public.omr_class_students to service_role;

commit;
