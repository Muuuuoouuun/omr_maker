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
            new Set(["visible-exam"]),
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
});
