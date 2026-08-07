import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    save: vi.fn(),
    returned: vi.fn(),
    load: vi.fn(),
    cache: vi.fn(async () => null),
    legacySave: vi.fn(),
    legacyReturn: vi.fn(),
    legacyLoad: vi.fn(),
}));

vi.mock("@/app/actions/feedback", () => ({
    saveTeacherCanonicalFeedback: mocks.save,
    returnTeacherCanonicalFeedback: mocks.returned,
    loadTeacherCanonicalFeedback: mocks.load,
}));
vi.mock("@/lib/feedbackClientCache", () => ({ cacheFeedbackEnvelope: mocks.cache }));
vi.mock("@/lib/feedbackPersistence", () => ({
    saveAttemptFeedbackDraft: mocks.legacySave,
    returnAttemptFeedback: mocks.legacyReturn,
    loadAttemptFeedback: mocks.legacyLoad,
}));

import {
    returnTeacherAttemptFeedback,
    saveTeacherAttemptFeedbackDraft,
} from "./teacherFeedbackClient";

const draft = {
    id: "feedback:attempt-1",
    attemptId: "attempt-1",
    examId: "exam-1",
    status: "draft",
    revision: 2,
    questionComments: [],
    downloadPolicy: {},
    delivery: {},
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
} as never;

describe("teacher feedback conflict messages", () => {
    beforeEach(() => vi.clearAllMocks());

    it("distinguishes a newer draft from a terminal returned record", async () => {
        mocks.save.mockResolvedValue({ status: "conflict", currentRevision: 3, currentStatus: "draft" });
        mocks.returned.mockResolvedValue({ status: "conflict", currentRevision: 4, currentStatus: "returned" });

        await expect(saveTeacherAttemptFeedbackDraft(draft)).resolves.toMatchObject({
            remoteError: "다른 탭에서 더 최신 초안이 저장되었습니다. 새로고침 후 서버 내용을 비교해 주세요.",
        });
        await expect(returnTeacherAttemptFeedback(draft)).resolves.toMatchObject({
            remoteError: "이미 반환된 피드백은 유지되었습니다. 새로고침 후 서버 내용을 비교해 주세요.",
        });
    });
});
