import { describe, expect, it } from "vitest";
import type { Exam } from "@/types/omr";
import type { StudentAttemptSummary } from "./studentExamContract";

type Subject = {
    localStudentAssignmentPreview?: (exam: Exam, now: string) => {
        id: string;
        lifecycle: "scheduled" | "open" | "closed" | "invalid";
        startsAt?: string;
        endsAt?: string;
    };
    buildMissingCompletedReviewAssignments?: (
        visibleExamIds: ReadonlySet<string>,
        attempts: readonly StudentAttemptSummary[],
    ) => Array<{
        id: string;
        title: string;
        lifecycle: "closed";
        reviewOnly: true;
        attemptId: string;
    }>;
};

async function subject(): Promise<Subject> {
    return import("./studentAssignmentClassification") as Promise<Subject>;
}

const now = "2026-08-09T12:00:00.000Z";

function exam(overrides: Partial<Exam> = {}): Exam {
    return {
        id: "exam-1",
        title: "시험",
        createdAt: "2026-08-09T00:00:00.000Z",
        questions: [],
        accessConfig: { type: "public" },
        ...overrides,
    };
}

function attempt(overrides: Partial<StudentAttemptSummary> = {}): StudentAttemptSummary {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "시험",
        status: "completed",
        score: 10,
        totalScore: 10,
        startedAt: "2026-08-09T10:00:00.000Z",
        finishedAt: "2026-08-09T11:00:00.000Z",
        ...overrides,
    };
}

describe("student assignment dashboard classification", () => {
    it.each([
        ["scheduled", exam({ startAt: "2026-08-09T13:00:00.000Z", endAt: "2026-08-09T14:00:00.000Z" })],
        ["open", exam({ startAt: "2026-08-09T11:00:00.000Z", endAt: "2026-08-09T13:00:00.000Z" })],
        ["closed", exam({ startAt: "2026-08-09T10:00:00.000Z", endAt: now })],
        ["closed", exam({ archived: true, endAt: "2026-08-09T13:00:00.000Z" })],
        ["invalid", exam({ startAt: "not-a-time" })],
    ] as const)("derives %s for a local Exam without trusting an injected lifecycle", async (expected, localExam) => {
        const classification = await subject();
        expect(classification.localStudentAssignmentPreview).toBeTypeOf("function");
        expect(classification.localStudentAssignmentPreview?.(localExam, now)).toMatchObject({
            id: localExam.id,
            lifecycle: expected,
        });
    });

    it("maps local startAt and endAt to the canonical preview boundary fields", async () => {
        const classification = await subject();
        expect(classification.localStudentAssignmentPreview?.(exam({
            startAt: "2026-08-09T11:00:00.000Z",
            endAt: "2026-08-09T13:00:00.000Z",
        }), now)).toMatchObject({
            startsAt: "2026-08-09T11:00:00.000Z",
            endsAt: "2026-08-09T13:00:00.000Z",
            lifecycle: "open",
        });
    });

    it("synthesizes one latest review-only closed card for a completed base exam omitted from the server list", async () => {
        const classification = await subject();
        expect(classification.buildMissingCompletedReviewAssignments).toBeTypeOf("function");
        const rows = classification.buildMissingCompletedReviewAssignments?.(
            new Set(["visible-exam", "missing-retake"]),
            [
                attempt({ id: "older", examId: "archived-exam", examTitle: "보관된 시험", finishedAt: "2026-08-09T10:00:00.000Z" }),
                attempt({ id: "latest", examId: "archived-exam", examTitle: "보관된 시험", finishedAt: "2026-08-09T11:00:00.000Z" }),
                attempt({ id: "visible", examId: "visible-exam" }),
                attempt({ id: "retake", examId: "missing-retake", retakeSourceAttemptId: "source" }),
                attempt({ id: "draft", examId: "missing-draft", status: "in_progress" }),
            ],
        );

        expect(rows).toEqual([{
            id: "archived-exam",
            title: "보관된 시험",
            createdAt: "2026-08-09T10:00:00.000Z",
            lifecycle: "closed",
            reviewOnly: true,
            attemptId: "latest",
        }]);
    });

    it("synthesizes distinct review-only cards for omitted completed retakes without duplicating visible exams", async () => {
        const classification = await subject();
        const rows = classification.buildMissingCompletedReviewAssignments?.(
            new Set(["visible-retake-exam"]),
            [
                attempt({
                    id: "retake-attempt-1",
                    examId: "omitted-retake-exam",
                    examTitle: "정확한 재시험 제목 1",
                    retakeSourceAttemptId: "base-attempt",
                    finishedAt: "2026-08-09T10:30:00.000Z",
                }),
                attempt({
                    id: "retake-attempt-2",
                    examId: "omitted-retake-exam",
                    examTitle: "정확한 재시험 제목 2",
                    retakeSourceAttemptId: "base-attempt",
                    finishedAt: "2026-08-09T11:30:00.000Z",
                }),
                attempt({
                    id: "visible-retake-attempt",
                    examId: "visible-retake-exam",
                    examTitle: "이미 시험 행이 있는 재시험",
                    retakeSourceAttemptId: "visible-base-attempt",
                }),
            ],
        );

        expect(rows).toEqual([
            expect.objectContaining({
                id: "retake-attempt-2",
                title: "정확한 재시험 제목 2",
                lifecycle: "closed",
                reviewOnly: true,
                attemptId: "retake-attempt-2",
            }),
            expect.objectContaining({
                id: "retake-attempt-1",
                title: "정확한 재시험 제목 1",
                lifecycle: "closed",
                reviewOnly: true,
                attemptId: "retake-attempt-1",
            }),
        ]);
    });
});
