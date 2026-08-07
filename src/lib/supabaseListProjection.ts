import {
    attemptFromSupabaseRow,
    examFromSupabaseRow,
    type SupabaseAttemptRow,
    type SupabaseExamRow,
} from "@/lib/omrPersistence";
import type { Attempt, Exam } from "@/types/omr";
import { answeredQuestionSummaryFromListValue, type StudentAssignmentPreview, type StudentAttemptSummary } from "@/lib/studentExamContract";
import type { TeacherAttemptSummary } from "@/lib/teacherAttemptSummary";

type ListRow = Record<string, unknown>;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown, fallback = 0): number {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalObject<T extends object>(value: unknown): T | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as T : undefined;
}

function optionalArray<T>(value: unknown): T[] | undefined {
    return Array.isArray(value) ? value as T[] : undefined;
}

function withOptional<T extends object>(value: T | undefined, key: string): Record<string, unknown> {
    return value === undefined ? {} : { [key]: value };
}

function withOptionalString(value: unknown, key: string): Record<string, unknown> {
    const normalized = clean(value);
    return normalized ? { [key]: normalized } : {};
}

function withOptionalNumber(value: unknown, key: string): Record<string, unknown> {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? { [key]: parsed } : {};
}

export function studentAssignmentPreviewFromSupabaseListRow(value: unknown): StudentAssignmentPreview {
    const row = value as ListRow;
    const id = clean(row.id);
    const title = clean(row.title);
    const createdAt = clean(row.created_at);
    if (!id || !title || !createdAt) throw new Error("Invalid student assignment preview");
    return {
        id,
        title,
        createdAt,
        ...withOptionalString(row.updated_at, "updatedAt"),
        ...withOptionalNumber(row.duration_min, "durationMin"),
        ...withOptionalString(row.start_at, "startAt"),
        ...withOptionalString(row.end_at, "endAt"),
        archived: row.archived === true,
        access: {
            type: row.access_type === "targeted" ? "targeted" : row.access_type === "group" ? "group" : "public",
            entryCheck: "required",
        },
    };
}

export function studentAttemptSummaryFromSupabaseListRow(value: unknown): StudentAttemptSummary {
    const row = value as ListRow;
    const id = clean(row.id);
    const examId = clean(row.exam_id);
    const examTitle = clean(row.exam_title);
    const startedAt = clean(row.started_at);
    const finishedAt = clean(row.finished_at);
    if (!id || !examId || !examTitle || !startedAt || !finishedAt) {
        throw new Error("Invalid student attempt summary");
    }
    return {
        id,
        examId,
        ...withOptionalString(row.assignment_id, "assignmentId"),
        examTitle,
        status: row.status === "in_progress" ? "in_progress" : "completed",
        score: finiteNumber(row.score),
        totalScore: finiteNumber(row.total_score),
        startedAt,
        finishedAt,
        ...withOptionalString(row.retake_source_attempt_id, "retakeSourceAttemptId"),
        ...answeredQuestionSummaryFromListValue(row.student_question_summaries),
    } as StudentAttemptSummary;
}

export function examFromSupabaseListRow(value: unknown): Exam {
    const row = value as ListRow;
    const payload: Exam = {
        id: clean(row.id),
        title: clean(row.title),
        createdAt: clean(row.created_at),
        questions: Array.isArray(row.questions) ? row.questions as Exam["questions"] : [],
        ...withOptionalString(row.updated_at, "updatedAt"),
        ...withOptionalNumber(row.duration_min, "durationMin"),
        ...withOptionalString(row.start_at, "startAt"),
        ...withOptionalString(row.end_at, "endAt"),
        ...withOptional(optionalObject<NonNullable<Exam["accessConfig"]>>(row.access_config), "accessConfig"),
        ...withOptional(optionalObject<NonNullable<Exam["pdfDataRef"]>>(row.pdf_data_ref), "pdfDataRef"),
        ...(row.archived === true ? { archived: true } : {}),
    };

    const exam = examFromSupabaseRow({
        id: payload.id,
        organization_id: clean(row.organization_id) || null,
        class_id: clean(row.class_id) || null,
        title: payload.title,
        payload,
        created_by_user_id: clean(row.created_by_user_id) || null,
        created_at: payload.createdAt,
        updated_at: clean(row.updated_at) || payload.createdAt,
        archived: row.archived === true,
    } as SupabaseExamRow);
    return {
        ...exam,
        archived: row.archived === true,
        durationMin: typeof row.duration_min === "number" && Number.isFinite(row.duration_min)
            ? row.duration_min
            : undefined,
        startAt: clean(row.start_at) || undefined,
        endAt: clean(row.end_at) || undefined,
        accessConfig: optionalObject<NonNullable<Exam["accessConfig"]>>(row.access_config),
        pdfDataRef: optionalObject<NonNullable<Exam["pdfDataRef"]>>(row.pdf_data_ref),
    };
}

export function attemptFromSupabaseListRow(value: unknown): Attempt {
    const row = value as ListRow;
    const payload: Attempt = {
        id: clean(row.id),
        examId: clean(row.exam_id),
        examTitle: clean(row.exam_title),
        studentName: clean(row.student_name),
        startedAt: clean(row.started_at),
        finishedAt: clean(row.finished_at),
        score: finiteNumber(row.score),
        totalScore: finiteNumber(row.total_score),
        answers: optionalObject<Attempt["answers"]>(row.answers) || {},
        status: row.status === "in_progress" ? "in_progress" : "completed",
        ...withOptionalString(row.guest_id, "guestId"),
        ...withOptionalString(row.student_id, "studentId"),
        ...withOptionalString(row.group_id, "groupId"),
        ...withOptionalString(row.group_name, "groupName"),
        ...withOptionalString(row.region_id, "regionId"),
        ...withOptionalString(row.region_name, "regionName"),
        ...withOptionalString(row.identity_type, "identityType"),
        ...withOptional(optionalArray<NonNullable<Attempt["questionResults"]>[number]>(row.question_results), "questionResults"),
        ...withOptional(optionalArray<NonNullable<Attempt["questionTimings"]>[number]>(row.question_timings), "questionTimings"),
        ...withOptional(optionalArray<NonNullable<Attempt["focusLossEvents"]>[number]>(row.focus_loss_events), "focusLossEvents"),
        ...withOptional(optionalArray<NonNullable<Attempt["studentQuestions"]>[number]>(row.student_questions), "studentQuestions"),
        ...withOptional(optionalObject<NonNullable<Attempt["drawingsRef"]>>(row.drawings_ref), "drawingsRef"),
        ...withOptional(optionalObject<NonNullable<Attempt["handwriting"]>>(row.handwriting), "handwriting"),
        ...withOptional(optionalArray<NonNullable<Attempt["questionDrawings"]>[number]>(row.question_drawings), "questionDrawings"),
        ...withOptional(optionalObject<NonNullable<Attempt["retake"]>>(row.retake), "retake"),
        ...(row.auto_submitted === true ? { autoSubmitted: true } : {}),
        ...(row.handwriting_archived === true ? { handwritingArchived: true } : {}),
        ...withOptionalString(row.handwriting_plan, "handwritingPlan"),
        ...withOptionalNumber(row.tab_foci_lost_count, "tabFociLostCount"),
        ...withOptionalNumber(row.drawing_page_count, "drawingPageCount"),
        ...withOptionalNumber(row.drawing_stroke_count, "drawingStrokeCount"),
        ...withOptionalString(row.merged_from_guest_id, "mergedFromGuestId"),
        ...withOptionalString(row.merged_at, "mergedAt"),
    };

    const attempt = attemptFromSupabaseRow({
        id: payload.id,
        organization_id: clean(row.organization_id) || null,
        class_id: clean(row.class_id) || null,
        assignment_id: clean(row.assignment_id) || null,
        student_profile_id: clean(row.student_profile_id) || null,
        exam_id: payload.examId,
        student_name: payload.studentName,
        student_id: clean(row.student_id) || null,
        group_id: clean(row.group_id) || null,
        group_name: clean(row.group_name) || null,
        region_id: clean(row.region_id) || null,
        region_name: clean(row.region_name) || null,
        identity_type: row.identity_type === "guest" || row.identity_type === "temporary" || row.identity_type === "registered"
            ? row.identity_type
            : null,
        status: payload.status,
        score: payload.score,
        total_score: payload.totalScore,
        score_percent: finiteNumber(row.score_percent),
        retake_source_attempt_id: clean(row.retake_source_attempt_id) || null,
        retake_mode: row.retake_mode === "wrong" || row.retake_mode === "similar" || row.retake_mode === "custom"
            ? row.retake_mode
            : null,
        retake_question_ids: Array.isArray(row.retake_question_ids)
            ? row.retake_question_ids.map(item => finiteNumber(item)).filter(Number.isFinite)
            : [],
        merged_from_guest_id: clean(row.merged_from_guest_id) || null,
        merged_at: clean(row.merged_at) || null,
        payload,
        started_at: payload.startedAt,
        finished_at: payload.finishedAt,
    } as SupabaseAttemptRow);
    return {
        ...attempt,
        studentQuestions: optionalArray<NonNullable<Attempt["studentQuestions"]>[number]>(row.student_questions),
        drawingsRef: optionalObject<NonNullable<Attempt["drawingsRef"]>>(row.drawings_ref),
        handwriting: optionalObject<NonNullable<Attempt["handwriting"]>>(row.handwriting),
        questionDrawings: optionalArray<NonNullable<Attempt["questionDrawings"]>[number]>(row.question_drawings),
        retake: optionalObject<NonNullable<Attempt["retake"]>>(row.retake),
        autoSubmitted: row.auto_submitted === true,
        handwritingArchived: row.handwriting_archived === true,
    };
}

export function teacherAttemptSummaryFromSupabaseListRow(value: unknown): TeacherAttemptSummary {
    const row = value as ListRow;
    const id = clean(row.id);
    const examId = clean(row.exam_id);
    const examTitle = clean(row.exam_title);
    const studentName = clean(row.student_name);
    const startedAt = clean(row.started_at);
    const finishedAt = clean(row.finished_at);
    if (!id || !examId || !examTitle || !studentName || !startedAt || !finishedAt) {
        throw new Error("Invalid teacher attempt summary");
    }

    const retakeSourceAttemptId = clean(row.retake_source_attempt_id);
    const retakeMode = row.retake_mode === "wrong" || row.retake_mode === "similar" || row.retake_mode === "custom"
        ? row.retake_mode
        : undefined;
    const retakeQuestionIds = Array.isArray(row.retake_question_ids)
        ? row.retake_question_ids
            .map(item => finiteNumber(item, Number.NaN))
            .filter(Number.isFinite)
        : [];

    return {
        id,
        examId,
        examTitle,
        studentName,
        startedAt,
        finishedAt,
        ...withOptionalString(row.updated_at, "updatedAt"),
        score: finiteNumber(row.score),
        totalScore: finiteNumber(row.total_score),
        answers: {},
        detailLevel: "summary",
        status: row.status === "in_progress" ? "in_progress" : "completed",
        ...withOptionalString(row.organization_id, "organizationId"),
        ...withOptionalString(row.class_id, "classId"),
        ...withOptionalString(row.assignment_id, "assignmentId"),
        ...withOptionalString(row.student_profile_id, "studentProfileId"),
        ...withOptionalString(row.student_id, "studentId"),
        ...withOptionalString(row.group_id, "groupId"),
        ...withOptionalString(row.group_name, "groupName"),
        ...withOptionalString(row.region_id, "regionId"),
        ...withOptionalString(row.region_name, "regionName"),
        ...withOptionalString(row.identity_type, "identityType"),
        ...withOptionalString(row.guest_id, "guestId"),
        ...withOptionalString(row.merged_from_guest_id, "mergedFromGuestId"),
        ...withOptionalString(row.merged_at, "mergedAt"),
        ...withOptional(optionalArray<NonNullable<Attempt["studentQuestions"]>[number]>(row.student_questions), "studentQuestions"),
        ...withOptional(optionalObject<NonNullable<Attempt["drawingsRef"]>>(row.drawings_ref), "drawingsRef"),
        ...withOptional(optionalObject<NonNullable<TeacherAttemptSummary["handwritingStrokesRef"]>>(row.handwriting_strokes_ref), "handwritingStrokesRef"),
        ...(row.auto_submitted === true ? { autoSubmitted: true } : {}),
        ...(row.handwriting_archived === true ? { handwritingArchived: true } : {}),
        ...withOptionalString(row.handwriting_plan, "handwritingPlan"),
        ...withOptionalNumber(row.tab_foci_lost_count, "tabFociLostCount"),
        ...withOptionalNumber(row.handwriting_question_count, "handwritingQuestionCount"),
        ...withOptionalNumber(row.drawing_page_count, "drawingPageCount"),
        ...withOptionalNumber(row.drawing_stroke_count, "drawingStrokeCount"),
        ...(retakeSourceAttemptId && retakeMode ? {
            retake: {
                sourceAttemptId: retakeSourceAttemptId,
                questionIds: retakeQuestionIds,
                mode: retakeMode,
                createdAt: finishedAt,
            },
        } : {}),
    } as TeacherAttemptSummary;
}
