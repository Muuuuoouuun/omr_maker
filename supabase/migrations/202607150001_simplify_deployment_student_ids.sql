-- Keep stable profile ids, enrollment links, attempts, and start-code hashes intact.
-- Only replace the administrator workspace's deployment-test login identifiers.
update public.omr_student_profiles
set
    external_id = case external_id
        when 'deploy-student-001' then 'student1'
        when 'deploy-student-002' then 'student2'
        when 'deploy-student-003' then 'student3'
        when 'deploy-student-004' then 'student4'
        else external_id
    end,
    updated_at = now()
where organization_id = 'teacher_0en845w'
  and external_id in (
      'deploy-student-001',
      'deploy-student-002',
      'deploy-student-003',
      'deploy-student-004'
  );
