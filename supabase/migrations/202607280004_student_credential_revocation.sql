begin;

delete from public.omr_student_start_credentials credential
using public.omr_student_profiles student
where student.organization_id = credential.organization_id
  and student.id = credential.student_profile_id
  and student.status = 'withdrawn';

create or replace function public.omr_revoke_withdrawn_student_credential_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.status = 'withdrawn'
       and old.status is distinct from 'withdrawn' then
        delete from public.omr_student_start_credentials
        where organization_id = old.organization_id
          and student_profile_id = old.id;
    end if;
    return new;
end;
$$;

revoke all on function public.omr_revoke_withdrawn_student_credential_v1()
    from public, anon, authenticated;

drop trigger if exists omr_student_profile_credential_revocation
    on public.omr_student_profiles;
create trigger omr_student_profile_credential_revocation
    before update of status on public.omr_student_profiles
    for each row
    execute function public.omr_revoke_withdrawn_student_credential_v1();

commit;
