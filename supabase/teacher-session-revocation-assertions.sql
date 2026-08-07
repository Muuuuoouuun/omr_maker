\set ON_ERROR_STOP on

begin;

insert into public.omr_teacher_accounts (
    id, email, display_name, password_hash, status, email_verified_at
) values (
    'teacher_0123456789abcdef',
    'revocation@example.com',
    'Revocation Teacher',
    'pbkdf2-sha256:120000:' || repeat('a', 32) || ':' || repeat('b', 64),
    'active',
    now()
);

do $$
begin
    if not public.omr_validate_teacher_session_v1('teacher_0123456789abcdef', 1)
       or public.omr_validate_teacher_session_v1('teacher_0123456789abcdef', 2) then
        raise exception 'initial teacher session generation validation failed';
    end if;

    if not public.omr_begin_teacher_password_reset_v1(
        'teacher_token_0123456789abcdefghijklmn',
        'revocation@example.com',
        repeat('c', 64),
        now() + interval '1 hour'
    ) then
        raise exception 'teacher password reset fixture creation failed';
    end if;

    if not public.omr_complete_teacher_password_reset_v1(
        repeat('c', 64),
        'pbkdf2-sha256:120000:' || repeat('d', 32) || ':' || repeat('e', 64)
    ) then
        raise exception 'teacher password reset fixture completion failed';
    end if;

    if public.omr_validate_teacher_session_v1('teacher_0123456789abcdef', 1)
       or not public.omr_validate_teacher_session_v1('teacher_0123456789abcdef', 2) then
        raise exception 'password reset did not revoke generation 1';
    end if;

    update public.omr_teacher_accounts
       set status = 'disabled'
     where id = 'teacher_0123456789abcdef';
    if public.omr_validate_teacher_session_v1('teacher_0123456789abcdef', 2)
       or (select session_generation from public.omr_teacher_accounts
            where id = 'teacher_0123456789abcdef') is distinct from 3::bigint then
        raise exception 'disable did not revoke generation 2';
    end if;

    -- A same-state update cannot advance twice, and reactivation must not make
    -- any generation issued before disable valid again.
    update public.omr_teacher_accounts
       set display_name = 'Revocation Teacher Disabled'
     where id = 'teacher_0123456789abcdef';
    update public.omr_teacher_accounts
       set status = 'active'
     where id = 'teacher_0123456789abcdef';
    if public.omr_validate_teacher_session_v1('teacher_0123456789abcdef', 2)
       or not public.omr_validate_teacher_session_v1('teacher_0123456789abcdef', 3) then
        raise exception 'reactivation revived a revoked generation';
    end if;
end
$$;

rollback;
