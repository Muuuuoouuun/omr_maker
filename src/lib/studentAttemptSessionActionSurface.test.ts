import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = () => readFileSync(
    join(process.cwd(), "src/app/actions/studentAttemptSession.ts"),
    "utf8",
);

describe("durable student attempt session actions", () => {
    it("binds open to same-origin signed identity and signed attempt capability", () => {
        const action = source();
        const open = action.slice(
            action.indexOf("export async function openDurableStudentAttemptSession"),
            action.indexOf("export async function checkpointDurableStudentAttemptSession"),
        );
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(open).toContain("sameOriginMutation");
        expect(open).toContain("parseStudentAttemptSessionContext");
        expect(open).toContain("parseStudentAttemptTicket");
        expect(open).toContain("authorizeStudentAttemptSessionScope");
        expect(open).not.toContain("assignmentId: input.assignmentId");
        expect(open).not.toContain("retake: input.retake");
        expect(open).toContain("safeSolveSnapshot");
        expect(open).toContain("gradingSnapshot: _gradingSnapshot");
        expect(action).toContain("stripExamForSolving");
        expect(action).toContain("createStudentProblemPdfSignedUrlWithGateway");
    });

    it("keeps lease tokens server-hashed for every mutation", () => {
        const action = source();
        expect(action).toContain("leaseTokenHash(input.leaseToken, context.secret)");
        expect(action).toContain("checkpointStudentAttemptSessionWithGateway");
        expect(action).toContain("heartbeatStudentAttemptSessionWithGateway");
        expect(action).toContain("takeoverStudentAttemptSessionWithGateway");
        expect(action).toContain("submitStudentAttemptSessionService");
    });
});
