import { describe, expect, it } from "vitest";
import { examDraftStorageKey, isEditDraftNewerThanExam } from "./page";

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
