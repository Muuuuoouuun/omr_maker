// Canonical reads reconstruct domain objects from payload and only need the
// explicit scope columns layered on top. Centralized projections avoid
// transferring every analytical fact column and keep future schema additions
// from silently increasing dashboard/history response size.
export const SUPABASE_EXAM_READ_COLUMNS = "id, organization_id, class_id, title, payload, created_by_user_id, created_at, updated_at, archived, revision";

export const SUPABASE_ATTEMPT_READ_COLUMNS = "organization_id, class_id, assignment_id, assignment_revision, question_results_question_count, question_results_definition_manifest_hash, question_results_full_evidence_hash, student_profile_id, payload";

/**
 * List-only projections. JSON paths deliberately select only fields consumed
 * by dashboard/history analytics; the full payload and inline binary-shaped
 * fields remain exclusive to single-record detail reads.
 */
export const SUPABASE_EXAM_LIST_READ_COLUMNS = [
    "id",
    "organization_id",
    "class_id",
    "title",
    "created_by_user_id",
    "created_at",
    "updated_at",
    "archived",
    "questions:question_summaries",
    "duration_min:payload->durationMin",
    "start_at:payload->>startAt",
    "end_at:payload->>endAt",
    "access_config:payload->accessConfig",
    "pdf_data_ref:payload->pdfDataRef",
].join(", ");

/**
 * Student dashboard rows omit questions and every PDF/answer-key reference.
 * Group ids are server-only visibility inputs and are stripped from responses.
 */
export const SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS = [
    "id",
    "organization_id",
    "class_id",
    "title",
    "created_at",
    "updated_at",
    "archived",
    "duration_min:payload->durationMin",
    "start_at:payload->>startAt",
    "end_at:payload->>endAt",
    "access_type:payload->accessConfig->>type",
    "access_group_ids:payload->accessConfig->groupIds",
].join(", ");

/** Student dashboard submission rows; detail/review data loads by attempt id. */
export const SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS = [
    "id",
    "exam_id",
    "assignment_id",
    "assignment_revision",
    "question_results_question_count",
    "status",
    "score",
    "total_score",
    "retake_source_attempt_id",
    "started_at",
    "finished_at",
    "exam_title:payload->>examTitle",
    "student_question_summaries",
].join(", ");

/**
 * Shared teacher workspace rows. Per-question answer/result/timing/focus data
 * and handwriting bodies are intentionally reserved for explicit detail reads.
 */
export const SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS = [
    "id",
    "organization_id",
    "class_id",
    "assignment_id",
    "assignment_revision",
    "question_results_question_count",
    "student_profile_id",
    "exam_id",
    "student_name",
    "student_id",
    "group_id",
    "group_name",
    "region_id",
    "region_name",
    "identity_type",
    "status",
    "score",
    "total_score",
    "score_percent",
    "retake_source_attempt_id",
    "retake_mode",
    "retake_question_ids",
    "merged_from_guest_id",
    "merged_at",
    "started_at",
    "finished_at",
    "updated_at",
    "exam_title:payload->>examTitle",
    "guest_id:payload->>guestId",
    "student_questions:student_question_summaries",
    "auto_submitted:payload->autoSubmitted",
    "tab_foci_lost_count:payload->tabFociLostCount",
    "drawings_ref:payload->drawingsRef",
    "handwriting_strokes_ref:payload->handwriting->strokesRef",
    "handwriting_archived:payload->handwritingArchived",
    "handwriting_plan:payload->>handwritingPlan",
    "handwriting_question_count:payload->handwriting->summary->questionCount",
    "drawing_page_count:payload->drawingPageCount",
    "drawing_stroke_count:payload->drawingStrokeCount",
].join(", ");

export const SUPABASE_ATTEMPT_LIST_READ_COLUMNS = [
    "id",
    "organization_id",
    "class_id",
    "assignment_id",
    "assignment_revision",
    "question_results_question_count",
    "question_results_definition_manifest_hash",
    "question_results_full_evidence_hash",
    "student_profile_id",
    "exam_id",
    "student_name",
    "student_id",
    "group_id",
    "group_name",
    "region_id",
    "region_name",
    "identity_type",
    "status",
    "score",
    "total_score",
    "score_percent",
    "retake_source_attempt_id",
    "retake_mode",
    "retake_question_ids",
    "merged_from_guest_id",
    "merged_at",
    "started_at",
    "finished_at",
    "exam_title:payload->>examTitle",
    "guest_id:payload->>guestId",
    "answers:payload->answers",
    "question_results:payload->questionResults",
    "question_results_source:payload->>questionResultsSource",
    "question_timings:payload->questionTimings",
    "focus_loss_events:payload->focusLossEvents",
    "student_questions:student_question_summaries",
    "auto_submitted:payload->autoSubmitted",
    "tab_foci_lost_count:payload->tabFociLostCount",
    "drawings_ref:payload->drawingsRef",
    "handwriting:payload->handwriting",
    "handwriting_archived:payload->handwritingArchived",
    "handwriting_plan:payload->>handwritingPlan",
    "drawing_page_count:payload->drawingPageCount",
    "drawing_stroke_count:payload->drawingStrokeCount",
    "question_drawings:payload->questionDrawings",
    "retake:payload->retake",
].join(", ");
