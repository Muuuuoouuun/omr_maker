import { describe, expect, it } from "vitest";
import { rewriteGuestClaimAttemptPayload } from "./studentGuestClaimPayload";

describe("guest claim payload semantics", () => {
    it("rewrites every nested question-result owner without dropping sibling fields", () => {
        const payload = {
            id: "attempt-1",
            guestId: "guest-1",
            studentId: "guest:guest-1",
            custom: { preserved: true },
            questionResults: [
                { questionId: 1, studentId: "guest:guest-1", status: "wrong", analytics: { skill: "fraction" } },
                { questionId: 2, studentId: "guest:guest-1", status: "correct" },
            ],
        };

        expect(rewriteGuestClaimAttemptPayload(payload, {
            guestId: "guest-1",
            studentId: "student-1",
            studentName: "김학생",
            classId: "class-1",
            groupName: "1반",
            mergedAt: "2026-07-28T00:00:00.000Z",
        })).toEqual({
            id: "attempt-1",
            studentId: "student-1",
            studentProfileId: "student-1",
            studentName: "김학생",
            classId: "class-1",
            groupId: "class-1",
            groupName: "1반",
            identityType: "temporary",
            mergedFromGuestId: "guest-1",
            mergedAt: "2026-07-28T00:00:00.000Z",
            custom: { preserved: true },
            questionResults: [
                { questionId: 1, studentId: "student-1", studentProfileId: "student-1", studentName: "김학생", groupId: "class-1", groupName: "1반", identityType: "temporary", status: "wrong", analytics: { skill: "fraction" } },
                { questionId: 2, studentId: "student-1", studentProfileId: "student-1", studentName: "김학생", groupId: "class-1", groupName: "1반", identityType: "temporary", status: "correct" },
            ],
        });
    });
});
