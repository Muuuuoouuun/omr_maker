\set ON_ERROR_STOP on

-- schema.sql models alpha/local direct browser writers. Exercise the generated
-- expressions as the browser roles before production migration 003 revokes
-- these helper grants.
set role anon;
select public.omr_exam_question_summaries_v1(
    '{"questions":[{"id":1,"number":1,"answer":2}]}'::jsonb
);
select public.omr_student_question_summaries_v1(
    '{"studentQuestions":[{"questionId":1,"questionNumber":1}]}'::jsonb
);
reset role;

set role authenticated;
select public.omr_exam_question_summaries_v1(
    '{"questions":[{"id":1,"number":1,"answer":2}]}'::jsonb
);
select public.omr_student_question_summaries_v1(
    '{"studentQuestions":[{"questionId":1,"questionNumber":1}]}'::jsonb
);
reset role;
