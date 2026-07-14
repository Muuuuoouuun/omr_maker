import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import {
    attemptFromSupabaseRow,
    attemptToSupabaseRow,
    attemptsWithQuestionResults,
    clearLocalExamDeleted,
    deleteExam,
    examFromSupabaseRow,
    examQuestionRowsForExam,
    examQuestionToSupabaseRow,
    examToSupabaseRow,
    getSupabaseConfigFromEnv,
    itemsNeedingRemoteSync,
    markLocalExamDeleted,
    mergeAttemptsForPersistence,
    questionResultRowsForAttempt,
    questionResultToSupabaseRow,
    readLocalAttempts,
    readLocalDeletedExamIds,
    readLocalExam,
    readLocalExams,
    clearAttemptPendingSync,
    flushPendingAttemptSync,
    queueAttemptPendingSync,
    readPendingAttemptSyncIds,
    selectMergedGuestAttempts,
    sanitizeAttemptPayload,
    sanitizeExamPayload,
    saveLocalExam,
    saveLocalAttempt,
    sortByNewestActivity,
    storedDataRefsForExamDeletion,
    stripHeavyAttemptPayload,
} from "./omrPersistence";
import { createTeacherSession } from "./teacherSession";
import { stableWorkspaceHash, workspaceContextFromIdentity } from "./workspaceContext";

function createStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));

    return {
        get length() {
            return data.size;
        },
        clear() {
            data.clear();
        },
        getItem(key: string) {
            return data.get(key) ?? null;
        },
        key(index: number) {
            return [...data.keys()][index] ?? null;
        },
        removeItem(key: string) {
            data.delete(key);
        },
        setItem(key: string, value: string) {
            data.set(key, value);
        },
    } as Storage;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Supabase persistence mapping", () => {
    const exam: Exam = {
        id: "exam-1",
        title: "Final OMR",
        createdAt: "2026-06-13T10:00:00.000Z",
        updatedAt: "2026-06-14T10:00:00.000Z",
        archived: false,
        durationMin: 45,
        questions: [{ id: 1, number: 1, answer: 3, choices: 5 }],
    };

    const attempt: Attempt = {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "Final OMR",
        studentName: "Kim",
        studentId: "class-a::Kim",
        groupId: "class-a",
        groupName: "Class A",
        regionId: "region-seoul",
        regionName: "서울",
        identityType: "temporary",
        startedAt: "2026-06-14T09:00:00.000Z",
        finishedAt: "2026-06-14T09:30:00.000Z",
        score: 95,
        totalScore: 100,
        answers: { 1: 3 },
        status: "completed",
    };

    it("stores exams as indexed rows with the full exam payload", () => {
        const row = examToSupabaseRow(exam);

        expect(row).toMatchObject({
            id: "exam-1",
            title: "Final OMR",
            created_at: "2026-06-13T10:00:00.000Z",
            updated_at: "2026-06-14T10:00:00.000Z",
            archived: false,
        });
        expect(row.payload).toEqual(exam);
        expect(examFromSupabaseRow(row)).toEqual(exam);
    });

    it("scopes exam rows to the active workspace context", () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            displayName: "Teacher A",
        });
        const row = examToSupabaseRow(exam, context);

        expect(row).toMatchObject({
            organization_id: `teacher_${stableWorkspaceHash("teacher-a")}`,
            created_by_user_id: `teacher_${stableWorkspaceHash("teacher-a")}`,
        });
        expect(examFromSupabaseRow(row)).toMatchObject({
            id: "exam-1",
            organizationId: row.organization_id,
            createdByUserId: row.created_by_user_id,
        });
        expect(examQuestionRowsForExam(exam, "2026-06-14T09:31:00.000Z", context)[0]).toMatchObject({
            organization_id: row.organization_id,
        });
    });

    it("maps exam questions to normalized DB rows without cropped images", () => {
        const questionExam: Exam = {
            ...exam,
            questions: [
                {
                    id: 7,
                    number: 7,
                    answer: 5,
                    score: 4,
                    label: "문학",
                    tags: {
                        subject: "국어",
                        unit: "현대시",
                        concept: "화자의 정서",
                        skill: "감상",
                        source: "님의 침묵",
                        difficulty: "medium",
                        cognitiveLevel: "application",
                        expectedTimeSec: 90,
                        mistakeTypes: ["개념 혼동"],
                        prerequisites: ["시적 화자"],
                    },
                    pdfLocation: { page: 1, x: 0.25, y: 0.4 },
                    pdfRegion: { page: 1, x: 0.2, y: 0.35, width: 0.5, height: 0.18 },
                },
            ],
        };

        const row = examQuestionToSupabaseRow(questionExam, questionExam.questions[0], "2026-06-14T09:31:00.000Z");

        expect(row).toMatchObject({
            id: "exam-1:7",
            exam_id: "exam-1",
            question_id: 7,
            question_number: 7,
            canonical_question_id: "exam-1:7",
            label: "문학",
            subject: "국어",
            unit: "현대시",
            concept: "화자의 정서",
            skill: "감상",
            source: "님의 침묵",
            difficulty: "medium",
            cognitive_level: "application",
            mistake_types: ["개념 혼동"],
            prerequisites: ["시적 화자"],
            expected_time_sec: 90,
            choices: 5,
            correct_answer: 5,
            score: 4,
            pdf_page: 1,
            has_pdf_region: true,
            asset_status: "pdf_region_ready",
            image_asset_ref: null,
            updated_at: "2026-06-14T09:31:00.000Z",
        });
        expect(row.pdf_region).toEqual({ page: 1, x: 0.2, y: 0.35, width: 0.5, height: 0.18 });
        expect(row.payload).not.toHaveProperty("image");
        expect(examQuestionRowsForExam(questionExam, "2026-06-14T09:31:00.000Z")).toHaveLength(1);
    });

    it("marks question image assets separately from metadata-only and pdf-region rows", () => {
        const metadataOnly = examQuestionToSupabaseRow(exam, exam.questions[0]);
        const imageReady = examQuestionToSupabaseRow({
            ...exam,
            questions: [{
                ...exam.questions[0],
                imageAssetRef: { store: "indexeddb", key: "question-image" },
            }],
        }, {
            ...exam.questions[0],
            imageAssetRef: { store: "indexeddb", key: "question-image" },
        });

        expect(metadataOnly).toMatchObject({
            asset_status: "metadata_only",
            image_asset_ref: null,
        });
        expect(imageReady).toMatchObject({
            asset_status: "image_asset_ready",
            image_asset_ref: { store: "indexeddb", key: "question-image" },
        });
    });


    it("stores attempts as indexed rows with the full attempt payload", () => {
        const row = attemptToSupabaseRow(attempt);

        expect(row).toMatchObject({
            id: "attempt-1",
            class_id: "class-a",
            student_profile_id: "class-a::Kim",
            exam_id: "exam-1",
            student_name: "Kim",
            student_id: "class-a::Kim",
            group_id: "class-a",
            group_name: "Class A",
            region_id: "region-seoul",
            region_name: "서울",
            identity_type: "temporary",
            status: "completed",
            score: 95,
            total_score: 100,
            score_percent: 95,
            retake_source_attempt_id: null,
            retake_mode: null,
            retake_question_ids: [],
            merged_from_guest_id: null,
            merged_at: null,
            finished_at: "2026-06-14T09:30:00.000Z",
        });
        expect(row.payload).toEqual(attempt);
        // attemptFromSupabaseRow always resolves studentProfileId from the indexed column;
        // even if the original attempt lacked it, it's backfilled from student_profile_id.
        expect(attemptFromSupabaseRow(row)).toEqual({ ...attempt, studentProfileId: row.student_profile_id });
    });

    it("scopes attempt and question-result rows to the exam or active workspace", () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            displayName: "Teacher A",
        });
        const scopedAttempt: Attempt = {
            ...attempt,
            organizationId: context.organizationId,
            classId: "class-a",
            studentProfileId: "student-profile-1",
        };

        const attemptRow = attemptToSupabaseRow(scopedAttempt, context);
        expect(attemptRow).toMatchObject({
            organization_id: context.organizationId,
            class_id: "class-a",
            student_profile_id: "student-profile-1",
        });
        expect(attemptFromSupabaseRow(attemptRow)).toMatchObject({
            organizationId: context.organizationId,
            classId: "class-a",
            studentProfileId: "student-profile-1",
        });

        const resultRow = questionResultToSupabaseRow({
            schemaVersion: 1,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "Final OMR",
            studentName: "Kim",
            questionId: 1,
            questionNumber: 1,
            score: 4,
            earnedScore: 4,
            selectedAnswer: 3,
            correctAnswer: 3,
            status: "correct",
            isCorrect: true,
            isWrong: false,
            isUnanswered: false,
            finishedAt: "2026-06-14T09:30:00.000Z",
        }, scopedAttempt, "2026-06-14T09:31:00.000Z", context);

        expect(resultRow).toMatchObject({
            organization_id: context.organizationId,
            class_id: "class-a",
            student_profile_id: "student-profile-1",
        });
        expect(resultRow.payload).toMatchObject({
            organizationId: context.organizationId,
            classId: "class-a",
            studentProfileId: "student-profile-1",
        });
    });

    it("stamps local exam saves with the active teacher workspace", async () => {
        const localStorage = createStorage();
        const teacherSession = createTeacherSession("tkn_test_0123456789abcdef0123456789abcdef", Date.now(), {
            teacherId: "teacher-a",
            displayName: "Teacher A",
        });
        const sessionStorage = createStorage({
            omr_teacher_session: JSON.stringify(teacherSession),
        });
        vi.stubGlobal("window", { localStorage, sessionStorage });
        vi.stubGlobal("localStorage", localStorage);

        const { saveExam } = await import("./omrPersistence");
        const result = await saveExam(exam);

        expect(result).toEqual({ localSaved: true, remoteSaved: false });
        expect(readLocalExam("exam-1")).toMatchObject({
            organizationId: `teacher_${stableWorkspaceHash("teacher-a")}`,
            createdByUserId: `teacher_${stableWorkspaceHash("teacher-a")}`,
        });
    });

    it("promotes retake and guest merge metadata into attempt fact columns", () => {
        const retakeAttempt: Attempt = {
            ...attempt,
            id: "attempt-retake",
            identityType: "registered",
            score: 6,
            totalScore: 8,
            retake: {
                sourceAttemptId: "attempt-1",
                questionIds: [2, 4],
                mode: "similar",
                labels: ["문학"],
                concepts: ["화자의 정서"],
                createdAt: "2026-06-14T09:35:00.000Z",
            },
            mergedFromGuestId: "guest-1",
            mergedAt: "2026-06-14T09:40:00.000Z",
        };

        const row = attemptToSupabaseRow(retakeAttempt);

        expect(row).toMatchObject({
            id: "attempt-retake",
            identity_type: "registered",
            score: 6,
            total_score: 8,
            score_percent: 75,
            retake_source_attempt_id: "attempt-1",
            retake_mode: "similar",
            retake_question_ids: [2, 4],
            merged_from_guest_id: "guest-1",
            merged_at: "2026-06-14T09:40:00.000Z",
        });
        expect(row.payload.retake?.questionIds).toEqual([2, 4]);
    });

    it("maps per-question results to normalized Supabase fact rows", () => {
        const questionResult = {
            schemaVersion: 1 as const,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "Final OMR",
            studentName: "Kim",
            studentId: "class-a::Kim",
            groupId: "class-a",
            groupName: "Class A",
            regionId: "region-seoul",
            regionName: "서울",
            identityType: "temporary" as const,
            questionId: 1,
            questionNumber: 1,
            canonicalQuestionId: "exam-1:1",
            label: "문법",
            score: 4,
            earnedScore: 0,
            selectedAnswer: 2,
            correctAnswer: 3,
            status: "wrong" as const,
            isCorrect: false,
            isWrong: true,
            isUnanswered: false,
            subject: "국어",
            unit: "문법",
            concept: "높임 표현",
            skill: "어법 판단",
            source: "높임 표현",
            difficulty: "medium" as const,
            cognitiveLevel: "application" as const,
            mistakeTypes: ["개념 혼동"],
            prerequisites: ["높임법"],
            expectedTimeSec: 90,
            pdfPage: 1,
            pdfLocation: { page: 1, x: 0.2, y: 0.3 },
            pdfRegion: { page: 1, x: 0.15, y: 0.25, width: 0.3, height: 0.2 },
            timeSec: 77,
            visitCount: 2,
            revisitCount: 1,
            answerChangeCount: 1,
            handwritingStrokeCount: 3,
            handwritingPage: 1,
            retakeSourceAttemptId: "attempt-original",
            retakeMode: "wrong" as const,
            answeredAt: "2026-06-14T09:10:00.000Z",
            finishedAt: "2026-06-14T09:30:00.000Z",
        };
        const row = questionResultToSupabaseRow(questionResult, attempt, "2026-06-14T09:31:00.000Z");

        expect(row).toMatchObject({
            id: "attempt-1:1",
            attempt_id: "attempt-1",
            exam_id: "exam-1",
            student_name: "Kim",
            student_id: "class-a::Kim",
            group_id: "class-a",
            group_name: "Class A",
            region_id: "region-seoul",
            region_name: "서울",
            class_id: "class-a",
            student_profile_id: "class-a::Kim",
            identity_type: "temporary",
            question_id: 1,
            question_number: 1,
            canonical_question_id: "exam-1:1",
            label: "문법",
            subject: "국어",
            unit: "문법",
            concept: "높임 표현",
            skill: "어법 판단",
            source: "높임 표현",
            difficulty: "medium",
            cognitive_level: "application",
            mistake_types: ["개념 혼동"],
            prerequisites: ["높임법"],
            expected_time_sec: 90,
            selected_answer: 2,
            correct_answer: 3,
            status: "wrong",
            is_correct: false,
            is_wrong: true,
            is_unanswered: false,
            score: 4,
            earned_score: 0,
            pdf_page: 1,
            time_sec: 77,
            visit_count: 2,
            revisit_count: 1,
            answer_change_count: 1,
            handwriting_stroke_count: 3,
            handwriting_page: 1,
            retake_source_attempt_id: "attempt-original",
            retake_mode: "wrong",
            answered_at: "2026-06-14T09:10:00.000Z",
            finished_at: "2026-06-14T09:30:00.000Z",
            updated_at: "2026-06-14T09:31:00.000Z",
        });
        expect(row.pdf_region).toEqual({ page: 1, x: 0.15, y: 0.25, width: 0.3, height: 0.2 });
        expect(row.payload).toMatchObject({
            questionId: 1,
            status: "wrong",
            concept: "높임 표현",
            identityType: "temporary",
            regionName: "서울",
            retakeSourceAttemptId: "attempt-original",
            retakeMode: "wrong",
        });
        expect(questionResultRowsForAttempt({ ...attempt, questionResults: [questionResult] }, "2026-06-14T09:31:00.000Z")).toHaveLength(1);
    });

    it("backfills canonical question ids so result rows can join exam question rows", () => {
        const questionRows = examQuestionRowsForExam(exam, "2026-06-14T09:31:00.000Z");
        const resultRow = questionResultToSupabaseRow({
            schemaVersion: 1,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "Final OMR",
            studentName: "Kim",
            questionId: 1,
            questionNumber: 1,
            score: 4,
            earnedScore: 4,
            selectedAnswer: 3,
            correctAnswer: 3,
            status: "correct",
            isCorrect: true,
            isWrong: false,
            isUnanswered: false,
            finishedAt: "2026-06-14T09:30:00.000Z",
        }, attempt, "2026-06-14T09:31:00.000Z");

        expect(resultRow.canonical_question_id).toBe(questionRows[0].canonical_question_id);
        expect(resultRow.payload.canonicalQuestionId).toBe(questionRows[0].canonical_question_id);
    });

    it("selects existing attempts with valid question results for fact-table backfill", () => {
        const questionResult = {
            schemaVersion: 1 as const,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "Final OMR",
            studentName: "Kim",
            questionId: 1,
            questionNumber: 1,
            score: 4,
            earnedScore: 4,
            correctAnswer: 3,
            selectedAnswer: 3,
            status: "correct" as const,
            isCorrect: true,
            isWrong: false,
            isUnanswered: false,
            finishedAt: "2026-06-14T09:30:00.000Z",
        };
        const withRows: Attempt = { ...attempt, questionResults: [questionResult] };
        const withoutRows: Attempt = { ...attempt, id: "attempt-empty", questionResults: [] };
        const invalidRows: Attempt = {
            ...attempt,
            id: "attempt-invalid",
            questionResults: [{
                ...questionResult,
                attemptId: "",
                examId: "",
                questionId: Number.NaN,
            }],
        };

        expect(attemptsWithQuestionResults([withRows, withoutRows, invalidRows]).map(item => item.id)).toEqual(["attempt-1"]);
    });

    it("normalizes persisted exam payloads before dashboards consume them", () => {
        expect(sanitizeExamPayload(null)).toBeNull();
        expect(sanitizeExamPayload({ title: "No id", questions: [] })).toBeNull();

        expect(sanitizeExamPayload({
            id: "exam-legacy",
            title: "",
            questions: [
                { id: 1, answer: 5 },
                { id: "bad", number: 2 },
            ],
        })).toMatchObject({
            id: "exam-legacy",
            title: "제목 없는 시험",
            createdAt: "1970-01-01T00:00:00.000Z",
            questions: [
                { id: 1, number: 1, answer: 5 },
            ],
        });
    });

    it("normalizes persisted attempt payloads before analytics consume them", () => {
        expect(sanitizeAttemptPayload({ id: "attempt-without-exam" })).toBeNull();

        const normalized = sanitizeAttemptPayload({
            id: "attempt-legacy",
            examId: "exam-1",
            studentName: "",
            startedAt: "2026-06-14T09:00:00.000Z",
            score: Number.NaN,
            totalScore: "bad",
            answers: { 1: 3, 2: 2, 3: "bad" },
            questionResults: { bad: true },
            questionTimings: { bad: true },
            status: "unknown",
        });

        expect(normalized).toMatchObject({
            id: "attempt-legacy",
            examId: "exam-1",
            examTitle: "제목 없는 시험",
            studentName: "Student",
            startedAt: "2026-06-14T09:00:00.000Z",
            finishedAt: "2026-06-14T09:00:00.000Z",
            score: 0,
            totalScore: 0,
            answers: { 1: 3, 2: 2 },
            status: "completed",
        });
        expect(normalized?.questionResults).toBeUndefined();
        expect(normalized?.questionTimings).toBeUndefined();
    });

    it("keeps handwriting stroke payloads out of Supabase attempt rows", () => {
        const drawingsRef = {
            store: "indexeddb" as const,
            key: "attempt:attempt-1:drawings",
            updatedAt: "2026-06-14T09:31:00.000Z",
        };
        const withDrawings: Attempt = {
            ...attempt,
            drawings: {
                1: [JSON.stringify({ points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }] })],
            },
            drawingsRef,
            handwritingArchived: true,
            drawingPageCount: 1,
            drawingStrokeCount: 1,
            handwriting: {
                schemaVersion: 1,
                status: "saved",
                strokesRef: drawingsRef,
                plan: "pro",
                summary: {
                    pageCount: 1,
                    strokeCount: 1,
                    questionCount: 1,
                },
                questions: {
                    1: { questionId: 1, questionNumber: 1, page: 1, strokeCount: 1 },
                },
            },
        };

        const stripped = stripHeavyAttemptPayload(withDrawings);
        const row = attemptToSupabaseRow(withDrawings);

        expect(stripped.drawings).toBeUndefined();
        expect(row.payload.drawings).toBeUndefined();
        expect(row.payload.drawingsRef).toEqual(drawingsRef);
        expect(row.payload.handwriting?.strokesRef).toEqual(drawingsRef);
        expect(JSON.stringify(row.payload)).not.toContain("points");
    });

    it("keeps handwriting payloads out of localStorage attempt indexes", () => {
        const localStorage = createStorage();
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);

        const saved = saveLocalAttempt({
            ...attempt,
            drawings: {
                1: [JSON.stringify({ points: [{ x: 0.1, y: 0.2 }] })],
            },
        });

        expect(saved).toBe(true);
        expect(readLocalAttempts()[0]?.drawings).toBeUndefined();
        expect(localStorage.getItem("omr_attempts") || "").not.toContain("points");
    });

    it("skips corrupt local exam and attempt rows instead of crashing read screens", () => {
        const localStorage = createStorage({
            "omr_exam_valid": JSON.stringify(exam),
            "omr_exam_corrupt": JSON.stringify({ title: "Missing id", questions: [] }),
            "omr_attempts": JSON.stringify([
                attempt,
                { id: "bad-attempt", studentName: "No exam id" },
                "not an attempt",
            ]),
        });
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);

        expect(readLocalExams()).toEqual([exam]);
        expect(readLocalAttempts()).toEqual([attempt]);
    });

    it("treats a non-array local attempt index as empty", () => {
        const localStorage = createStorage({
            "omr_attempts": JSON.stringify({ id: "not-an-array" }),
        });
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);

        expect(readLocalAttempts()).toEqual([]);
    });

    it("sorts the newest changed items first", () => {
        const older = { ...exam, id: "old", updatedAt: "2026-06-10T00:00:00.000Z" };
        const newer = { ...exam, id: "new", updatedAt: "2026-06-12T00:00:00.000Z" };
        const createdOnly = { ...exam, id: "created-only", updatedAt: undefined, createdAt: "2026-06-11T00:00:00.000Z" };

        expect(sortByNewestActivity([older, newer, createdOnly]).map(item => item.id)).toEqual([
            "new",
            "created-only",
            "old",
        ]);
    });

    it("tracks locally deleted exams so stale remote rows do not reappear locally", () => {
        const localStorage = createStorage({
            "omr_exam_exam-1": JSON.stringify(exam),
        });
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);

        expect(markLocalExamDeleted("exam-1", "2026-06-15T00:00:00.000Z")).toBe(true);

        expect(readLocalDeletedExamIds()).toEqual({ "exam-1": "2026-06-15T00:00:00.000Z" });
        expect(readLocalExam("exam-1")).toBeNull();
        expect(readLocalExams()).toEqual([]);

        expect(clearLocalExamDeleted("exam-1")).toBe(true);
        expect(readLocalExam("exam-1")).toEqual(exam);
    });

    it("clears local deletion markers when a teacher intentionally saves that exam again", () => {
        const localStorage = createStorage();
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);

        markLocalExamDeleted("exam-1", "2026-06-15T00:00:00.000Z");
        expect(saveLocalExam(exam)).toBe(true);

        expect(readLocalDeletedExamIds()).toEqual({});
        expect(readLocalExam("exam-1")).toEqual(exam);
    });

    it("identifies local items that need remote resync", () => {
        const localNewer = { ...exam, id: "newer", updatedAt: "2026-06-15T00:00:00.000Z" };
        const remoteOlder = { ...localNewer, updatedAt: "2026-06-14T00:00:00.000Z" };
        const localSame = { ...exam, id: "same", updatedAt: "2026-06-14T00:00:00.000Z" };
        const remoteSame = { ...localSame };
        const localOnly = { ...exam, id: "local-only", updatedAt: "2026-06-13T00:00:00.000Z" };

        expect(itemsNeedingRemoteSync(
            [localNewer, localSame, localOnly],
            [remoteOlder, remoteSame],
        ).map(item => item.id)).toEqual(["newer", "local-only"]);
    });

    it("preserves richer local attempt analytics when merging stale remote payloads", () => {
        const localQuestionResult = {
            schemaVersion: 1 as const,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "Final OMR",
            studentName: "Kim",
            questionId: 1,
            questionNumber: 1,
            score: 4,
            earnedScore: 4,
            selectedAnswer: 3,
            correctAnswer: 3,
            status: "correct" as const,
            isCorrect: true,
            isWrong: false,
            isUnanswered: false,
            finishedAt: attempt.finishedAt,
        };
        const localAttempt: Attempt = {
            ...attempt,
            questionResults: [localQuestionResult],
            questionTimings: [{ questionId: 1, questionNumber: 1, totalTimeSec: 35, visitCount: 1, revisitCount: 0, answerChangeCount: 0 }],
            questionDrawings: [{ questionId: 1, questionNumber: 1, page: 1, strokeCount: 2 }],
        };
        const remoteAttempt: Attempt = {
            ...attempt,
            questionResults: undefined,
            questionTimings: undefined,
            questionDrawings: undefined,
        };

        const [merged] = mergeAttemptsForPersistence([localAttempt], [remoteAttempt]);

        expect(merged.questionResults).toEqual([localQuestionResult]);
        expect(merged.questionTimings).toEqual(localAttempt.questionTimings);
        expect(merged.questionDrawings).toEqual(localAttempt.questionDrawings);
    });
});

describe("Supabase config", () => {
    it("returns null until both browser-safe env vars are present", () => {
        expect(getSupabaseConfigFromEnv({})).toBeNull();
        expect(getSupabaseConfigFromEnv({
            NEXT_PUBLIC_SUPABASE_URL: "https://wqhiajvisirxdjivhmlt.supabase.co",
        })).toBeNull();
    });

    it("accepts publishable keys and trims accidental whitespace", () => {
        expect(getSupabaseConfigFromEnv({
            NEXT_PUBLIC_SUPABASE_URL: " https://wqhiajvisirxdjivhmlt.supabase.co ",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: " sb_publishable_abc ",
        })).toEqual({
            url: "https://wqhiajvisirxdjivhmlt.supabase.co",
            publishableKey: "sb_publishable_abc",
        });
    });
});

describe("Exam deletion", () => {
    it("collects PDF, handwriting, and draft IndexedDB refs for exam deletion", () => {
        const refs = storedDataRefsForExamDeletion(
            {
                id: "exam-1",
                title: "Delete me",
                createdAt: "2026-06-13T10:00:00.000Z",
                questions: [
                    {
                        id: 1,
                        number: 1,
                        imageAssetRef: { store: "indexeddb", key: "question-image" },
                    },
                ],
                pdfDataRef: { store: "indexeddb", key: "problem" },
                answerKeyPdfRef: { store: "indexeddb", key: "answer" },
            },
            [
                {
                    id: "attempt-1",
                    examId: "exam-1",
                    examTitle: "Delete me",
                    studentName: "Kim",
                    startedAt: "2026-06-14T09:00:00.000Z",
                    finishedAt: "2026-06-14T09:30:00.000Z",
                    score: 10,
                    totalScore: 10,
                    answers: {},
                    status: "completed",
                    drawingsRef: { store: "indexeddb", key: "drawings" },
                    handwriting: {
                        schemaVersion: 1,
                        status: "saved",
                        strokesRef: { store: "indexeddb", key: "drawings" },
                        plan: "pro",
                        summary: { pageCount: 1, strokeCount: 2, questionCount: 1 },
                        questions: {
                            1: { questionId: 1, questionNumber: 1, page: 1, strokeCount: 2 },
                        },
                    },
                },
            ],
            [
                { drawingsRef: { store: "indexeddb", key: "draft" } },
                { drawingsRef: { store: "bad", key: "bad" } },
            ],
        );

        expect(refs.map(ref => ref.key)).toEqual(["problem", "answer", "question-image", "drawings", "draft"]);
    });

    it("removes the local exam and its attempts when remote sync is not configured", async () => {
        const exam: Exam = {
            id: "exam-1",
            title: "Delete me",
            createdAt: "2026-06-13T10:00:00.000Z",
            questions: [],
            pdfDataRef: { store: "indexeddb", key: "problem" },
            answerKeyPdfRef: { store: "indexeddb", key: "answer" },
        };
        const deletedAttempt: Attempt = {
            id: "attempt-1",
            examId: "exam-1",
            examTitle: "Delete me",
            studentName: "Kim",
            startedAt: "2026-06-14T09:00:00.000Z",
            finishedAt: "2026-06-14T09:30:00.000Z",
            score: 10,
            totalScore: 10,
            answers: {},
            status: "completed",
            drawingsRef: { store: "indexeddb", key: "drawings" },
            handwriting: {
                schemaVersion: 1,
                status: "saved",
                strokesRef: { store: "indexeddb", key: "strokes" },
                plan: "pro",
                summary: { pageCount: 1, strokeCount: 3, questionCount: 1 },
                questions: {
                    1: { questionId: 1, questionNumber: 1, page: 1, strokeCount: 3 },
                },
            },
        };
        const otherAttempt: Attempt = {
            id: "attempt-2",
            examId: "exam-2",
            examTitle: "Keep me",
            studentName: "Lee",
            startedAt: "2026-06-14T09:00:00.000Z",
            finishedAt: "2026-06-14T09:30:00.000Z",
            score: 8,
            totalScore: 10,
            answers: {},
            status: "completed",
        };
        const storage = createStorage({
            "omr_exam_exam-1": JSON.stringify(exam),
            "omr_attempts": JSON.stringify([deletedAttempt, otherAttempt]),
            "omr_draft_exam-1": JSON.stringify({ drawingsRef: { store: "indexeddb", key: "draft-legacy" } }),
            "omr_draft_exam-1_pid": JSON.stringify({ drawingsRef: { store: "indexeddb", key: "draft-scoped" } }),
            "omr_draft_exam-2_pid": JSON.stringify({ drawingsRef: { store: "indexeddb", key: "keep-draft" } }),
        });

        vi.stubGlobal("window", { localStorage: storage });
        vi.stubGlobal("localStorage", storage);

        const result = await deleteExam("exam-1");

        expect(result).toEqual({ localSaved: true, remoteSaved: false });
        expect(storage.getItem("omr_exam_exam-1")).toBeNull();
        expect(JSON.parse(storage.getItem("omr_attempts") || "[]")).toEqual([otherAttempt]);
        expect(storage.getItem("omr_draft_exam-1")).toBeNull();
        expect(storage.getItem("omr_draft_exam-1_pid")).toBeNull();
        expect(storage.getItem("omr_draft_exam-2_pid")).not.toBeNull();
    });
});

describe("Pending attempt sync registry", () => {
    it("queues, dedupes, and clears pending attempt ids", () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });

        queueAttemptPendingSync("a1");
        queueAttemptPendingSync("a2");
        queueAttemptPendingSync("a1");
        expect(readPendingAttemptSyncIds()).toEqual(["a1", "a2"]);

        clearAttemptPendingSync("a1");
        expect(readPendingAttemptSyncIds()).toEqual(["a2"]);

        clearAttemptPendingSync("a2");
        expect(readPendingAttemptSyncIds()).toEqual([]);
        expect(storage.getItem("omr_pending_attempt_sync")).toBeNull();
    });

    it("ignores malformed registry payloads", () => {
        const storage = createStorage({ omr_pending_attempt_sync: "{not json" });
        vi.stubGlobal("window", { localStorage: storage });
        expect(readPendingAttemptSyncIds()).toEqual([]);
    });

    it("keeps ids pending while Supabase is unconfigured", async () => {
        const storage = createStorage({ omr_pending_attempt_sync: JSON.stringify(["a1"]) });
        vi.stubGlobal("window", { localStorage: storage });

        const remaining = await flushPendingAttemptSync();

        expect(remaining).toBe(1);
        expect(readPendingAttemptSyncIds()).toEqual(["a1"]);
    });
});

describe("selectMergedGuestAttempts", () => {
    const mergedFor = (id: string, studentId: string, mergedFromGuestId?: string): Attempt => ({
        id,
        examId: "exam-1",
        examTitle: "Final",
        studentName: "Kim",
        studentId,
        mergedFromGuestId,
        startedAt: "2026-06-14T09:00:00.000Z",
        finishedAt: "2026-06-14T09:30:00.000Z",
        score: 10,
        totalScore: 20,
        answers: {},
        status: "completed",
    });

    it("selects attempts reassigned from a guest to the student", () => {
        const attempts = [
            mergedFor("a1", "class-a::Kim", "guest-1"),
            mergedFor("a2", "class-a::Kim", "guest-1"),
            mergedFor("a3", "guest:guest-1"), // still a guest attempt — skip
            mergedFor("a4", "class-a::Kim"), // no merge marker — skip
            mergedFor("a5", "class-b::Lee", "guest-1"), // different student — skip
        ];

        const selected = selectMergedGuestAttempts(attempts, "class-a::Kim");
        expect(selected.map(a => a.id)).toEqual(["a1", "a2"]);
    });

    it("narrows by guestId and skips ids already present remotely", () => {
        const attempts = [
            mergedFor("a1", "class-a::Kim", "guest-1"),
            mergedFor("a2", "class-a::Kim", "guest-2"),
            mergedFor("a3", "class-a::Kim", "guest-1"),
        ];

        expect(selectMergedGuestAttempts(attempts, "class-a::Kim", { guestId: "guest-1" }).map(a => a.id))
            .toEqual(["a1", "a3"]);
        expect(selectMergedGuestAttempts(attempts, "class-a::Kim", { skipAttemptIds: ["a1"] }).map(a => a.id))
            .toEqual(["a2", "a3"]);
    });

    it("never targets a guest owner", () => {
        const attempts = [mergedFor("a1", "guest:guest-1", "guest-1")];
        expect(selectMergedGuestAttempts(attempts, "guest:guest-1")).toEqual([]);
        expect(selectMergedGuestAttempts(attempts, "")).toEqual([]);
    });
});
