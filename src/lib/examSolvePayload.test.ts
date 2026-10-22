import { describe, expect, it } from "vitest";
import { stripExamForAttemptReview, stripExamForReview, stripExamForSolving, stripTeacherOnlySubQuestionFields } from "./examSolvePayload";
import { examFromSupabaseRow, examToSupabaseRow } from "./omrPersistence";
import type { Attempt, Exam } from "@/types/omr";

const EXAM: Exam = {
    id: "e1", title: "기말고사", createdAt: "2026-07-01T00:00:00.000Z",
    answerKeyPdf: "data:application/pdf;base64,AAAA",
    answerKeyPdfRef: { store: "indexeddb", key: "ans-e1" },
    accessConfig: { type: "public", pin: "1234" },
    questions: [
        { id: 1, number: 1, answer: 3, choices: 5, score: 10 },
        { id: 2, number: 2, answer: 1, choices: 4 },
    ],
};

describe("stripExamForSolving", () => {
    it("removes every question answer but keeps display fields", () => {
        const solvable = stripExamForSolving(EXAM);
        expect(solvable.questions).toHaveLength(2);
        for (const q of solvable.questions) {
            expect("answer" in q).toBe(false);
        }
        expect(solvable.questions[0]).toMatchObject({ id: 1, number: 1, choices: 5, score: 10 });
    });

    it("removes the answer key PDF and inline pin, exposing only hasPin", () => {
        const solvable = stripExamForSolving({ ...EXAM, organizationId: "private-org" });
        expect(solvable.answerKeyPdf).toBeUndefined();
        expect(solvable.answerKeyPdfRef).toBeUndefined();
        expect(solvable.accessConfig).toEqual({ type: "public", hasPin: true });
        expect(JSON.stringify(solvable)).not.toContain("1234");
        expect(solvable).not.toHaveProperty("organizationId");
        expect(JSON.stringify(solvable)).not.toContain("private-org");
    });

    it("reports hasPin false when no pin is set", () => {
        const solvable = stripExamForSolving({ ...EXAM, accessConfig: { type: "group", groupIds: ["g1"] } });
        expect(solvable.accessConfig).toEqual({ type: "group", hasPin: false });
        expect(JSON.stringify(solvable)).not.toContain("g1");
    });

    it("strips the teacher explanation (it can reveal the answer)", () => {
        const solvable = stripExamForSolving({
            ...EXAM,
            questions: [{ id: 1, number: 1, answer: 3, choices: 5, score: 10, explanation: "정답은 3번" }],
        });
        expect("explanation" in solvable.questions[0]).toBe(false);
        expect(JSON.stringify(solvable)).not.toContain("정답은 3번");
    });

    it("strips teacher-only sub-question guidance from solve payload", () => {
        const solvable = stripExamForSolving({
            ...EXAM,
            questions: [{ id: 1, number: 1, answer: 3, subQuestions: [{
                schemaVersion: 1,
                id: "reason",
                prompt: "왜 골랐나요?",
                kind: "free_text",
                answerGuide: "정답 근거",
                teacherNote: "교사용 메모",
            }] }],
        });
        expect(solvable.questions[0].subQuestions?.[0]).toMatchObject({ prompt: "왜 골랐나요?" });
        expect(JSON.stringify(solvable)).not.toContain("정답 근거");
        expect(JSON.stringify(solvable)).not.toContain("교사용 메모");
    });
});

describe("stripExamForReview", () => {
    it("keeps answers and explanations for the post-submit review", () => {
        const reviewable = stripExamForReview({
            ...EXAM,
            questions: [{ id: 1, number: 1, answer: 3, choices: 5, score: 10, explanation: "정답은 3번" }],
        });
        expect(reviewable.questions[0]).toMatchObject({ answer: 3, explanation: "정답은 3번" });
    });

    it("still withholds the inline PIN and the answer-key PDF", () => {
        const reviewable = stripExamForReview(EXAM);
        expect(reviewable.answerKeyPdf).toBeUndefined();
        expect(reviewable.answerKeyPdfRef).toBeUndefined();
        expect(reviewable.accessConfig).toEqual({ type: "public", hasPin: true });
        expect(JSON.stringify(reviewable)).not.toContain("1234");
    });

    it("keeps the problem PDF payload so review can render it", () => {
        const reviewable = stripExamForReview({ ...EXAM, pdfData: "data:application/pdf;base64,BBBB" });
        expect(reviewable.pdfData).toBe("data:application/pdf;base64,BBBB");
    });

    it("keeps student prompts but strips teacher-only guidance from review payload", () => {
        const reviewable = stripExamForReview({
            ...EXAM,
            questions: [{ id: 1, number: 1, answer: 3, subQuestions: [{
                schemaVersion: 1,
                id: "reason",
                prompt: "왜 골랐나요?",
                kind: "free_text",
                answerGuide: "정답 근거",
            }] }],
        });
        expect(reviewable.questions[0].subQuestions?.[0].prompt).toBe("왜 골랐나요?");
        expect(JSON.stringify(reviewable)).not.toContain("정답 근거");
    });
});

describe("stripExamForAttemptReview", () => {
    it("reveals answers only for questions issued in the completed attempt", () => {
        const attempt = {
            id: "attempt-1",
            examId: EXAM.id,
            examTitle: EXAM.title,
            studentName: "학생",
            startedAt: "2026-07-01T00:00:00.000Z",
            finishedAt: "2026-07-01T01:00:00.000Z",
            score: 10,
            totalScore: 10,
            answers: { 1: 3 },
            status: "completed",
            questionResults: [{
                schemaVersion: 1,
                attemptId: "attempt-1",
                examId: EXAM.id,
                examTitle: EXAM.title,
                studentName: "학생",
                questionId: 1,
                questionNumber: 1,
                score: 10,
                earnedScore: 10,
                selectedAnswer: 3,
                correctAnswer: 3,
                status: "correct",
                isCorrect: true,
                isWrong: false,
                isUnanswered: false,
                finishedAt: "2026-07-01T01:00:00.000Z",
            }],
        } as Attempt;

        const reviewable = stripExamForAttemptReview(EXAM, attempt);

        expect(reviewable.questions.map(question => question.id)).toEqual([1]);
        expect(JSON.stringify(reviewable)).not.toContain('"id":2');
    });
});


describe("student DTO teacher-material boundary", () => {
    it.each([
        { status: "draft" as const, handwritingArchive: false },
        { status: "draft" as const, handwritingArchive: true },
        { status: "reviewed" as const, handwritingArchive: false },
        { status: "reviewed" as const, handwritingArchive: true },
    ])("keeps persisted $status analysis private with handwritingArchive=$handwritingArchive", ({ status, handwritingArchive }) => {
        const canonical: Exam = {
            ...EXAM,
            revision: 4,
            durationMin: 80,
            pdfDataRef: { store: "remote", key: "problem-asset", organizationId: "org-1", kind: "problem_pdf", examId: EXAM.id },
            questions: [{
                ...EXAM.questions[0],
                label: "공통 1", explanation: "Student review explanation",
                pdfLocation: { page: 2, x: 0.1, y: 0.2 },
                pdfRegion: { page: 2, x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
                passagePdfRegions: [{ page: 1, x: 0.1, y: 0.1, width: 0.8, height: 0.4 }],
                contentAnalysis: {
                    status, concepts: ["PRIVATE_CONCEPT"],
                    trapPoints: ["PRIVATE_ANSWER_HINT"], summary: "PRIVATE_TEACHER_SUMMARY",
                    appliedTags: { unit: "PRIVATE_ANALYSIS_UNIT", skill: "PRIVATE_ANALYSIS_SKILL" },
                },
                subQuestions: [{ schemaVersion: 1, id: "reason", kind: "free_text", prompt: "Explain your reasoning", required: true, maxLength: 250, answerGuide: "PRIVATE_GUIDE", teacherNote: "PRIVATE_NOTE" }],
            }],
        };
        // Exercise the canonical JSON persistence boundary, not a cast-only DTO.
        const restored = examFromSupabaseRow(JSON.parse(JSON.stringify(examToSupabaseRow(canonical))));
        expect(restored.questions[0].contentAnalysis).toEqual(canonical.questions[0].contentAnalysis);
        const solve = stripExamForSolving(restored, { handwritingArchive });
        const review = stripExamForReview(restored);
        for (const payload of [solve, review]) {
            expect(JSON.stringify(payload)).not.toContain("PRIVATE_");
            expect(payload.questions[0]).not.toHaveProperty("contentAnalysis");
            expect(payload).toMatchObject({ revision: 4, durationMin: 80, pdfDataRef: canonical.pdfDataRef });
            expect(payload.questions[0]).toMatchObject({
                id: 1, number: 1, score: 10, choices: 5,
                pdfLocation: canonical.questions[0].pdfLocation,
                pdfRegion: canonical.questions[0].pdfRegion,
                passagePdfRegions: canonical.questions[0].passagePdfRegions,
                subQuestions: [{ id: "reason", prompt: "Explain your reasoning", required: true, maxLength: 250 }],
            });
        }
        expect(solve.premiumCapabilities).toEqual({ handwritingArchive });
        expect(solve.questions[0]).not.toHaveProperty("answer");
        expect(solve.questions[0]).not.toHaveProperty("explanation");
        expect(review.questions[0]).toMatchObject({ answer: 3, explanation: "Student review explanation", label: "공통 1" });
        expect(restored.questions[0].contentAnalysis?.summary).toBe("PRIVATE_TEACHER_SUMMARY");
    });

    it("does not automatically publish new teacher fields at any DTO level", () => {
        const canonical = {
            ...EXAM,
            authoringSettings: { targetTotalScore: 100, pdfPageRange: "1-2" },
            futureTeacherField: "PRIVATE_EXAM_FIELD",
            questions: [{
                ...EXAM.questions[0], futureTeacherField: "PRIVATE_QUESTION_FIELD",
                pdfLocation: { page: 1, x: 0.1, y: 0.2, futureTeacherField: "PRIVATE_LOCATION_FIELD" },
                subQuestions: [{ schemaVersion: 1 as const, kind: "free_text" as const, id: "reason", prompt: "Reason", futureTeacherField: "PRIVATE_SUBQUESTION_FIELD" }],
            }],
        };
        for (const project of [stripExamForSolving, stripExamForReview]) {
            const payload = project(canonical);
            expect(payload).not.toHaveProperty("authoringSettings");
            expect(JSON.stringify(payload)).not.toContain("PRIVATE_");
        }
    });
});


it("keeps teacher diagnostics private and reveals only rendered review chips after submission", () => {
    const canonical: Exam = {
        ...EXAM, organizationId: "PRIVATE_ORG", classId: "PRIVATE_CLASS", createdByUserId: "PRIVATE_CREATOR",
        accessConfig: { type: "group", groupIds: ["PRIVATE_GROUP"] },
        questions: [{ ...EXAM.questions[0], label: "Review label", tags: {
            concept: "Review concept", source: "Review source", unit: "PRIVATE_UNIT", skill: "PRIVATE_SKILL",
            mistakeTypes: ["PRIVATE_ANSWER_HINT"], prerequisites: ["PRIVATE_HINT"],
        }, imageAssetRef: { store: "remote", key: "PRIVATE_QUESTION_BANK_ASSET" } }],
    };
    const solve = stripExamForSolving(canonical);
    const review = stripExamForReview(canonical);
    for (const payload of [solve, review]) {
        expect(JSON.stringify(payload)).not.toContain("PRIVATE_");
        expect(payload).not.toHaveProperty("classId");
        expect(payload).not.toHaveProperty("createdByUserId");
        expect(payload).not.toHaveProperty("organizationId");
        expect(payload.accessConfig).toEqual({ type: "group", hasPin: false });
    }
    expect(solve.questions[0]).not.toHaveProperty("label");
    expect(solve.questions[0]).not.toHaveProperty("tags");
    expect(review.questions[0]).toMatchObject({ label: "Review label", tags: { concept: "Review concept", source: "Review source" } });
});


describe("attempt review scope validation", () => {
    const attemptWithIds = (questionIds: number[]) => ({
        questionResults: questionIds.map(questionId => ({ questionId })),
    }) as Attempt;

    it.each([NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 99])("never unlocks all answers for a nonempty invalid or unmatched result id %s", questionId => {
        expect(stripExamForAttemptReview(EXAM, attemptWithIds([questionId])).questions).toEqual([]);
    });

    it("supports persisted zero-based question IDs while retaining the issued scope", () => {
        const canonical = examFromSupabaseRow(examToSupabaseRow({
            ...EXAM, questions: [{ ...EXAM.questions[0], id: 0 }, EXAM.questions[1]],
        }));
        expect(stripExamForAttemptReview(canonical, attemptWithIds([0, NaN])).questions.map(question => question.id)).toEqual([0]);
    });

    it("retains legacy review only when no results were recorded", () => {
        expect(stripExamForAttemptReview(EXAM, {} as Attempt).questions).toHaveLength(2);
        expect(stripExamForAttemptReview(EXAM, attemptWithIds([])).questions).toHaveLength(2);
    });
});

it("preserves local grading/analytics metadata while removing only private analysis and sub-question notes", () => {
    const local: Exam = {
        ...EXAM, organizationId: "local-org", classId: "local-class",
        questions: [{ ...EXAM.questions[0], label: "Local label", explanation: "Local explanation", tags: {
            unit: "Local unit", skill: "Local skill", concept: "Local concept", mistakeTypes: ["Local mistake"], prerequisites: ["Local prerequisite"],
        }, contentAnalysis: { status: "draft", concepts: ["PRIVATE_ANALYSIS"], trapPoints: [], summary: "PRIVATE_ANALYSIS" },
        subQuestions: [{ schemaVersion: 1, id: "reason", kind: "free_text", prompt: "Local prompt", required: true, answerGuide: "PRIVATE_GUIDE", teacherNote: "PRIVATE_NOTE" }],
        }],
    };
    const scrubbed = stripTeacherOnlySubQuestionFields(local);
    expect(scrubbed).toMatchObject({ organizationId: local.organizationId, classId: local.classId, accessConfig: local.accessConfig, answerKeyPdf: local.answerKeyPdf });
    expect(scrubbed.questions[0]).toMatchObject({ answer: 3, explanation: "Local explanation", label: "Local label", tags: local.questions[0].tags });
    expect(scrubbed.questions[0].subQuestions).toEqual([{ schemaVersion: 1, id: "reason", kind: "free_text", prompt: "Local prompt", required: true }]);
    expect(JSON.stringify(scrubbed)).not.toContain("PRIVATE_");
    expect(local.questions[0].contentAnalysis).toBeDefined();
    expect(local.questions[0].subQuestions?.[0].teacherNote).toBe("PRIVATE_NOTE");
});
