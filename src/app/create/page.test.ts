import { describe, expect, it } from "vitest";
import {
    examDraftStorageKey,
    isEditDraftNewerThanExam,
    runPdfAssetUploadsConcurrently,
    shouldUploadExamPdf,
} from "./page";

describe("examDraftStorageKey", () => {
    it("uses the shared legacy key for new exams", () => {
        expect(examDraftStorageKey(null)).toBe("omr_exam_draft");
        expect(examDraftStorageKey(undefined)).toBe("omr_exam_draft");
        expect(examDraftStorageKey("")).toBe("omr_exam_draft");
    });

    it("namespaces the key per exam when editing", () => {
        expect(examDraftStorageKey("abc123")).toBe("omr_exam_draft_abc123");
        // Distinct exams never collide with each other or the new-exam draft.
        expect(examDraftStorageKey("abc123")).not.toBe(examDraftStorageKey("def456"));
        expect(examDraftStorageKey("abc123")).not.toBe(examDraftStorageKey(null));
    });
});

describe("isEditDraftNewerThanExam", () => {
    it("offers a draft saved after the last exam save", () => {
        expect(
            isEditDraftNewerThanExam("2026-07-13T10:05:00.000Z", "2026-07-13T10:00:00.000Z"),
        ).toBe(true);
    });

    it("ignores a draft that is same-age or older than the saved exam", () => {
        expect(
            isEditDraftNewerThanExam("2026-07-13T10:00:00.000Z", "2026-07-13T10:00:00.000Z"),
        ).toBe(false);
        expect(
            isEditDraftNewerThanExam("2026-07-13T09:55:00.000Z", "2026-07-13T10:00:00.000Z"),
        ).toBe(false);
    });

    it("treats a missing exam timestamp as epoch so any valid draft wins", () => {
        expect(isEditDraftNewerThanExam("2026-07-13T10:00:00.000Z", undefined)).toBe(true);
    });

    it("rejects a draft with a missing or unparseable savedAt", () => {
        expect(isEditDraftNewerThanExam(undefined, "2026-07-13T10:00:00.000Z")).toBe(false);
        expect(isEditDraftNewerThanExam("not-a-date", "2026-07-13T10:00:00.000Z")).toBe(false);
    });

    it("falls back to epoch when the exam timestamp is unparseable", () => {
        expect(isEditDraftNewerThanExam("2026-07-13T10:00:00.000Z", "garbage")).toBe(true);
    });
});

describe("shouldUploadExamPdf", () => {
    it("does not upload a remote PDF materialized only for preview", () => {
        const previewFile = new File(["remote preview"], "problem.pdf", { type: "application/pdf" });

        expect(shouldUploadExamPdf(previewFile, false)).toBe(false);
    });

    it("uploads a PDF only after the teacher explicitly selects a replacement", () => {
        const replacement = new File(["replacement"], "replacement.pdf", { type: "application/pdf" });

        expect(shouldUploadExamPdf(replacement, true)).toBe(true);
        expect(shouldUploadExamPdf(null, true)).toBe(false);
    });
});

describe("runPdfAssetUploadsConcurrently", () => {
    it("starts problem and answer-key uploads before either one finishes", async () => {
        const events: string[] = [];
        let finishProblem!: () => void;
        let finishAnswer!: () => void;
        const problemGate = new Promise<void>(resolve => { finishProblem = resolve; });
        const answerGate = new Promise<void>(resolve => { finishAnswer = resolve; });

        const pending = runPdfAssetUploadsConcurrently({
            problem: async () => {
                events.push("problem:start");
                await problemGate;
                events.push("problem:finish");
                return "problem-ref";
            },
            answer: async () => {
                events.push("answer:start");
                await answerGate;
                events.push("answer:finish");
                return "answer-ref";
            },
        });

        await Promise.resolve();
        expect(events).toEqual(["problem:start", "answer:start"]);

        finishProblem();
        finishAnswer();
        await expect(pending).resolves.toEqual({
            problem: { status: "uploaded", value: "problem-ref" },
            answer: { status: "uploaded", value: "answer-ref" },
        });
    });

    it("reports each upload outcome independently", async () => {
        const problemError = new Error("problem failed");

        await expect(runPdfAssetUploadsConcurrently({
            problem: async () => { throw problemError; },
            answer: async () => "answer-ref",
        })).resolves.toEqual({
            problem: { status: "failed", error: problemError },
            answer: { status: "uploaded", value: "answer-ref" },
        });
    });

    it("rolls back once after all concurrent uploads settle when either fails", async () => {
        let rollbackCalls = 0;

        const result = await runPdfAssetUploadsConcurrently({
            problem: async () => { throw new Error("problem failed"); },
            answer: async () => { throw new Error("answer failed"); },
            rollback: async () => { rollbackCalls += 1; },
        });

        expect(result.problem.status).toBe("failed");
        expect(result.answer.status).toBe("failed");
        expect(rollbackCalls).toBe(1);
    });
});
