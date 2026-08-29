import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSignedStudentSessionCookie } from "./studentServerSession";
import { INITIAL_OPERATIONS_LIMITS } from "./initialOperationsPolicy";
import {
    canonicalFixtureAuthoritativeExam,
    canonicalFixtureFetchUpstream,
    canonicalFixtureRosterSaveArguments,
    canonicalFixtureRosterSaveTransition,
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

    it("decodes the roster CAS revision and rejects a stale mutation without advancing state", () => {
        const snapshot = {
            students: [],
            groups: [{ id: "group-1", name: "A반", region: "서울" }],
            invites: [],
        };
        const raw = `0:${JSON.stringify([snapshot, 7])}`;

        expect(canonicalFixtureRosterSaveArguments(raw)).toEqual({ snapshot, expectedRevision: 7 });
        expect(canonicalFixtureRosterSaveTransition(raw, 8)).toEqual({
            status: "conflict",
            error: "roster revision conflict",
        });
        expect(canonicalFixtureRosterSaveTransition(raw, 7)).toEqual({
            status: "saved",
            snapshot,
            revision: 8,
        });
    });

    it("accepts the exact initial-operations roster envelope and rejects every one-row overflow", () => {
        const snapshot = {
            students: Array.from({ length: INITIAL_OPERATIONS_LIMITS.students }, (_, index) => ({ id: `student-${index}` })),
            groups: Array.from({ length: INITIAL_OPERATIONS_LIMITS.classes }, (_, index) => ({ id: `group-${index}` })),
            invites: Array.from({ length: INITIAL_OPERATIONS_LIMITS.invites }, (_, index) => ({ id: `invite-${index}` })),
        };
        const transition = (candidate: typeof snapshot) => canonicalFixtureRosterSaveTransition(
            `0:${JSON.stringify([candidate, 1])}`,
            1,
        );

        expect(transition(snapshot)).toMatchObject({ status: "saved", revision: 2 });
        for (const overflow of [
            { ...snapshot, students: [...snapshot.students, { id: "student-overflow" }] },
            { ...snapshot, groups: [...snapshot.groups, { id: "group-overflow" }] },
            { ...snapshot, invites: [...snapshot.invites, { id: "invite-overflow" }] },
        ]) {
            expect(() => transition(overflow)).toThrow(/bounded test contract/);
        }
    });

    it("only rewrites explicit local-only fallbacks and records rewrites after fulfill succeeds", () => {
        const fixture = readFileSync(fixturePath, "utf8");

        expect(fixture).not.toContain('["local_only", "service_unavailable"]');
        expect(fixture.indexOf("await route.fulfill({ response, body: rewritten });"))
            .toBeLessThan(fixture.indexOf("rewrittenActionIds.add(actionId!);"));
    });

    it("never promotes a generic submit error into an authoritative created-exam success", () => {
        const fixture = readFileSync(fixturePath, "utf8");
        const journey = readFileSync(journeyPath, "utf8");

        expect(fixture).not.toContain("expectedUpstreamStatus");
        expect(journey).not.toContain('activateStudentSubmission(createdExam, "app/page", "error")');
        expect(journey).toContain("scopedExamDraftStorageKey");
    });

    it("retries one connection reset only for explicitly read-only upstream actions", async () => {
        const reset = Object.assign(new Error("route.fetch: read ECONNRESET"), { code: "ECONNRESET" });
        let readCalls = 0;
        await expect(canonicalFixtureFetchUpstream(async () => {
            readCalls += 1;
            if (readCalls === 1) throw reset;
            return "loaded";
        }, true)).resolves.toBe("loaded");
        expect(readCalls).toBe(2);

        let mutationCalls = 0;
        await expect(canonicalFixtureFetchUpstream(async () => {
            mutationCalls += 1;
            throw reset;
        }, false)).rejects.toThrow(/ECONNRESET/);
        expect(mutationCalls).toBe(1);

        let permanentCalls = 0;
        await expect(canonicalFixtureFetchUpstream(async () => {
            permanentCalls += 1;
            throw permanentCalls === 1 ? reset : new Error("second failure");
        }, true)).rejects.toThrow(/second failure/);
        expect(permanentCalls).toBe(2);

        let contractCalls = 0;
        await expect(canonicalFixtureFetchUpstream(async () => {
            contractCalls += 1;
            throw new Error("malformed upstream contract");
        }, true)).rejects.toThrow(/malformed upstream contract/);
        expect(contractCalls).toBe(1);
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
