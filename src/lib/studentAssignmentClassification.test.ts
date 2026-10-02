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
        visibleAssignmentScopes: ReadonlySet<string>,
        attempts: readonly StudentAttemptSummary[],
    ) => Array<{
        id: string;
        title: string;
        lifecycle: "closed";
        reviewOnly: true;
        attemptId: string;
    }>;
    assignmentAttemptScopeKey?: (assignment: {
        id: string;
        assignmentId?: string;
        assignmentMode?: "base" | "retake";
        retakeSourceAttemptId?: string;
        assignmentRevision?: number;
    }) => string;
    findInProgressAttemptForAssignment?: (
        assignment: {
            id: string;
            assignmentId?: string;
            assignmentMode?: "base" | "retake";
            retakeSourceAttemptId?: string;
            assignmentRevision?: number;
        },
        attempts: StudentAttemptSummary[],
    ) => StudentAttemptSummary | undefined;
    findCompletedAttemptForAssignment?: Subject["findInProgressAttemptForAssignment"];
    studentAssignmentDraftStorageKey?: (
        examId: string,
        ownerKey: string,
        assignment: { assignmentId?: string; assignmentRevision?: number },
        retakeSegment: string,
    ) => string | null;
    migrateLegacyStudentDraftStorage?: (
        storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
        input: {
            canonicalKey: string;
            legacySegmentedKey: string;
        },
    ) => { status: "none" | "canonical" | "recovery_required"; value?: string };
    buildLegacyStudentDraftRecoveryExport?: (
        storage: Pick<Storage, "getItem">,
        input: { legacySegmentedKey: string; examId: string },
    ) => { status: "none" | "invalid" } | { status: "available"; fileName: string; json: string };
    isCurrentLegacyStudentDraftRecovery?: (
        binding: { ownerStudentId: string; sessionGeneration: string; sharedIdentityEpoch: string; examId: string },
        current: { studentId?: string } | null,
        currentGeneration: string,
        currentSharedIdentityEpoch: string,
        currentExamId: string,
    ) => boolean;
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

type GenerationAttemptSummary = StudentAttemptSummary & { assignmentRevision?: number };

function attempt(overrides: Partial<GenerationAttemptSummary> = {}): GenerationAttemptSummary {
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
            new Set(["exam:visible-exam:base", "retake:retake"]),
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

    it("continues only an in-progress attempt in the displayed exact assignment scope", async () => {
        const classification = await subject();
        expect(classification.findInProgressAttemptForAssignment).toBeTypeOf("function");
        const displayed = {
            id: "exam-1", assignmentId: "assignment-reused", assignmentRevision: 8, assignmentMode: "base" as const,
        };
        const exact = attempt({
            id: "progress-exact",
            status: "in_progress",
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
            startedAt: "2026-08-09T11:00:00.000Z",
        });
        const otherAssignment = attempt({
            id: "progress-other",
            status: "in_progress",
            assignmentId: "assignment-reused",
            assignmentRevision: 7,
            startedAt: "2026-08-09T11:30:00.000Z",
        });
        const unscopedSameExam = attempt({
            id: "progress-unscoped",
            status: "in_progress",
            assignmentId: undefined,
            startedAt: "2026-08-09T11:45:00.000Z",
        });

        expect(classification.findInProgressAttemptForAssignment?.(
            displayed,
            [otherAssignment, unscopedSameExam, exact],
        )?.id).toBe("progress-exact");
        expect(classification.findInProgressAttemptForAssignment?.(
            { ...displayed, assignmentRevision: 9 },
            [otherAssignment, unscopedSameExam, exact],
        )).toBeUndefined();
    });

    it("keeps an older same-exam assignment completion as review-only beside a new assignment", async () => {
        const classification = await subject();
        expect(classification.assignmentAttemptScopeKey).toBeTypeOf("function");
        const current = {
            id: "exam-1", assignmentId: "assignment-reused", assignmentRevision: 8, assignmentMode: "base" as const,
        };
        const currentScope = classification.assignmentAttemptScopeKey?.(current);
        expect(currentScope).toBe("assignment:assignment-reused:revision:8");

        const rows = classification.buildMissingCompletedReviewAssignments?.(
            new Set([currentScope!]),
            [attempt({
                id: "attempt-old-complete",
                assignmentId: "assignment-reused",
                assignmentRevision: 7,
                finishedAt: "2026-08-09T11:30:00.000Z",
            })],
        );

        expect(rows).toEqual([expect.objectContaining({
            id: "attempt-old-complete",
            reviewOnly: true,
            attemptId: "attempt-old-complete",
        })]);
    });

    it("separates reused assignment ids by immutable revision and keeps legacy completions review-only", async () => {
        const classification = await subject();
        const current = {
            id: "exam-1",
            assignmentId: "assignment_targeted_reused",
            assignmentRevision: 8,
            assignmentMode: "base" as const,
        };
        const oldCompleted = attempt({
            id: "attempt-revision-7",
            assignmentId: current.assignmentId,
            assignmentRevision: 7,
            finishedAt: "2026-08-09T10:00:00.000Z",
        });
        const oldProgress = attempt({
            id: "progress-revision-7",
            status: "in_progress",
            assignmentId: current.assignmentId,
            assignmentRevision: 7,
            startedAt: "2026-08-09T11:00:00.000Z",
        });
        const legacyCompleted = attempt({
            id: "attempt-legacy-generation",
            assignmentId: current.assignmentId,
            assignmentRevision: undefined,
            finishedAt: "2026-08-09T09:00:00.000Z",
        });

        expect(classification.assignmentAttemptScopeKey?.(current))
            .toBe("assignment:assignment_targeted_reused:revision:8");
        expect(classification.findCompletedAttemptForAssignment?.(current, [oldCompleted, legacyCompleted]))
            .toBeUndefined();
        expect(classification.findInProgressAttemptForAssignment?.(current, [oldProgress]))
            .toBeUndefined();
        expect(classification.buildMissingCompletedReviewAssignments?.(
            new Set([classification.assignmentAttemptScopeKey?.(current) || ""]),
            [oldCompleted, legacyCompleted],
        )).toEqual([
            expect.objectContaining({ id: "attempt-revision-7", attemptId: "attempt-revision-7", reviewOnly: true }),
            expect.objectContaining({ id: "attempt-legacy-generation", attemptId: "attempt-legacy-generation", reviewOnly: true }),
        ]);
    });

    it("uses exact assignment generation in targeted draft keys and rejects legacy unscoped targeted keys", async () => {
        const classification = await subject();
        expect(classification.studentAssignmentDraftStorageKey).toBeTypeOf("function");
        expect(classification.studentAssignmentDraftStorageKey?.(
            "exam-1",
            "student-1",
            { assignmentId: "assignment_targeted_reused", assignmentRevision: 8 },
            "base",
        )).toMatch(/^omr_draft:v2:/);
        expect(classification.studentAssignmentDraftStorageKey?.(
            "exam-1",
            "student-1",
            { assignmentId: "assignment_targeted_reused" },
            "base",
        )).toBeNull();
        expect(classification.studentAssignmentDraftStorageKey?.(
            "exam-1", "student-1", {}, "base",
        )).toMatch(/^omr_draft:v2:/);
    });

    it("encodes the exact tuple without delimiter collisions", async () => {
        const classification = await subject();
        const left = classification.studentAssignmentDraftStorageKey?.(
            "exam:one", "student/two",
            { assignmentId: "assignment:three", assignmentRevision: 8 },
            "base:four",
        );
        const right = classification.studentAssignmentDraftStorageKey?.(
            "exam", "one:student",
            { assignmentId: "two:assignment", assignmentRevision: 8 },
            "three:base:four",
        );
        expect(left).toMatch(/^omr_draft:v2:/);
        expect(left).not.toBe(right);
    });

    it("quarantines an origin-ambiguous segmented draft and exports bounded answers plus local drawings metadata", async () => {
        const classification = await subject();
        const data = new Map<string, string>();
        const legacyKey = "omr_draft_exam-1_student-1_base";
        const canonicalKey = classification.studentAssignmentDraftStorageKey?.("exam-1", "student-1", {}, "base") || "";
        data.set(legacyKey, JSON.stringify({
            answers: { 1: 2 }, subQuestionAnswers: {},
            drawingsRef: { store: "indexeddb", key: "draft-drawings-1" },
            timeRemaining: 300, startedAt: "2026-08-09T10:00:00.000Z",
            submissionId: "00000000-0000-4000-8000-000000000001", savedAt: "2026-08-09T10:01:00.000Z",
        }));
        const storage = {
            getItem: (key: string) => data.get(key) ?? null,
            setItem: (key: string, value: string) => { data.set(key, value); },
            removeItem: (key: string) => { data.delete(key); },
        };
        const result = classification.migrateLegacyStudentDraftStorage?.(storage, {
            canonicalKey,
            legacySegmentedKey: legacyKey,
        });
        expect(result).toEqual({ status: "recovery_required" });
        expect(data.has(legacyKey)).toBe(true);
        expect(data.has(canonicalKey)).toBe(false);
        const recovery = classification.buildLegacyStudentDraftRecoveryExport?.(storage, {
            legacySegmentedKey: legacyKey,
            examId: "exam-1",
        });
        expect(recovery).toMatchObject({ status: "available", fileName: "omr-draft-recovery-exam-1.json" });
        expect(JSON.parse(recovery?.status === "available" ? recovery.json : "{}")).toEqual({
            schemaVersion: 1,
            kind: "legacy_student_draft_recovery",
            examId: "exam-1",
            answers: { 1: 2 },
            subQuestionAnswers: {},
            drawingsRef: { store: "indexeddb", key: "draft-drawings-1" },
            timeRemaining: 300,
            startedAt: "2026-08-09T10:00:00.000Z",
            submissionId: "00000000-0000-4000-8000-000000000001",
            savedAt: "2026-08-09T10:01:00.000Z",
        });
    });

    it("never replays an origin-ambiguous targeted draft after the exam becomes public", async () => {
        const classification = await subject();
        const legacyKey = "omr_draft_exam-1_student-1_base";
        const canonicalKey = classification.studentAssignmentDraftStorageKey?.("exam-1", "student-1", {}, "base") || "";
        const raw = JSON.stringify({
            answers: { 1: 4 },
            subQuestionAnswers: {},
            drawingsRef: { store: "indexeddb", key: "targeted-drawings-must-stay-quarantined" },
            submissionId: "submission-from-targeted-generation",
        });
        const data = new Map([[legacyKey, raw]]);
        const storage = {
            getItem: (key: string) => data.get(key) ?? null,
            setItem: (key: string, value: string) => { data.set(key, value); },
            removeItem: (key: string) => { data.delete(key); },
        };

        expect(classification.migrateLegacyStudentDraftStorage?.(storage, {
            canonicalKey,
            legacySegmentedKey: legacyKey,
        })).toEqual({ status: "recovery_required" });
        expect(data.get(legacyKey)).toBe(raw);
        expect(data.has(canonicalKey)).toBe(false);
        expect(classification.buildLegacyStudentDraftRecoveryExport?.(storage, {
            legacySegmentedKey: legacyKey,
            examId: "exam-1",
        })).toMatchObject({ status: "available" });
    });

    it("rejects unsafe or overbound recovery exports without deleting the retained draft", async () => {
        const classification = await subject();
        const legacyKey = "omr_draft_exam-1_student-1_base";
        const raw = JSON.stringify({
            answers: { 1: 2 },
            subQuestionAnswers: {},
            drawingsRef: { store: "remote", key: "retain-me", url: "https://secret.invalid", token: "secret" },
        });
        const data = new Map([[legacyKey, raw]]);
        const storage = {
            getItem: (key: string) => data.get(key) ?? null,
            setItem: (key: string, value: string) => { data.set(key, value); },
            removeItem: (key: string) => { data.delete(key); },
        };
        expect(classification.migrateLegacyStudentDraftStorage?.(storage, {
            canonicalKey: "omr_draft:v2:public",
            legacySegmentedKey: legacyKey,
        })).toEqual({ status: "recovery_required" });
        expect(data.get(legacyKey)).toBe(raw);
        expect(classification.buildLegacyStudentDraftRecoveryExport?.(storage, {
            legacySegmentedKey: legacyKey,
            examId: "exam-1",
        })).toEqual({ status: "invalid" });
        expect(data.get(legacyKey)).toBe(raw);
    });

    it("rejects a recovery export whose final serialized output exceeds the exact 512 KiB cap", async () => {
        const classification = await subject();
        const legacyKey = "legacy-max";
        const makeRaw = (bodyLength: number) => JSON.stringify({
            answers: {},
            subQuestionAnswers: { 1: { essay: { body: "x".repeat(bodyLength) } } },
        });
        let bodyLength = 512 * 1024;
        while (new TextEncoder().encode(makeRaw(bodyLength)).byteLength > 512 * 1024) bodyLength -= 1;
        const raw = makeRaw(bodyLength);
        expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(512 * 1024);
        const storage = { getItem: (key: string) => key === legacyKey ? raw : null };
        expect(classification.buildLegacyStudentDraftRecoveryExport?.(storage, {
            legacySegmentedKey: legacyKey,
            examId: "exam-1",
        })).toEqual({ status: "invalid" });
    });

    it("uses monotonic session generation so an A to B to A identity cycle cannot reuse A's export", async () => {
        const classification = await subject();
        const binding = {
            ownerStudentId: "student-a",
            sessionGeneration: "generation-a-1",
            sharedIdentityEpoch: "shared-a-1",
            examId: "exam-a",
        };
        expect(classification.isCurrentLegacyStudentDraftRecovery?.(
            binding,
            { studentId: "student-a" },
            "generation-a-1",
            "shared-a-1",
            "exam-a",
        )).toBe(true);
        expect(classification.isCurrentLegacyStudentDraftRecovery?.(
            binding,
            { studentId: "student-b" },
            "generation-b",
            "shared-b",
            "exam-a",
        )).toBe(false);
        expect(classification.isCurrentLegacyStudentDraftRecovery?.(
            binding,
            { studentId: "student-a" },
            "generation-a-2",
            "shared-a-2",
            "exam-a",
        )).toBe(false);
        expect(classification.isCurrentLegacyStudentDraftRecovery?.(
            binding,
            { studentId: "student-a" },
            "generation-a-1",
            "shared-a-1",
            "exam-b",
        )).toBe(false);
        expect(classification.isCurrentLegacyStudentDraftRecovery?.(
            binding,
            { studentId: "student-a" },
            "generation-a-1",
            "shared-b-login-remember-false",
            "exam-a",
        )).toBe(false);
    });

    it("synthesizes distinct review-only cards for omitted completed retakes without duplicating visible exams", async () => {
        const classification = await subject();
        const rows = classification.buildMissingCompletedReviewAssignments?.(
            new Set(["retake:visible-retake-attempt"]),
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
