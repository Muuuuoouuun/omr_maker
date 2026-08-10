import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSignedStudentSessionCookie } from "./studentServerSession";
import {
    canonicalFixtureAuthoritativeExam,
    canonicalFixtureStudentIdentity,
    canonicalFixtureUpstreamResult,
} from "../../e2e/fixtures/canonical-remote-fixture";

const fixturePath = path.join(process.cwd(), "e2e/fixtures/canonical-remote-fixture.ts");
const journeyPath = path.join(process.cwd(), "e2e/full-journey.spec.ts");

describe("full journey canonical remote fixture", () => {
    it("owns the exact authoritative transport actions used by create, submit, and analytics", () => {
        expect(existsSync(fixturePath)).toBe(true);
        const fixture = readFileSync(fixturePath, "utf8");

        for (const [file, action] of [
            ["src/app/actions/teacherRoster.ts", "loadTeacherCanonicalRoster"],
            ["src/app/actions/teacherExam.ts", "saveTeacherCanonicalExam"],
            ["src/app/actions/teacherExam.ts", "listTeacherCanonicalExams"],
            ["src/app/actions/teacherAssignment.ts", "saveTeacherIndividualAssignment"],
            ["src/app/actions/studentExam.ts", "submitAttempt"],
            ["src/app/actions/teacherAttempts.ts", "listTeacherCanonicalAttemptSummaries"],
            ["src/app/actions/teacherAttempts.ts", "listTeacherCanonicalAttempts"],
            ["src/app/actions/teacherAttempts.ts", "loadTeacherCanonicalAnalyticsSnapshots"],
        ]) {
            expect(fixture).toContain(`exactNextActionId("${file}", "${action}"`);
        }
        expect(fixture).toContain("revision");
        expect(fixture).toContain("analyticsSnapshots");
    });

    it("does not manufacture teacher analytics from a device-local completed attempt", () => {
        expect(existsSync(fixturePath)).toBe(true);
        const fixture = readFileSync(fixturePath, "utf8");
        const journey = readFileSync(journeyPath, "utf8");

        expect(fixture).not.toContain("localStorage");
        expect(fixture).not.toContain("omr_attempts");
        expect(fixture).not.toContain("buildServerAttempt");
        expect(journey).toContain('from "./fixtures/canonical-remote-fixture"');
        expect(journey).not.toContain("registerCanonicalTeacherDashboardFixtureRoute");
        expect(journey).not.toContain('import { buildServerAttempt } from "../src/lib/studentExamServerGrading"');
    });

    it("fails closed on unauthorized or degraded action results and binds the signed student cookie", () => {
        expect(() => canonicalFixtureUpstreamResult(
            '0:{"status":"unauthenticated"}',
            ["ok"],
        )).toThrow(/unauthenticated/);
        expect(() => canonicalFixtureUpstreamResult(
            '0:{"status":"degraded_local"}',
            ["ok"],
        )).toThrow(/degraded_local/);
        expect(canonicalFixtureUpstreamResult(
            '0:{"status":"ok","attempt":{"id":"attempt-1"}}',
            ["ok"],
        )).toMatchObject({ status: "ok", attempt: { id: "attempt-1" } });

        const env = {
            NODE_ENV: "test",
            STUDENT_SESSION_SECRET: "omr-maker-e2e-student-session-secret-2026",
        };
        const cookie = createSignedStudentSessionCookie({
            kind: "student",
            studentId: "class-a::김학생",
            organizationId: "default",
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
            identityType: "temporary",
        }, env, Date.now());
        expect(cookie).toBeTruthy();
        expect(canonicalFixtureStudentIdentity(`other=x; omr_student_server_session=${cookie}`)).toMatchObject({
            studentId: "class-a::김학생",
            organizationId: "default",
            name: "김학생",
        });
        expect(() => canonicalFixtureStudentIdentity("other=x")).toThrow(/signed student session/);
    });

    it("never promotes a generic submit error into an authoritative created-exam success", () => {
        const fixture = readFileSync(fixturePath, "utf8");
        const journey = readFileSync(journeyPath, "utf8");

        expect(fixture).not.toContain("expectedUpstreamStatus");
        expect(journey).not.toContain('activateStudentSubmission(createdExam, "app/page", "error")');
        expect(journey).toContain("scopedExamDraftStorageKey");
    });

    it("keeps the exam captured by the save action authoritative through submission and analytics", () => {
        const fixture = readFileSync(fixturePath, "utf8");
        const journey = readFileSync(journeyPath, "utf8");

        expect(fixture).toContain("canonical fixture saved exam mismatch");
        expect(fixture).toContain("confirmedExam:");
        expect(journey).toContain("remoteFixture.confirmedExam()");
        expect(journey).not.toContain("activateStudentSubmission(createdExam)");

        const saved = {
            id: "exam-1",
            title: "저장 시험",
            createdAt: "2026-08-10T00:00:00.000Z",
            questions: [{ id: 1, number: 1, answer: 2, score: 5 }],
        };
        expect(canonicalFixtureAuthoritativeExam(saved, saved)).toBe(saved);
        expect(() => canonicalFixtureAuthoritativeExam(saved, {
            ...saved,
            questions: [{ ...saved.questions[0], answer: 3 }],
        })).toThrow(/saved exam mismatch/);
    });

    it("proves durable receipts, exact dashboard actions, and public assignment absence in the journey", () => {
        const journey = readFileSync(journeyPath, "utf8");
        expect(journey).toContain("omr_student_submission_receipt_v2:");
        expect(journey).toContain("dashboardActions.analytics");
        expect(journey).toContain("dashboardActions.attempts");
        expect(journey).toContain("createActions.saveAssignment)).toBe(false)");
    });
});
