import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    SUPABASE_ATTEMPT_LIST_READ_COLUMNS,
    SUPABASE_EXAM_LIST_READ_COLUMNS,
    SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS,
    SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS,
    SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS,
} from "@/lib/supabaseReadColumns";
import {
    attemptFromSupabaseListRow,
    examFromSupabaseListRow,
    studentAssignmentPreviewFromSupabaseListRow,
    studentAttemptSummaryFromSupabaseListRow,
    teacherAttemptSummaryFromSupabaseListRow,
} from "@/lib/supabaseListProjection";
import { answeredQuestionKeys, collectStudentQuestionInbox } from "@/lib/studentQuestions";

describe("canonical list projections", () => {
    it("uses a lightweight teacher attempt summary without answer, analytics, focus, or handwriting payloads", () => {
        const forbidden = [
            "answers",
            "question_results",
            "question_timings",
            "focus_loss_events",
            "handwriting:payload->handwriting",
            "question_drawings",
            "retake:payload->retake",
        ];
        for (const field of forbidden) {
            expect(SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS.toLowerCase())
                .not.toContain(field.toLowerCase());
        }
        expect(SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS.split(/\s*,\s*/)).not.toContain("payload");
        expect(SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS.split(/\s*,\s*/)).toContain("updated_at");
        expect(SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS).toContain("student_questions:student_question_summaries");
        expect(SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS).toContain("handwriting_question_count:payload->handwriting->summary->questionCount");

        const summary = teacherAttemptSummaryFromSupabaseListRow({
            id: "attempt-summary",
            organization_id: "org-1",
            class_id: "class-1",
            assignment_id: "assignment-1",
            student_profile_id: "profile-1",
            exam_id: "exam-1",
            exam_title: "목록 시험",
            student_name: "학생",
            student_id: "student-1",
            group_id: "group-1",
            group_name: "1반",
            region_id: "region-1",
            region_name: "서울",
            identity_type: "registered",
            status: "completed",
            score: 8,
            total_score: 10,
            retake_source_attempt_id: "attempt-source",
            retake_mode: "wrong",
            retake_question_ids: [2, 4],
            started_at: "2026-08-06T00:00:00.000Z",
            finished_at: "2026-08-06T00:10:00.000Z",
            updated_at: "2026-08-06T00:11:00.000Z",
            student_questions: [],
            handwriting_archived: true,
            handwriting_question_count: 2,
            drawing_page_count: 3,
            drawing_stroke_count: 20,
            drawings_ref: { store: "remote", key: "drawing-key" },
            handwriting_strokes_ref: { store: "remote", key: "stroke-key" },
            answers: { 1: 2 },
            question_results: [{ correctAnswer: 2 }],
            question_timings: [{ totalTimeSec: 10 }],
            focus_loss_events: [{ reason: "hidden" }],
            handwriting: { secret: "large-body" },
            question_drawings: [{ questionId: 1 }],
        });

        expect(summary).toMatchObject({
            id: "attempt-summary",
            organizationId: "org-1",
            examId: "exam-1",
            studentName: "학생",
            score: 8,
            totalScore: 10,
            answers: {},
            detailLevel: "summary",
            updatedAt: "2026-08-06T00:11:00.000Z",
            handwritingArchived: true,
            handwritingQuestionCount: 2,
            drawingPageCount: 3,
            drawingStrokeCount: 20,
            retake: {
                sourceAttemptId: "attempt-source",
                mode: "wrong",
                questionIds: [2, 4],
            },
        });
        expect(JSON.stringify(summary)).not.toMatch(/questionResults|questionTimings|focusLossEvents|large-body|questionDrawings/);
    });

    it("uses a student assignment projection with no question, PDF, answer-key, or access-secret data", () => {
        expect(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS).toContain("access_type:payload->accessConfig->>type");
        expect(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS).toContain("access_group_ids:payload->accessConfig->groupIds");
        expect(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS).not.toContain("question_summaries");
        expect(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS).not.toContain("questions");
        expect(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS).not.toContain("pdfData");
        expect(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS).not.toContain("answerKey");
        expect(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS).not.toContain("access_config");
        expect(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS).not.toContain("pin");

        const preview = studentAssignmentPreviewFromSupabaseListRow({
            id: "exam-student-list",
            organization_id: "org-1",
            class_id: "class-1",
            title: "학생 목록 시험",
            created_at: "2026-08-06T00:00:00.000Z",
            updated_at: "2026-08-06T01:00:00.000Z",
            archived: false,
            duration_min: 50,
            start_at: "2026-08-07T00:00:00.000Z",
            end_at: "2026-08-07T01:00:00.000Z",
            access_type: "group",
            access_group_ids: ["class-1"],
            questions: [{ id: 1, label: "비밀 지문", answer: 3 }],
            pdf_data_ref: { key: "private-object" },
            access_config: { type: "group", groupIds: ["class-1"], pin: "4321" },
        }, "2026-08-07T00:30:00.000Z");

        expect(preview).toEqual({
            id: "exam-student-list",
            title: "학생 목록 시험",
            createdAt: "2026-08-06T00:00:00.000Z",
            updatedAt: "2026-08-06T01:00:00.000Z",
            durationMin: 50,
            lifecycle: "open",
            startsAt: "2026-08-07T00:00:00.000Z",
            endsAt: "2026-08-07T01:00:00.000Z",
            archived: false,
            access: { type: "group", entryCheck: "required" },
        });
        expect(JSON.stringify(preview)).not.toMatch(/비밀 지문|private-object|4321/);
    });

    it("fails closed when a student assignment projection has invalid lifecycle data", () => {
        const base = {
            id: "exam-invalid",
            title: "학생 목록 시험",
            created_at: "2026-08-06T00:00:00.000Z",
            updated_at: "2026-08-06T01:00:00.000Z",
            archived: false,
            duration_min: 50,
            start_at: null,
            end_at: null,
            access_type: "group",
        };
        for (const override of [
            { archived: "false" },
            { archived: undefined },
            { start_at: "tomorrow" },
            { end_at: "2026-08-07" },
            { start_at: "2026-08-07T02:00:00.000Z", end_at: "2026-08-07T01:00:00.000Z" },
        ]) {
            expect(() => studentAssignmentPreviewFromSupabaseListRow(
                { ...base, ...override }, "2026-08-07T00:30:00.000Z",
            )).toThrow("Invalid student assignment lifecycle");
        }
        expect(() => studentAssignmentPreviewFromSupabaseListRow(base, "not-server-time"))
            .toThrow("Invalid student assignment lifecycle");
    });

    it("keeps absent lifecycle timestamps optional", () => {
        const preview = studentAssignmentPreviewFromSupabaseListRow({
            id: "exam-unbounded",
            title: "상시 시험",
            created_at: "2026-08-06T00:00:00.000Z",
            archived: false,
            start_at: null,
            end_at: null,
            access_type: "public",
        }, "2026-08-07T00:30:00.000Z");
        expect(preview).toMatchObject({ lifecycle: "open" });
        expect(preview).not.toHaveProperty("startsAt");
        expect(preview).not.toHaveProperty("endsAt");
    });

    it.each([
        ["typo", "targetted"],
        ["object", { type: "targeted" }],
        ["missing", undefined],
    ])("fails closed for a %s student assignment access type", (_label, accessType) => {
        expect(() => studentAssignmentPreviewFromSupabaseListRow({
            id: "exam-invalid-access",
            title: "학생 목록 시험",
            created_at: "2026-08-06T00:00:00.000Z",
            archived: false,
            start_at: null,
            end_at: null,
            access_type: accessType,
        }, "2026-08-07T00:30:00.000Z")).toThrow("Invalid student assignment access type");
    });

    it("uses an explicit student attempt summary projection with no pre-entry secrets or telemetry", () => {
        const forbidden = [
            "student_name",
            "student_id",
            "answers",
            "question_results",
            "correctAnswer",
            "pdf",
            "tags",
            "question_timings",
            "focus_loss_events",
            "drawings",
            "handwriting",
        ];
        for (const field of forbidden) {
            expect(SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS.toLowerCase()).not.toContain(field.toLowerCase());
        }
        expect(SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS.split(/\s*,\s*/)).not.toContain("payload");
        expect(SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS).toContain("exam_title:payload->>examTitle");
        expect(SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS).toContain("student_question_summaries");

        const summary = studentAttemptSummaryFromSupabaseListRow({
            id: "attempt-1",
            exam_id: "exam-1",
            assignment_id: "assignment-1",
            exam_title: "목록 시험",
            status: "completed",
            score: 7,
            total_score: 10,
            started_at: "2026-08-06T00:00:00.000Z",
            finished_at: "2026-08-06T00:10:00.000Z",
            retake_source_attempt_id: "attempt-origin",
            student_question_summaries: [
                { questionId: 1, status: "queued", body: "", createdAt: "2026-08-06T00:03:00.000Z" },
                { questionId: 2, status: "answered", body: "", answer: { body: "", createdAt: "2026-08-06T00:09:00.000Z" } },
            ],
            answers: { 1: 2 },
            question_results: [{ correctAnswer: 2 }],
            pdf_data_ref: { key: "pdf-secret" },
            question_timings: [{ totalTimeSec: 10 }],
            focus_loss_events: [{ reason: "hidden" }],
            drawings_ref: { key: "drawing-secret" },
            handwriting: { key: "handwriting-secret" },
        });

        expect(summary).toEqual({
            id: "attempt-1",
            examId: "exam-1",
            assignmentId: "assignment-1",
            examTitle: "목록 시험",
            status: "completed",
            score: 7,
            totalScore: 10,
            startedAt: "2026-08-06T00:00:00.000Z",
            finishedAt: "2026-08-06T00:10:00.000Z",
            retakeSourceAttemptId: "attempt-origin",
            answeredQuestionCount: 1,
            latestAnsweredAt: "2026-08-06T00:09:00.000Z",
        });
        expect(JSON.stringify(summary)).not.toMatch(/student_question_summaries|questionId|body|answers|correctAnswer|pdf-secret|question_timings|focus_loss_events|drawing-secret|handwriting-secret/);
    });

    it("uses list projections only on list reads while detail reads retain full payloads", () => {
        const teacherExamGateway = readFileSync(join(process.cwd(), "src/lib/teacherExamGateway.ts"), "utf8");
        const teacherAttemptGateway = readFileSync(join(process.cwd(), "src/lib/teacherAttemptGateway.ts"), "utf8");
        const studentAttemptGateway = readFileSync(join(process.cwd(), "src/lib/studentAttemptReadGateway.ts"), "utf8");
        const adminGateway = readFileSync(join(process.cwd(), "src/lib/supabaseServerAdmin.ts"), "utf8");

        expect(teacherExamGateway).toContain(".select(SUPABASE_EXAM_LIST_READ_COLUMNS)");
        expect(teacherExamGateway).toContain("examFromSupabaseListRow");
        expect(teacherExamGateway).toContain(".select(SUPABASE_EXAM_READ_COLUMNS)");
        expect(teacherAttemptGateway).toContain(".select(columns)");
        expect(teacherAttemptGateway).toContain("SUPABASE_ATTEMPT_LIST_READ_COLUMNS,");
        expect(teacherAttemptGateway).toContain("SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS,");
        expect(teacherAttemptGateway).toContain("attemptFromSupabaseListRow");
        expect(studentAttemptGateway).toContain(".select(SUPABASE_ATTEMPT_LIST_READ_COLUMNS)");
        expect(studentAttemptGateway).toContain("attemptFromSupabaseListRow");
        expect(adminGateway).toContain(".select(SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS)");
        expect(adminGateway).toContain(".select(SUPABASE_EXAM_LIST_READ_COLUMNS)");
        expect(adminGateway).toContain(".select(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS)");
        expect(adminGateway).toContain(".select(SUPABASE_ATTEMPT_READ_COLUMNS)");
        expect(adminGateway).toContain(".select(SUPABASE_EXAM_READ_COLUMNS)");
    });

    it("excludes full payloads, inline PDFs, drawings, and free-text response maps at the database boundary", () => {
        expect(SUPABASE_EXAM_LIST_READ_COLUMNS.split(/\s*,\s*/)).not.toContain("payload");
        expect(SUPABASE_EXAM_LIST_READ_COLUMNS).not.toMatch(/payload->pdfData(?:,|$)/);
        expect(SUPABASE_EXAM_LIST_READ_COLUMNS).not.toContain("answerKeyPdf");
        expect(SUPABASE_ATTEMPT_LIST_READ_COLUMNS.split(/\s*,\s*/)).not.toContain("payload");
        expect(SUPABASE_ATTEMPT_LIST_READ_COLUMNS).not.toMatch(/payload->drawings(?:,|$)/);
        expect(SUPABASE_ATTEMPT_LIST_READ_COLUMNS).not.toContain("subQuestionAnswers");
        expect(SUPABASE_ATTEMPT_LIST_READ_COLUMNS).toContain("answers:payload->answers");
        expect(SUPABASE_ATTEMPT_LIST_READ_COLUMNS).toContain("question_results:payload->questionResults");
        expect(SUPABASE_ATTEMPT_LIST_READ_COLUMNS).toContain("student_questions:student_question_summaries");
        expect(SUPABASE_ATTEMPT_LIST_READ_COLUMNS).not.toContain("payload->studentQuestions");
        expect(SUPABASE_EXAM_LIST_READ_COLUMNS).toContain("questions:question_summaries");
        expect(SUPABASE_EXAM_LIST_READ_COLUMNS).not.toContain("payload->questions");
    });

    it("reconstructs the exam list contract without legacy PDF bodies or answer-key references", () => {
        const exam = examFromSupabaseListRow({
            id: "exam-1",
            organization_id: "org-1",
            class_id: "class-1",
            title: "목록 시험",
            created_by_user_id: "teacher-1",
            created_at: "2026-07-14T00:00:00.000Z",
            updated_at: "2026-07-15T00:00:00.000Z",
            archived: false,
            questions: [{ id: 1, number: 1, answer: 2, choices: 5 }],
            duration_min: 50,
            start_at: "2026-07-16T00:00:00.000Z",
            end_at: "2026-07-16T01:00:00.000Z",
            access_config: { type: "group", groupIds: ["class-1"], pin: "4321" },
            pdf_data_ref: { store: "remote", key: "problem-1", kind: "problem_pdf", examId: "exam-1" },
        });

        expect(exam).toMatchObject({
            id: "exam-1",
            title: "목록 시험",
            organizationId: "org-1",
            questions: [{ id: 1 }],
            durationMin: 50,
            pdfDataRef: { key: "problem-1" },
        });
        expect(exam).not.toHaveProperty("pdfData");
        expect(exam).not.toHaveProperty("answerKeyPdf");
        expect(exam).not.toHaveProperty("answerKeyPdfRef");
    });

    it("keeps selected false and null list values authoritative", () => {
        const exam = examFromSupabaseListRow({
            id: "exam-clear",
            title: "Clear stale fields",
            created_at: "2026-08-06T00:00:00.000Z",
            archived: false,
            questions: [],
            start_at: null,
            end_at: null,
            access_config: null,
            pdf_data_ref: null,
        });
        const attempt = attemptFromSupabaseListRow({
            id: "attempt-clear",
            exam_id: "exam-clear",
            exam_title: "Clear stale fields",
            student_name: "학생",
            started_at: "2026-08-06T00:00:00.000Z",
            finished_at: "2026-08-06T00:01:00.000Z",
            status: "completed",
            auto_submitted: false,
            handwriting_archived: false,
            drawings_ref: null,
            handwriting: null,
            question_drawings: null,
            retake: null,
        });

        expect(exam).toMatchObject({ archived: false });
        expect(exam).toHaveProperty("startAt", undefined);
        expect(exam).toHaveProperty("endAt", undefined);
        expect(exam).toHaveProperty("accessConfig", undefined);
        expect(exam).toHaveProperty("pdfDataRef", undefined);
        expect(attempt).toMatchObject({ autoSubmitted: false, handwritingArchived: false });
        expect(attempt).toHaveProperty("drawingsRef", undefined);
        expect(attempt).toHaveProperty("handwriting", undefined);
        expect(attempt).toHaveProperty("questionDrawings", undefined);
        expect(attempt).toHaveProperty("retake", undefined);
    });

    it("reconstructs fields consumed by list analytics without pretending omitted detail artifacts exist", () => {
        const attempt = attemptFromSupabaseListRow({
            id: "attempt-1",
            organization_id: "org-1",
            class_id: "class-1",
            assignment_id: null,
            student_profile_id: "student-1",
            exam_id: "exam-1",
            exam_title: "목록 시험",
            guest_id: "guest-1",
            student_name: "학생 1",
            student_id: "student-1",
            group_id: "class-1",
            group_name: "A반",
            region_id: null,
            region_name: null,
            identity_type: "registered",
            status: "completed",
            score: 8,
            total_score: 10,
            score_percent: 80,
            retake_source_attempt_id: null,
            retake_mode: null,
            retake_question_ids: [],
            merged_from_guest_id: null,
            merged_at: null,
            started_at: "2026-07-14T00:00:00.000Z",
            finished_at: "2026-07-14T00:10:00.000Z",
            answers: { 1: 2 },
            question_results: [{
                schemaVersion: 1,
                attemptId: "attempt-1",
                examId: "exam-1",
                examTitle: "목록 시험",
                studentName: "학생 1",
                studentId: "student-1",
                identityType: "registered",
                questionId: 1,
                questionNumber: 1,
                score: 10,
                earnedScore: 8,
                selectedAnswer: 2,
                status: "wrong",
                isCorrect: false,
                isWrong: true,
                isUnanswered: false,
                finishedAt: "2026-07-14T00:10:00.000Z",
            }],
            question_timings: [{ questionId: 1, questionNumber: 1, totalTimeSec: 30, visitCount: 1, revisitCount: 0, answerChangeCount: 0 }],
            focus_loss_events: [{ at: "2026-07-14T00:05:00.000Z", count: 1, reason: "blur" }],
            student_questions: [{
                questionId: 1,
                questionNumber: 1,
                body: "",
                createdAt: "2026-07-14T00:11:00.000Z",
                status: "answered",
                answer: {
                    body: "",
                    createdAt: "2026-07-14T00:12:00.000Z",
                },
            }],
            auto_submitted: false,
            tab_foci_lost_count: 1,
            handwriting_archived: false,
        });

        expect(attempt).toMatchObject({
            id: "attempt-1",
            examTitle: "목록 시험",
            guestId: "guest-1",
            answers: { 1: 2 },
            questionResults: [{ questionId: 1 }],
            questionTimings: [{ questionId: 1 }],
            tabFociLostCount: 1,
            studentQuestions: [{
                questionId: 1,
                body: "",
                status: "answered",
                answer: { body: "", createdAt: "2026-07-14T00:12:00.000Z" },
            }],
        });
        expect(attempt).not.toHaveProperty("drawings");
        expect(attempt.subQuestionAnswers).toBeUndefined();
        expect(collectStudentQuestionInbox([attempt])).toMatchObject({
            pending: [],
            answered: [{ attemptId: "attempt-1", note: { questionNumber: 1, status: "answered" } }],
        });
        expect(answeredQuestionKeys([attempt])).toEqual([
            "attempt-1:1:2026-07-14T00:12:00.000Z",
        ]);
    });

    it("serializes the JSON-path aliases through the real Supabase/PostgREST client", async () => {
        const requests: URL[] = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            requests.push(new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url));
            return new Response("[]", {
                status: 200,
                headers: { "content-type": "application/json", "content-range": "*/0" },
            });
        });
        const client = createClient("https://example.supabase.co", "anon-key", {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { fetch: fetchMock },
        });

        await client.from("omr_exams").select(SUPABASE_EXAM_LIST_READ_COLUMNS).eq("organization_id", "org-1").limit(1);
        await client.from("omr_attempts").select(SUPABASE_ATTEMPT_LIST_READ_COLUMNS).eq("organization_id", "org-1").limit(1);
        await client.from("omr_exams").select(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS).eq("organization_id", "org-1").limit(1);

        expect(requests).toHaveLength(3);
        expect(requests[0].searchParams.get("select")).toBe(SUPABASE_EXAM_LIST_READ_COLUMNS.replaceAll(" ", ""));
        expect(requests[1].searchParams.get("select")).toBe(SUPABASE_ATTEMPT_LIST_READ_COLUMNS.replaceAll(" ", ""));
        expect(requests[0].searchParams.get("select")).not.toContain("answerKeyPdf");
        expect(requests[0].searchParams.get("select")).toContain("questions:question_summaries");
        expect(requests[0].searchParams.get("select")).not.toContain("payload->questions");
        expect(requests[1].searchParams.get("select")).not.toMatch(/payload->drawings(?:,|$)/);
        expect(requests[1].searchParams.get("select")).not.toContain("payload->studentQuestions");
        expect(requests[1].searchParams.get("select")).toContain("student_questions:student_question_summaries");
        expect(requests[2].searchParams.get("select")).toBe(SUPABASE_STUDENT_EXAM_LIST_READ_COLUMNS.replaceAll(" ", ""));
        expect(requests[2].searchParams.get("select")).not.toMatch(/questions|pdf|answerKey|pin/i);
    });

    it("never reconstructs student or teacher free-text from a list summary", () => {
        const studentSecret = "STUDENT_SECRET_6f8125";
        const teacherSecret = "TEACHER_SECRET_9d47b1";
        const attempt = attemptFromSupabaseListRow({
            id: "attempt-secret",
            exam_id: "exam-1",
            exam_title: "목록 시험",
            student_name: "학생 1",
            started_at: "2026-07-14T00:00:00.000Z",
            finished_at: "2026-07-14T00:10:00.000Z",
            status: "completed",
            score: 1,
            total_score: 1,
            student_questions: [{
                questionId: 7,
                questionNumber: 7,
                body: "",
                createdAt: "2026-07-14T00:11:00.000Z",
                status: "answered",
                answer: { body: "", createdAt: "2026-07-14T00:12:00.000Z" },
            }],
            payload: { studentQuestions: [{ body: studentSecret, answer: { body: teacherSecret } }] },
        });

        const serialized = JSON.stringify(attempt);
        expect(serialized).not.toContain(studentSecret);
        expect(serialized).not.toContain(teacherSecret);
        expect(serialized).not.toContain("teacherName");
        expect(attempt.studentQuestions).toEqual([expect.objectContaining({
            questionId: 7,
            body: "",
            status: "answered",
            answer: expect.objectContaining({ body: "", createdAt: "2026-07-14T00:12:00.000Z" }),
        })]);
    });
});
