import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    list: vi.fn(),
    cache: vi.fn(),
    legacyList: vi.fn(),
}));

vi.mock("@/app/actions/feedback", () => ({
    listStudentCanonicalFeedback: mocks.list,
    loadStudentCanonicalFeedback: vi.fn(),
    markStudentCanonicalFeedbackOpened: vi.fn(),
}));

vi.mock("@/lib/feedbackClientCache", () => ({
    cacheFeedbackEnvelope: mocks.cache,
}));

vi.mock("@/lib/feedbackPersistence", () => ({
    loadReturnedAttemptFeedbackForStudent: vi.fn(),
    loadReturnedFeedbackForStudent: mocks.legacyList,
    markFeedbackOpenedForStudent: vi.fn(),
}));

import { loadStudentReturnedFeedbackWithDevFallback } from "./studentFeedbackClient";

describe("student feedback list client", () => {
    beforeEach(() => {
        mocks.list.mockReset();
        mocks.cache.mockReset();
        mocks.legacyList.mockReset();
    });

    it("surfaces the stable capacity state without caching or silently truncating summaries", async () => {
        mocks.list.mockResolvedValue({ status: "service_unavailable", error: "initial_capacity_exceeded" });

        await expect(loadStudentReturnedFeedbackWithDevFallback("student-1")).resolves.toEqual({
            status: "capacity_exceeded",
            items: [],
        });
        expect(mocks.cache).not.toHaveBeenCalled();
        expect(mocks.legacyList).not.toHaveBeenCalled();
    });

    it("returns server summaries without writing redacted list rows over detail cache", async () => {
        const feedback = { id: "feedback-1", attemptId: "attempt-1" };
        mocks.list.mockResolvedValue({ status: "loaded", items: [{ feedback }] });

        await expect(loadStudentReturnedFeedbackWithDevFallback("student-1")).resolves.toEqual({
            status: "loaded",
            items: [feedback],
        });
        expect(mocks.cache).not.toHaveBeenCalled();
    });

    it("does not disguise an expired server session as an empty feedback inbox", async () => {
        mocks.list.mockResolvedValue({ status: "unauthorized" });

        await expect(loadStudentReturnedFeedbackWithDevFallback("student-1")).resolves.toEqual({
            status: "unauthorized",
            items: [],
        });
        expect(mocks.legacyList).not.toHaveBeenCalled();
    });

    it("does not disguise a feedback service outage as an empty feedback inbox", async () => {
        mocks.list.mockResolvedValue({
            status: "service_unavailable",
            error: "피드백 목록을 불러올 수 없습니다.",
        });

        await expect(loadStudentReturnedFeedbackWithDevFallback("student-1")).resolves.toEqual({
            status: "service_unavailable",
            items: [],
            error: "피드백 목록을 불러올 수 없습니다.",
        });
        expect(mocks.legacyList).not.toHaveBeenCalled();
    });
});
